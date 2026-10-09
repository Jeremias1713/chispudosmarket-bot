'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./dataDir');
const api = require('./dropanasApi');

const STATE_PATH = path.join(DATA_DIR, 'dropanas-api-state.json');
const MAX_PENDING = 1000;
const MAX_DELIVERIES = 500;
const INBOX_MAX_ATTEMPTS = 5;
const INBOX_RETRY_MS = 5 * 60 * 1000;
// Avisos (llegada a oficina, entregado, etc.) que dropanasAuto no pudo
// confirmar en el primer intento: se reintentan solos, sin duplicar nada
// porque maybeNotify* ya es idempotente ('ya_avisado').
// S2, bug real: antes eran 8 intentos cada 10 minutos (80 minutos en total) y
// despues el pendiente quedaba en la cola sin volver a intentarse nunca,
// aunque el comentario decia 5 dias. Ahora hay backoff hasta los 5 dias.
const PENDING_RETRY_MAX = 30; // red de seguridad; el limite real es la edad
const PENDING_RETRY_MS = 10 * 60 * 1000; // cada cuanto corre el chequeo
const PENDING_BACKOFF_MS = [10, 10, 30, 60, 120, 240, 480].map((m) => m * 60 * 1000);
const PENDING_BACKOFF_LATE_MS = 12 * 60 * 60 * 1000;
const MAX_EXPIRED = 500;
// Motivos que no tiene sentido reintentar: se confirman y salen de la cola.
const NO_RETRY_REASONS = new Set(['ya_finalizado', 'ya_avisado', 'estado_sin_aviso_de_despacho', 'transportista_sin_descarga_automatica', 'cancelado']);
// Un aviso con mas de 5 dias ya no se manda solo ("ya llego" una semana
// tarde confunde mas de lo que ayuda): sale a "vencidos" y el reconciliador
// corrige la etapa en silencio.
const PENDING_RETRY_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

function backoffMs(attempts) {
  return attempts < PENDING_BACKOFF_MS.length ? PENDING_BACKOFF_MS[attempts] : PENDING_BACKOFF_LATE_MS;
}
// Horario en que el bot puede mandar avisos automaticos a clientes (hora de
// Venezuela). Fuera de este horario los avisos quedan en cola y salen solos
// a partir de las 8:00, con el reintento de pendientes.
const NOTIFY_START_HOUR = 8;
const NOTIFY_END_HOUR = 20;

function caracasHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Caracas', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

// S7: antes el horario era fijo (8 a 20). Ahora lee el mismo horario que
// outboundGuard (settings.autoSendHourStart/End), con 8 y 20 por defecto.
function notifyHours() {
  try {
    const settings = require('./settings').getSettings();
    const start = Number(settings.autoSendHourStart ?? NOTIFY_START_HOUR);
    const end = Number(settings.autoSendHourEnd ?? NOTIFY_END_HOUR);
    return {
      start: Number.isFinite(start) ? start : NOTIFY_START_HOUR,
      end: Number.isFinite(end) ? end : NOTIFY_END_HOUR,
    };
  } catch (err) {
    return { start: NOTIFY_START_HOUR, end: NOTIFY_END_HOUR };
  }
}

function isQuietHours(now = new Date()) {
  const hour = caracasHour(now);
  const { start, end } = notifyHours();
  return hour < start || hour >= end;
}
let timer = null;
let inboxTimer = null;
let pendingRetryTimer = null;
const inboxProcessing = new Set();
let running = null;

function blankState() {
  return {
    version: 1,
    baselineAt: null,
    lastSyncAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastWarning: null,
    mode: null,
    snapshots: { orders: {}, novelties: {} },
    pending: [],
    pendingAttempts: {},
    pendingNotes: {},
    deliveries: [],
    // Huellas (sha256) de los cuerpos ya recibidos: un mismo evento reenviado
    // con otro X-DroPanas-Delivery tampoco se procesa dos veces.
    bodyHashes: [],
    // Webhooks recibidos y todavía no procesados con éxito. Se guardan ANTES
    // de responder 200, así un error o un reinicio no los pierde.
    inbox: [],
    lastWebhookAt: null,
  };
}

function loadState() {
  try {
    return { ...blankState(), ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return blankState();
    throw new Error(`No se pudo leer dropanas-api-state.json: ${error.message}`);
  }
}

function saveState(state, deps = {}) {
  const temp = `${STATE_PATH}.tmp`;
  const write = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    (deps.writeFileSync || fs.writeFileSync)(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, STATE_PATH);
  };
  try {
    write();
  } catch (err) {
    if (err.code !== 'ENOSPC') throw err;
    // S7: disco lleno. Mismo patron que state.saveAll: limpieza agresiva y un
    // solo reintento. Si vuelve a fallar se relanza.
    try { fs.unlinkSync(temp); } catch (e) { /* puede no existir */ }
    try {
      const janitor = deps.janitor || require('./diskJanitor');
      janitor.markEnospc();
      janitor.runOnce({ aggressive: true });
    } catch (e) {
      console.error('AVISO: fallo la limpieza de emergencia del disco (DroPanas):', e.message);
    }
    write();
  }
}

// S7: alertas ya enviadas por push (novedad, ambiguo, cancelado, dos pedidos
// abiertos). Antes estaban en memoria y con cada reinicio de Render se
// repetian los pushes. Maximo 1000 por tipo.
const MAX_ALERTED = 1000;

function wasAlerted(kind, id) {
  try {
    return (loadState().alerted?.[kind] || []).includes(String(id));
  } catch (err) {
    return false;
  }
}

function markAlerted(kind, id) {
  try {
    const state = loadState();
    state.alerted = state.alerted || {};
    const list = (state.alerted[kind] || []).filter((x) => x !== String(id));
    list.push(String(id));
    state.alerted[kind] = list.slice(-MAX_ALERTED);
    saveState(state);
  } catch (err) {
    console.error('No se pudo guardar la alerta enviada:', err.message);
  }
}

// S3, bug real: el hash del webhook (una orden armada con campos vacios) casi
// nunca coincidia con el del listado, asi que el polling siempre veia un
// "cambio" falso y re-encolaba el pedido. Ahora el hash usa solo lo que
// importa para avisar: guia, TIPO de estado y telefono normalizado. El mismo
// estado por las dos vias da el mismo hash.
const SNAPSHOT_VERSION = 2;

function orderComparable(order) {
  const { classifyStatus } = require('./dropanasStatus');
  return {
    guia: String(order.guia || '').trim().toUpperCase(),
    kind: classifyStatus(order.estadoPedido).kind,
    telefono: api.normalizePhone(order.telefono) || '',
  };
}

function orderRank(order) {
  const { classifyStatus, statusRank } = require('./dropanasStatus');
  return order ? statusRank(classifyStatus(order.estadoPedido).kind) : 0;
}

// Decide si un evento nuevo del mismo pedido reemplaza al que ya esta en la
// cola. Bug real: el webhook "En oficina" de la noche quedaba en cola hasta
// las 8 y el polling con un listado atrasado ("En transito") lo pisaba: el
// aviso de llegada se perdia. Ahora se conserva el mas avanzado, salvo que el
// nuevo traiga un updatedAt de DroPanas posterior.
function shouldReplace(existingOrder, incomingOrder) {
  const before = orderRank(existingOrder);
  const next = orderRank(incomingOrder);
  if (before === 0) return true;
  const beforeAt = Date.parse(existingOrder?.updatedAt || '');
  const nextAt = Date.parse(incomingOrder?.updatedAt || '');
  if (next > 0 && Number.isFinite(beforeAt) && Number.isFinite(nextAt) && nextAt !== beforeAt) return nextAt > beforeAt;
  return next >= before;
}

// Encola un cambio de pedido respetando shouldReplace. Devuelve false si se
// descarto porque ya habia uno mas avanzado.
function enqueueOrderChange(state, change) {
  const id = String(change.order.dropanasId);
  const existing = (state.pending || []).find((item) => item?.order && String(item.order.dropanasId) === id);
  if (existing && !shouldReplace(existing.order, change.order)) {
    console.info(`DroPanas ${id}: se conserva "${existing.order.estadoPedido}" en la cola y se descarta "${change.order.estadoPedido}" (mas viejo)`);
    return false;
  }
  state.pending = (state.pending || []).filter((item) => !(item?.order && String(item.order.dropanasId) === id));
  state.pending.push(change);
  return true;
}

function noveltyComparable(novelty) {
  return { orderId: novelty.orderId, status: novelty.status, type: novelty.type };
}

function pendingKey(kind, id, hash) {
  return `${kind}:${id}:${hash}`;
}

function reconcile(state, orders, novelties, now) {
  const nextOrders = {};
  const nextNovelties = {};
  for (const order of orders) nextOrders[order.dropanasId] = api.fingerprint(orderComparable(order));
  for (const novelty of novelties) nextNovelties[novelty.id] = api.fingerprint(noveltyComparable(novelty));
  state.snapshots = state.snapshots || { orders: {}, novelties: {} };
  const lastRank = { ...(state.snapshots.lastStatusRank || {}) };

  // Primera vez, o cambio del formato del hash (S3): se toma como linea base
  // en silencio. Si no, todos los pedidos viejos aparecerian "cambiados" y se
  // reprocesarian (riesgo de mandar avisos viejos). El reconciliador corrige
  // lo que haya quedado atras.
  if (!state.baselineAt || state.snapshotVersion !== SNAPSHOT_VERSION) {
    if (!state.baselineAt) state.baselineAt = now;
    for (const order of orders) lastRank[order.dropanasId] = Math.max(lastRank[order.dropanasId] || 0, orderRank(order));
    state.snapshots = { orders: nextOrders, novelties: nextNovelties, lastStatusRank: lastRank };
    state.snapshotVersion = SNAPSHOT_VERSION;
    return { baselineCreated: true, orderChanges: [], noveltyChanges: [] };
  }

  const orderChanges = [];
  for (const order of orders) {
    const hash = nextOrders[order.dropanasId];
    const previous = state.snapshots.orders?.[order.dropanasId];
    const rank = orderRank(order);
    // Listado atrasado: nunca baja el estado ya visto de un pedido.
    if (rank > 0 && rank < (lastRank[order.dropanasId] || 0)) {
      if (previous) nextOrders[order.dropanasId] = previous;
      continue;
    }
    lastRank[order.dropanasId] = Math.max(lastRank[order.dropanasId] || 0, rank);
    if (previous !== hash) {
      orderChanges.push({
        key: pendingKey('order', order.dropanasId, hash),
        kind: previous ? 'order_changed' : 'order_created',
        detectedAt: now,
        order,
      });
    }
  }
  const noveltyChanges = [];
  for (const novelty of novelties) {
    const hash = nextNovelties[novelty.id];
    const previous = state.snapshots.novelties?.[novelty.id];
    if (previous !== hash) {
      noveltyChanges.push({
        key: pendingKey('novelty', novelty.id, hash),
        kind: previous ? 'novelty_changed' : 'novelty_created',
        detectedAt: now,
        novelty,
      });
    }
  }
  const acceptedOrders = [];
  for (const change of orderChanges) {
    // Si un pedido cambio varias veces antes de procesarse, interesa el estado
    // mas avanzado (o el mas nuevo segun DroPanas), nunca uno atrasado.
    if (enqueueOrderChange(state, change)) acceptedOrders.push(change);
  }
  for (const change of noveltyChanges) {
    state.pending = state.pending.filter((item) => !(item.novelty && item.novelty.id === change.novelty.id));
    state.pending.push(change);
  }
  state.pending = state.pending.slice(-MAX_PENDING);
  state.snapshots = { orders: { ...(state.snapshots.orders || {}), ...nextOrders }, novelties: nextNovelties, lastStatusRank: lastRank };
  return { baselineCreated: false, orderChanges: acceptedOrders, noveltyChanges };
}

async function sync(options = {}) {
  if (running) return running;
  running = (async () => {
    const now = new Date().toISOString();
    try {
      const [orderResult, noveltyResult] = await Promise.all([
        api.fetchOrders(options).catch((error) => {
          const apiDetail = error?.response?.data?.error?.message
            || error?.response?.data?.message
            || error?.response?.data?.error;
          error.message = `Pedidos: ${error.message}${apiDetail ? ` (${String(apiDetail).slice(0, 160)})` : ''}`;
          throw error;
        }),
        api.fetchNovelties(options).catch((error) => {
          const status = Number(error?.response?.status || error?.status);
          if (status !== 403) {
            error.message = `Novedades: ${error.message}`;
            throw error;
          }
          return {
            rows: [],
            novelties: [],
            total: 0,
            pages: 0,
            mode: null,
            warning: 'DroPanas no autorizó la lectura de novedades; pedidos y guías siguen activos',
          };
        }),
      ]);
      if (noveltyResult.mode && orderResult.mode !== noveltyResult.mode) throw new Error('Los endpoints Dropanas respondieron en modos distintos');
      // Se vuelve a leer después de la espera de red. Así una confirmación
      // hecha desde el panel o un delivery registrado mientras llegaban las
      // páginas no se pierde al guardar esta sincronización.
      const state = loadState();
      state.lastSyncAt = now;
      const changes = reconcile(state, orderResult.orders, noveltyResult.novelties, now);
      state.mode = orderResult.mode;
      state.lastSuccessAt = now;
      state.lastError = null;
      state.lastWarning = noveltyResult.warning || null;
      saveState(state);
      let automatic = null;
      if (String(process.env.DROPANAS_AUTO_SEND_ENABLED || '').toLowerCase() === 'true' && !isQuietHours(options.now)) {
        automatic = await require('./dropanasAuto').processChanges(changes.orderChanges);
        if (automatic.acknowledged?.length) acknowledge(automatic.acknowledged);
      }
      return {
        ok: true,
        mode: state.mode,
        baselineAt: state.baselineAt,
        baselineCreated: changes.baselineCreated,
        totals: { orders: orderResult.total, novelties: noveltyResult.total },
        pages: { orders: orderResult.pages, novelties: noveltyResult.pages },
        changes: { orders: changes.orderChanges.length, novelties: changes.noveltyChanges.length },
        pending: loadState().pending.length,
        automatic,
      };
    } catch (error) {
      const state = loadState();
      state.lastSyncAt = now;
      state.lastError = error.message;
      saveState(state);
      throw error;
    } finally {
      running = null;
    }
  })();
  return running;
}

function status() {
  const state = loadState();
  const config = api.configFromEnv();
  const configured = Boolean(config.token && config.tokenMode);
  return {
    configured,
    enabled: configured && config.enabled && config.readOnlyAck,
    tokenMode: config.tokenMode,
    baselineAt: state.baselineAt,
    lastSyncAt: state.lastSyncAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    lastWarning: state.lastWarning,
    mode: state.mode,
    pending: (state.pending || []).length,
    webhookInbox: (state.inbox || []).length,
    // Por que siguen sin salir los avisos pendientes (ultimo intento).
    pendingReasons: Object.values(state.pendingNotes || {}).reduce((acc, note) => {
      const key = note?.reason || 'sin_motivo';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    lastNotifyErrors: Object.values(state.pendingNotes || {}).map((note) => note?.error).filter(Boolean).slice(-5),
    quietHours: isQuietHours(),
    lastWebhookAt: state.lastWebhookAt,
    // S2: vencidos (con su motivo) y el proximo reintento programado.
    expired: (state.expired || []).length,
    expiredReasons: (state.expired || []).reduce((acc, row) => {
      const key = row?.reason || 'sin_motivo';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    recentExpired: (state.expired || []).slice(-10).reverse(),
    nextRetryAt: Object.values(state.pendingNextAttemptAt || {}).sort()[0] || null,
    unknownStatuses: state.unknownStatuses || {},
    lastReconcile: state.lastReconcile || null,
  };
}

function listPending() {
  return loadState().pending || [];
}

function acknowledge(keys) {
  const wanted = new Set((keys || []).map(String));
  const state = loadState();
  const before = state.pending.length;
  state.pending = state.pending.filter((item) => !wanted.has(item.key));
  saveState(state);
  return { acknowledged: before - state.pending.length, pending: state.pending.length };
}

function recordWebhook(deliveryId, { payload, bodyHash } = {}) {
  if (!deliveryId) return false;
  const state = loadState();
  state.deliveries = state.deliveries || [];
  state.bodyHashes = state.bodyHashes || [];
  state.inbox = state.inbox || [];
  if (state.deliveries.includes(deliveryId)) return false;
  if (bodyHash && state.bodyHashes.includes(bodyHash)) return false;
  state.deliveries.push(deliveryId);
  state.deliveries = state.deliveries.slice(-MAX_DELIVERIES);
  if (bodyHash) {
    state.bodyHashes.push(bodyHash);
    state.bodyHashes = state.bodyHashes.slice(-MAX_DELIVERIES);
  }
  if (payload !== undefined) {
    state.inbox.push({ deliveryId, payload, receivedAt: new Date().toISOString(), attempts: 0, lastError: null });
    state.inbox = state.inbox.slice(-MAX_PENDING);
  }
  state.lastWebhookAt = new Date().toISOString();
  saveState(state);
  return true;
}

// Procesa un webhook guardado en la bandeja de entrada. Solo se borra de la
// bandeja cuando termina bien; si falla, queda con el error para reintentar.
async function processInboxItem(deliveryId, options = {}) {
  if (inboxProcessing.has(deliveryId)) return { ok: false, busy: true };
  const item = (loadState().inbox || []).find((row) => row.deliveryId === deliveryId);
  if (!item) return { ok: false, missing: true };
  inboxProcessing.add(deliveryId);
  try {
    const result = await (options.process || processWebhook)(item.payload, options);
    const state = loadState();
    state.inbox = (state.inbox || []).filter((row) => row.deliveryId !== deliveryId);
    saveState(state);
    return result;
  } catch (error) {
    const state = loadState();
    const row = (state.inbox || []).find((entry) => entry.deliveryId === deliveryId);
    if (row) {
      row.attempts = (Number(row.attempts) || 0) + 1;
      row.lastError = error.message;
      row.lastAttemptAt = new Date().toISOString();
    }
    state.lastError = `Webhook ${deliveryId}: ${error.message}`;
    saveState(state);
    throw error;
  } finally {
    inboxProcessing.delete(deliveryId);
  }
}

async function retryInbox(options = {}) {
  const items = (loadState().inbox || []).filter((row) => (Number(row.attempts) || 0) < INBOX_MAX_ATTEMPTS);
  const results = [];
  for (const item of items) {
    try {
      results.push({ deliveryId: item.deliveryId, ok: true, result: await processInboxItem(item.deliveryId, options) });
    } catch (error) {
      results.push({ deliveryId: item.deliveryId, ok: false, error: error.message });
    }
  }
  return results;
}

function startInboxRetry() {
  if (inboxTimer) return false;
  const run = () => retryInbox().catch((error) => console.error('Reintento de webhooks Dropanas:', error.message));
  // Primero lo que haya quedado sin procesar antes de un reinicio.
  run();
  inboxTimer = setInterval(run, INBOX_RETRY_MS);
  inboxTimer.unref?.();
  return true;
}

function stopInboxRetry() {
  if (inboxTimer) clearInterval(inboxTimer);
  inboxTimer = null;
}

// Reintenta avisos ya encolados (llegada a oficina, entregado, novedad,
// devolucion) que dropanasAuto.processChanges no pudo confirmar en su
// primer intento -- por ejemplo, un error transitorio al mandar el WhatsApp.
// Antes de este reintento, ese aviso se perdia para siempre: el webhook ya
// habia respondido 200 y nada volvia a intentarlo. maybeNotify* ya evita
// duplicados ('ya_avisado'), asi que reintentar nunca reenvia un aviso que
// ya llego al cliente.
async function retryPendingNotifications(options = {}) {
  if (String(process.env.DROPANAS_AUTO_SEND_ENABLED || '').toLowerCase() !== 'true') {
    return { enabled: false, results: [] };
  }
  // De noche no se le escribe a nadie: queda para la hora de inicio.
  if (!options.ignoreQuietHours && isQuietHours(options.now ? new Date(options.now) : new Date())) {
    return { enabled: true, quietHours: true, results: [] };
  }
  const now = Number(options.now) || Date.now();
  const expired = expireOldPending(now, options);
  const state = loadState();
  state.pendingAttempts = state.pendingAttempts || {};
  state.pendingNextAttemptAt = state.pendingNextAttemptAt || {};
  const candidates = (state.pending || []).filter((change) => {
    if (!change?.order) return false;
    if ((Number(state.pendingAttempts[change.key]) || 0) >= PENDING_RETRY_MAX) return false;
    const next = Date.parse(state.pendingNextAttemptAt[change.key] || '');
    return !Number.isFinite(next) || now >= next;
  });
  if (!candidates.length) return { enabled: true, results: [], expired };
  const processChanges = options.processChanges || require('./dropanasAuto').processChanges;
  const automatic = await processChanges(candidates);
  const acknowledgedKeys = new Set((automatic.acknowledged || []).map(String));
  const fresh = loadState();
  fresh.pendingAttempts = fresh.pendingAttempts || {};
  fresh.pendingNotes = fresh.pendingNotes || {};
  fresh.pendingNextAttemptAt = fresh.pendingNextAttemptAt || {};
  fresh.dismissed = fresh.dismissed || [];
  const byOrder = new Map((automatic.results || []).map((result) => [String(result.orderId), result]));
  const dismissed = new Set();
  for (const change of candidates) {
    if (acknowledgedKeys.has(change.key)) continue;
    const attempts = (Number(fresh.pendingAttempts[change.key]) || 0) + 1;
    const result = byOrder.get(String(change.order?.dropanasId)) || {};
    const reason = result.reason || result.notice?.reason || null;
    const note = { reason, error: result.error || result.notice?.error || null, at: new Date(now).toISOString() };
    if (reason && NO_RETRY_REASONS.has(reason)) {
      // No hay nada que reintentar: se confirma con una nota.
      dismissed.add(change.key);
      fresh.dismissed.push({ key: change.key, orderId: change.order?.dropanasId || null, guia: change.order?.guia || null, reason, at: note.at });
      continue;
    }
    fresh.pendingAttempts[change.key] = attempts;
    fresh.pendingNotes[change.key] = note;
    fresh.pendingNextAttemptAt[change.key] = new Date(now + backoffMs(attempts)).toISOString();
  }
  fresh.dismissed = fresh.dismissed.slice(-MAX_EXPIRED);
  const gone = new Set([...acknowledgedKeys, ...dismissed]);
  if (gone.size) fresh.pending = fresh.pending.filter((item) => !gone.has(item.key));
  prunePendingMaps(fresh);
  saveState(fresh);
  return { enabled: true, results: automatic.results || [], acknowledged: automatic.acknowledged || [], dismissed: [...dismissed], expired };
}

function prunePendingMaps(state) {
  const stillPending = new Set((state.pending || []).map((item) => item.key));
  for (const field of ['pendingAttempts', 'pendingNotes', 'pendingNextAttemptAt']) {
    for (const key of Object.keys(state[field] || {})) {
      if (!stillPending.has(key)) delete state[field][key];
    }
  }
}

// Los pendientes de mas de 5 dias salen de la cola a "vencidos" (maximo 500,
// con su motivo) y se avisa a Jere UNA vez por tanda.
function expireOldPending(now = Date.now(), options = {}) {
  const state = loadState();
  const old = (state.pending || []).filter((change) => {
    if (!change?.order) return false;
    const detected = Date.parse(change.detectedAt || '');
    return Number.isFinite(detected) && now - detected > PENDING_RETRY_MAX_AGE_MS;
  });
  if (!old.length) return 0;
  const keys = new Set(old.map((c) => c.key));
  state.expired = state.expired || [];
  for (const change of old) {
    state.expired.push({
      key: change.key,
      orderId: change.order?.dropanasId || null,
      guia: change.order?.guia || null,
      estado: change.order?.estadoPedido || null,
      reason: state.pendingNotes?.[change.key]?.reason || 'sin_motivo',
      detectedAt: change.detectedAt || null,
      expiredAt: new Date(now).toISOString(),
    });
  }
  state.expired = state.expired.slice(-MAX_EXPIRED);
  state.pending = state.pending.filter((item) => !keys.has(item.key));
  prunePendingMaps(state);
  saveState(state);
  try {
    const notify = options.notifyAdmin || ((title, body) => require('./push').notifyAdmin(title, body));
    const p = notify('Avisos de DroPanas vencidos', `${old.length} aviso(s) de DroPanas vencieron sin enviarse. Ver Automatización DroPanas.`);
    if (p && p.catch) p.catch(() => {});
  } catch (error) {
    console.error('No se pudo avisar los vencidos de DroPanas:', error.message);
  }
  return old.length;
}

function startPendingRetry() {
  if (pendingRetryTimer) return false;
  const run = () => retryPendingNotifications().catch((error) => console.error('Reintento de avisos Dropanas:', error.message));
  run();
  pendingRetryTimer = setInterval(run, PENDING_RETRY_MS);
  pendingRetryTimer.unref?.();
  return true;
}

function stopPendingRetry() {
  if (pendingRetryTimer) clearInterval(pendingRetryTimer);
  pendingRetryTimer = null;
}

// Cuando GET /ordenes/{id} no está autorizado, la etiqueta oficial sigue
// trayendo el teléfono impreso. Se usa únicamente ese teléfono para asociar
// la guía; nunca se adivina por nombre ni por posición en la cola.
async function enrichPendingGuides(options = {}) {
  const guide = options.guide || require('./dropanasGuide');
  const state = loadState();
  const patches = [];
  let enriched = 0;
  let failed = 0;
  const candidates = (state.pending || []).filter((change) => {
    const order = change?.order;
    return order?.guia && !order.telefono && !order.guideImageFilename
      && ['tealca', 'zoom', 'mrw'].includes(order.carrier);
  });
  let next = 0;
  async function worker() {
    while (next < candidates.length) {
      const change = candidates[next++];
      const order = change.order;
      try {
        const captured = await guide.capture({
          orderId: order.dropanasId,
          expectedTracking: order.guia,
          expectedCarrier: order.carrier,
          ...(options.captureOptions || {}),
        });
        const patch = {
          telefono: api.normalizePhone(captured.phone),
          guideImageFilename: captured.filename,
          guideEnrichedAt: new Date().toISOString(),
        };
        if (!order.cliente && captured.client) patch.cliente = captured.client;
        patches.push({ key: change.key, orderId: order.dropanasId, guia: order.guia, patch });
        if (patch.telefono) enriched += 1;
        else failed += 1;
      } catch (error) {
        patches.push({
          key: change.key,
          orderId: order.dropanasId,
          guia: order.guia,
          patch: { guideEnrichmentError: error.message },
        });
        failed += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
  // Durante las descargas pudo entrar otro webhook. Releer y aplicar únicamente
  // nuestros campos evita guardar la copia antigua y borrar ese evento nuevo.
  const fresh = loadState();
  for (const result of patches) {
    const current = fresh.pending.find((item) => item.key === result.key);
    if (!current?.order) continue;
    if (current.order.dropanasId !== result.orderId || current.order.guia !== result.guia) continue;
    Object.assign(current.order, result.patch);
  }
  saveState(fresh);
  return { total: (fresh.pending || []).length, enriched, failed };
}

function webhookOrder(payload) {
  const data = payload?.datos || {};
  const summary = data.pedido || {};
  const orderId = data.orden_id ?? summary.numero_dropanas;
  const guide = summary.numero_guia ?? data.numero_guia ?? data.tracking_number ?? data.tracking;
  if (!/^\d+$/.test(String(orderId || ''))) throw new Error('Webhook Dropanas sin orden_id valido');
  if (payload?.evento === 'order.guide_generated' && !String(guide || '').trim()) {
    throw new Error('Webhook de guia Dropanas sin numero_guia');
  }
  const client = data.cliente || {};
  const carrierName = String(summary.transportadora || data.transportadora || '').trim().toLowerCase();
  const carrier = carrierName.includes('tealca') ? 'tealca'
    : carrierName.includes('zoom') ? 'zoom'
      : carrierName.includes('mrw') || carrierName.includes('menssajero') ? 'mrw'
        : 'desconocida';
  return {
    dropanasId: String(orderId),
    guia: String(guide).trim(),
    cliente: String(client.nombre || '').trim(),
    telefono: api.normalizePhone(client.telefono),
    ciudad: '',
    producto: '',
    estadoPedido: String(
      payload?.evento === 'order.delivered' ? 'Entregado'
        : payload?.evento === 'incident.created' ? 'En novedad'
          : summary.estado || data.status_nuevo || data.status || ''
    ).trim(),
    totalVentaBs: '',
    bodegaDestino: '',
    carrier,
    tipoEntrega: '',
    oficinaId: null,
    estadoAprobacion: '',
    externalReference: String(summary.numero_externo || '').trim(),
    updatedAt: payload?.timestamp || null,
    _source: 'dropanas-webhook',
  };
}

function queueWebhookOrder(order, now = new Date().toISOString(), kind = 'order.guide_generated') {
  const state = loadState();
  const hash = api.fingerprint(orderComparable(order));
  const change = {
    key: pendingKey('order', order.dropanasId, hash),
    kind,
    detectedAt: now,
    order,
  };
  state.snapshots = state.snapshots || { orders: {}, novelties: {} };
  state.snapshots.orders = state.snapshots.orders || {};
  state.snapshots.lastStatusRank = state.snapshots.lastStatusRank || {};
  const accepted = enqueueOrderChange(state, change);
  state.pending = state.pending.slice(-MAX_PENDING);
  if (accepted) {
    state.snapshots.orders[order.dropanasId] = hash;
    const rank = orderRank(order);
    state.snapshots.lastStatusRank[order.dropanasId] = Math.max(state.snapshots.lastStatusRank[order.dropanasId] || 0, rank);
  }
  state.lastSuccessAt = now;
  state.lastError = null;
  saveState(state);
  if (!accepted) {
    // Ya hay un evento mas avanzado del mismo pedido en la cola: ese es el que
    // se procesa.
    return state.pending.find((item) => item?.order && String(item.order.dropanasId) === String(order.dropanasId)) || change;
  }
  return change;
}

// Procesa solo la orden anunciada por el webhook. Esto evita depender del
// listado GET /ordenes, que algunas cuentas no tienen autorizado, y sigue
// descargando el PDF oficial: nunca abre una pagina ni toma capturas.
async function processWebhook(payload, options = {}) {
  const supportedEvents = new Set([
    'order.guide_generated',
    'order.status_changed',
    'order.delivered',
    'incident.created',
  ]);
  if (!supportedEvents.has(payload?.evento)) {
    return { ok: true, ignored: true, event: payload?.evento || null };
  }
  const announced = webhookOrder(payload);
  const payloadMode = payload?.sandbox === true ? 'sandbox' : payload?.sandbox === false ? 'live' : null;
  const config = options.config || api.configFromEnv(process.env, payloadMode || 'live');
  if (payloadMode && payloadMode !== config.tokenMode) {
    throw new Error(`Webhook Dropanas en modo ${payloadMode}, pero el token es ${config.tokenMode || 'invalido'}`);
  }

  let order = announced;
  let detailWarning = null;
  try {
    const detail = await api.fetchOrder(announced.dropanasId, { ...options, config });
    order = detail.order;
    if (!order.guia) order.guia = announced.guia;
    // El detalle puede tardar unos segundos en reflejar el webhook. El estado
    // anunciado y firmado es la fuente de verdad para esta transición.
    if (announced.estadoPedido) order.estadoPedido = announced.estadoPedido;
    if (payload.evento === 'order.guide_generated' && announced.guia && order.guia !== announced.guia) {
      throw new Error('La guia del detalle no coincide con la anunciada por el webhook');
    }
  } catch (error) {
    // El webhook firmado sigue siendo evidencia valida. Si el detalle puntual
    // falla, se conserva como pendiente para revision, pero nunca se envia a
    // ciegas sin un telefono exacto.
    detailWarning = error.message;
    if (payload.evento === 'order.guide_generated') {
      try {
        const captured = await require('./dropanasGuide').capture({
          orderId: announced.dropanasId,
          expectedTracking: announced.guia,
          expectedCarrier: announced.carrier,
          ...(options.captureOptions || {}),
        });
        order = {
          ...announced,
          telefono: api.normalizePhone(captured.phone),
          cliente: captured.client || announced.cliente,
          guideImageFilename: captured.filename,
          guideEnrichedAt: new Date().toISOString(),
        };
      } catch (guideError) {
        detailWarning = `${detailWarning}; etiqueta: ${guideError.message}`;
      }
    }
    if (!order.telefono && payload.evento !== 'order.guide_generated') {
      order.reviewReason = 'Sin teléfono en el webhook y no se pudo consultar el detalle de la orden; requiere revisión manual.';
    }
  }

  const now = new Date().toISOString();
  const change = queueWebhookOrder(order, now, payload.evento);
  let automatic = null;
  if (String(process.env.DROPANAS_AUTO_SEND_ENABLED || '').toLowerCase() === 'true' && !isQuietHours(options.now)) {
    automatic = await require('./dropanasAuto').processChanges([change]);
    if (automatic.acknowledged?.length) acknowledge(automatic.acknowledged);
  }
  return { ok: true, event: payload.evento, orderId: order.dropanasId, pending: loadState().pending.length, detailWarning, automatic };
}

function start() {
  if (timer || String(process.env.DROPANAS_API_POLL_ENABLED || '').toLowerCase() !== 'true') return false;
  const minutes = Math.max(5, Number(process.env.DROPANAS_API_POLL_MINUTES || 15));
  const run = () => sync().catch((error) => console.error('Dropanas API (solo lectura):', error.message));
  run();
  timer = setInterval(run, minutes * 60 * 1000);
  timer.unref?.();
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function webhookSignature(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody || Buffer.alloc(0)).digest('hex');
}

function verifyWebhook({ rawBody, signature, timestamp, secret, now = Date.now() }) {
  if (!secret || !signature || !timestamp) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds * 1000) > 5 * 60 * 1000) return false;
  const cleanSignature = String(signature).replace(/^sha256=/, '');
  const expected = webhookSignature(rawBody, secret);
  const a = Buffer.from(cleanSignature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  STATE_PATH,
  blankState,
  loadState,
  saveState,
  reconcile,
  shouldReplace,
  orderComparable,
  SNAPSHOT_VERSION,
  sync,
  status,
  listPending,
  acknowledge,
  enrichPendingGuides,
  recordWebhook,
  processInboxItem,
  retryInbox,
  startInboxRetry,
  stopInboxRetry,
  INBOX_MAX_ATTEMPTS,
  retryPendingNotifications,
  startPendingRetry,
  stopPendingRetry,
  PENDING_RETRY_MAX,
  PENDING_RETRY_MAX_AGE_MS,
  NO_RETRY_REASONS,
  backoffMs,
  expireOldPending,
  isQuietHours,
  wasAlerted,
  markAlerted,
  webhookOrder,
  queueWebhookOrder,
  processWebhook,
  start,
  stop,
  webhookSignature,
  verifyWebhook,
};

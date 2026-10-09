'use strict';

// S8: red de seguridad de la sincronizacion DroPanas <-> chats.
//
// Bug real que corrige: todo el seguimiento era REACTIVO. Solo se actuaba
// cuando llegaba un cambio (webhook o diferencia en el polling). Si ese
// cambio se perdia, se vencia o no se entendia, nada volvia a mirar el
// pedido y el chat quedaba en la etapa equivocada para siempre.
//
// Cada hora (si Jere lo prende) se compara el estado ACTUAL de cada pedido
// abierto en DroPanas con la etapa del chat y se corrige:
//  - nunca baja una etapa (salvo "Devuelto", que aplica desde cualquiera);
//  - solo manda mensaje si el cambio en DroPanas es de las ultimas 24 h, el
//    aviso no se mando para ESTE pedido y es una llegada, una guia (con foto
//    o ventana abierta) o un "Entregado". Todo lo demas se corrige en
//    silencio y se escriben las marcas con silentFix para que ningun otro
//    proceso mande despues ese aviso viejo;
//  - los mensajes salen SIEMPRE por shipping.js (guard + marca antes de enviar).
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./dataDir');
const { classifyStatus } = require('./dropanasStatus');
const { logisticRank, hasDropanasLink } = require('./stageRules');

const MAX_PER_ID = 80;
const PER_ID_PAUSE_MS = 700; // DroPanas limita a 100 consultas por minuto
const DELIVERED_LOOKBACK_MS = 15 * 24 * 60 * 60 * 1000;
const FRESH_CHANGE_MS = 24 * 60 * 60 * 1000;
const MAX_LOG = 2000;
const DP_GUIDE = /^DP(\d+)$/i;
const LOG_PATH = () => path.join(DATA_DIR, 'reconciler-log.json');

const MARKER_FOR = {
  shipped: 'shippingNotifiedAt',
  in_office: 'arrivalNotifiedAt',
  novelty: 'arrivalNotifiedAt',
  delivered: 'deliveredNotifiedAt',
  return_pending: 'returnPendingNotifiedAt',
};

let timer = null;
let startTimer = null;
let running = null;

function maskPhone(phone) {
  const p = String(phone || '');
  return p.length > 4 ? `…${p.slice(-4)}` : p;
}

function defaultDeps() {
  const state = require('./state');
  const api = require('./dropanasApi');
  const shipping = require('./shipping');
  return {
    listSessions: state.listSessions,
    updateSession: state.updateSession,
    getSession: state.getSession,
    updateSessionsBulk: state.updateSessionsBulk,
    fetchOrders: () => api.fetchOrders(),
    fetchOrder: (id) => api.fetchOrder(id),
    statusCache: require('./dropanasStatusCache'),
    monitor: require('./dropanasMonitor'),
    shipping,
    isWindowOpen: require('./whatsappWindow').isWindowOpen,
    notifyAdmin: (title, body) => require('./push').notifyAdmin(title, body),
    pauseMs: PER_ID_PAUSE_MS,
    getSettings: () => require('./settings').getSettings(),
  };
}

function orderKeys(session) {
  const ids = new Set();
  const guias = new Set();
  const card = session.card || {};
  for (const guia of [card.guia, card.guiaDropanas]) {
    const value = String(guia || '').trim().toUpperCase();
    if (!value) continue;
    guias.add(value);
    const dp = value.match(DP_GUIDE);
    if (dp) ids.add(dp[1]);
  }
  if (card.dropanasId) ids.add(String(card.dropanasId));
  if (session.dropanasOrder?.id) ids.add(String(session.dropanasOrder.id));
  return { ids: [...ids], guias: [...guias] };
}

// Chats a revisar: vinculados a DroPanas y no terminados, mas los entregados
// de los ultimos 15 dias (para detectar devoluciones tardias).
function selectSessions(sessions, now = Date.now()) {
  return (sessions || []).filter((s) => {
    if (!s?.phone || !hasDropanasLink(s)) return false;
    if (s.stage === 'devolucion') return false;
    if (s.stage === 'entregado') {
      const at = Date.parse(s.stageUpdatedAt || s.updatedAt || '');
      return Number.isFinite(at) && now - at <= DELIVERED_LOOKBACK_MS;
    }
    return true;
  });
}

async function readOrders(targets, deps) {
  const found = new Map(); // phone -> order
  const fetched = [];
  let mode = 'list';
  let errors = 0;
  try {
    const listed = await deps.fetchOrders();
    const byId = new Map();
    const byGuia = new Map();
    for (const order of listed.orders || []) {
      byId.set(String(order.dropanasId), order);
      if (order.guia) byGuia.set(String(order.guia).trim().toUpperCase(), order);
      fetched.push(order);
    }
    for (const s of targets) {
      const keys = orderKeys(s);
      let order = null;
      for (const id of keys.ids) order = order || byId.get(id) || null;
      for (const g of keys.guias) order = order || byGuia.get(g) || null;
      if (order) found.set(s.phone, order);
    }
  } catch (error) {
    // Listado no autorizado (403) u otro error: consulta uno por uno, con
    // tope y pausa. Primero los que hace mas tiempo no se revisan.
    mode = 'per_id';
    const rotation = targets
      .filter((s) => orderKeys(s).ids.length)
      .sort((a, b) => String(a.reconciledAt || '').localeCompare(String(b.reconciledAt || '')))
      .slice(0, MAX_PER_ID);
    let first = true;
    for (const s of rotation) {
      if (!first && deps.pauseMs) await new Promise((resolve) => setTimeout(resolve, deps.pauseMs));
      first = false;
      try {
        const { order } = await deps.fetchOrder(orderKeys(s).ids[0]);
        if (order) {
          found.set(s.phone, order);
          fetched.push(order);
        }
      } catch (err) {
        errors += 1;
      }
    }
  }
  if (fetched.length && deps.statusCache) deps.statusCache.putMany(fetched);
  return { found, mode, errors };
}

// Decide que hacer con un chat segun el estado actual de su pedido.
function decide(session, order, { now = Date.now(), silent = false, deps = {} } = {}) {
  const st = classifyStatus(order.estadoPedido, deps.settings);
  const base = { phone: session.phone, dropanasId: String(order.dropanasId || ''), estado: order.estadoPedido || '', kind: st.kind, from: session.stage || null };
  if (st.kind === 'cancelled' || st.kind === 'unknown' || !st.stage) return { ...base, action: 'report', to: null };
  const to = st.stage;
  const current = session.stage || 'nuevo';
  let advance;
  if (st.kind === 'returned') advance = current !== 'devolucion';
  else advance = current !== to && logisticRank(to) > logisticRank(current) && current !== 'devolucion';
  if (!advance) return { ...base, action: 'none', to };
  if (session.stageLocked === true) {
    // Fijado a mano: solo se sugiere (entregado/devolucion), nunca se aplica.
    return { ...base, action: ['returned', 'delivered'].includes(st.kind) ? 'suggest' : 'none', to };
  }
  const marker = MARKER_FOR[st.kind] || null;
  const shipping = deps.shipping;
  const already = marker ? (shipping?.alreadyNotified ? shipping.alreadyNotified(session, marker) : Boolean(session[marker])) : true;
  const changedAt = Date.parse(order.updatedAt || '');
  const freshChange = Number.isFinite(changedAt) && now - changedAt <= FRESH_CHANGE_MS && changedAt <= now + 5 * 60 * 1000;
  let typeAllowed = false;
  if (st.kind === 'in_office' || st.kind === 'novelty') typeAllowed = true;
  else if (st.kind === 'delivered') typeAllowed = !st.paid;
  else if (st.kind === 'shipped') typeAllowed = Boolean(session.card?.guiaImageUrl) || Boolean(deps.isWindowOpen && deps.isWindowOpen(session));
  // Aviso reciente que corresponde mandar pero esta corrida es silenciosa (de
  // noche, primera aprobacion): se mueve la etapa pero NO se escribe la marca,
  // asi el aviso pendiente todavia puede salir por el camino normal.
  const freshPending = freshChange && !already && typeAllowed && Boolean(marker);
  const sendMessage = !silent && freshPending;
  // Guia reciente sin foto ni ventana abierta: la manda el flujo normal de
  // dropanasAuto (descarga la etiqueta). Si el reconciliador movia la etapa a
  // en_camino, ese aviso ya no salia nunca: aca no se toca.
  if (st.kind === 'shipped' && freshChange && !already && !sendMessage) return { ...base, action: 'none', to, reason: 'esperando_aviso_de_guia' };
  return { ...base, action: 'advance', to, marker, sendMessage, freshPending, paid: Boolean(st.paid), guia: order.guia || '' };
}

function appendLog(entries) {
  if (!entries.length) return;
  let log = [];
  try {
    log = JSON.parse(fs.readFileSync(LOG_PATH(), 'utf8'));
    if (!Array.isArray(log)) log = [];
  } catch (err) {
    log = [];
  }
  log.push(...entries);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOG_PATH(), JSON.stringify(log.slice(-MAX_LOG)));
  } catch (err) {
    console.error('No se pudo guardar el log del reconciliador:', err.message);
  }
}

function readLog(limit = 200) {
  try {
    const log = JSON.parse(fs.readFileSync(LOG_PATH(), 'utf8'));
    return Array.isArray(log) ? log.slice(-limit).reverse() : [];
  } catch (err) {
    return [];
  }
}

async function applyDecision(decision, session, order, deps, nowIso) {
  const card = { ...(session.card || {}) };
  if (order.guia && !card.guia) card.guia = String(order.guia).trim();
  if (order.dropanasId && !card.dropanasId) card.dropanasId = String(order.dropanasId);
  const orderKey = { notifiedForOrderId: card.dropanasId || null, notifiedForGuia: card.guia ? String(card.guia).toUpperCase() : null };
  // Primero la ficha (guia/id) para que el aviso lleve el numero correcto.
  let fresh = deps.updateSession(session.phone, { card, ...(decision.to !== 'devolucion' ? { orderClosed: true } : {}) }) || { ...session, card };
  let sent = false;
  if (decision.sendMessage) {
    const fn = decision.kind === 'shipped' ? 'maybeNotifyShipping'
      : decision.kind === 'delivered' ? 'maybeNotifyDelivered'
        : 'maybeNotifyArrival';
    try {
      const notice = await deps.shipping[fn](session.phone, fresh);
      sent = Boolean(notice?.sent);
    } catch (err) {
      console.error('Reconciliador: no se pudo mandar el aviso a', maskPhone(session.phone), err.message);
    }
  }
  const patch = {
    stage: decision.to,
    stageLocked: false,
    stageSource: 'reconciler',
    stageUpdatedAt: nowIso,
    stageReason: `Reconciliador: DroPanas dice ${decision.estado}`,
  };
  if (decision.to === 'esperando_retiro' && !fresh.pickupReminderAnchorDate) patch.pickupReminderAnchorDate = nowIso.slice(0, 10);
  // Corregido en silencio: se escribe la marca para que ningun otro proceso
  // mande despues este aviso viejo.
  if (!sent && !decision.freshPending && decision.marker && !(deps.shipping?.alreadyNotified ? deps.shipping.alreadyNotified(fresh, decision.marker) : fresh[decision.marker])) {
    patch[decision.marker] = nowIso;
    patch.silentFix = { ...(fresh.silentFix || {}), [decision.marker]: true };
    Object.assign(patch, orderKey);
  }
  fresh = deps.updateSession(session.phone, patch) || fresh;
  return sent;
}

// mode: 'live' | 'dry'. silent: true fuerza cero mensajes.
async function run({ now = new Date(), mode = 'live', silent = false, deps: overrides = {} } = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const settings = deps.settings || (deps.getSettings ? deps.getSettings() : {});
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const targets = selectSessions(deps.listSessions(), nowMs);
  const { found, mode: readMode, errors } = await readOrders(targets, deps);
  const decisions = [];
  for (const s of targets) {
    const order = found.get(s.phone);
    if (!order) continue;
    decisions.push({ decision: decide(s, order, { now: nowMs, silent, deps: { ...deps, settings } }), session: s, order });
  }
  const summary = {
    at: nowIso, mode, readMode, revisados: found.size, objetivos: targets.length, corregidos: 0, mensajes: 0, errores: errors,
    sugerencias: 0, porEstado: {},
  };
  const preview = [];
  const log = [];
  for (const { decision, session, order } of decisions) {
    summary.porEstado[decision.kind] = (summary.porEstado[decision.kind] || 0) + 1;
    if (decision.action === 'suggest') summary.sugerencias += 1;
    if (decision.action !== 'advance' && decision.action !== 'suggest' && decision.action !== 'report') continue;
    preview.push({
      phone: session.phone, cliente: session.card?.nombre || session.name || '', dropanasId: decision.dropanasId,
      estado: decision.estado, etapaActual: decision.from, etapaNueva: decision.to, accion: decision.action,
      mensaje: decision.action === 'advance' ? Boolean(decision.sendMessage) : false,
    });
    if (mode !== 'live' || decision.action !== 'advance') continue;
    try {
      const sent = await applyDecision(decision, session, order, deps, nowIso);
      summary.corregidos += 1;
      if (sent) summary.mensajes += 1;
      log.push({ at: nowIso, phone: maskPhone(session.phone), dropanasId: decision.dropanasId, estado: decision.estado, from: decision.from, to: decision.to, mensaje: sent });
    } catch (err) {
      summary.errores += 1;
      console.error('Reconciliador: no se pudo corregir', maskPhone(session.phone), err.message);
    }
  }
  if (mode === 'live') {
    appendLog(log);
    // Marca de revisado (sin reordenar el panel), para rotar las consultas.
    const touched = {};
    for (const phone of found.keys()) touched[phone] = { reconciledAt: nowIso };
    if (deps.updateSessionsBulk) deps.updateSessionsBulk(touched);
  }
  try {
    const state = deps.monitor.loadState();
    if (mode === 'live') state.lastReconcile = summary;
    else state.lastReconcileDry = { ...summary, preview: preview.slice(0, 1000) };
    deps.monitor.saveState(state);
  } catch (err) {
    console.error('Reconciliador: no se pudo guardar el resumen:', err.message);
  }
  return { summary, preview };
}

// Primera corrida: si nunca se reconcilio, solo vista previa (dry) y push.
async function scheduledRun(overrides = {}) {
  if (running) return running;
  running = (async () => {
    const deps = { ...defaultDeps(), ...overrides };
    if (deps.monitor.status && !deps.monitor.status().enabled) return { skipped: 'dropanas_api_apagada' };
    const state = deps.monitor.loadState();
    const settings = deps.getSettings ? deps.getSettings() : {};
    if (!state.lastReconcile) {
      if (state.lastReconcileDry) return { skipped: 'esperando_aprobacion' };
      const result = await run({ mode: 'dry', deps });
      const n = result.preview.filter((r) => r.accion === 'advance').length;
      if (!n) return result;
      try {
        const p = deps.notifyAdmin('Sincronización DroPanas', `El reconciliador encontró ${n} chats desincronizados. Revísalo en Automatización DroPanas y aprueba la corrección.`);
        if (p && p.catch) p.catch(() => {});
      } catch (err) { /* push opcional */ }
      return result;
    }
    if (settings.dropanasReconcileEnabled !== true) return { skipped: 'apagado' };
    // Fuera del horario de avisos se corrige igual, pero en silencio.
    // Sin el envio automatico de DroPanas prendido tampoco se manda nada.
    const quiet = deps.monitor.isQuietHours ? deps.monitor.isQuietHours() : false;
    const autoSend = String((deps.env || process.env).DROPANAS_AUTO_SEND_ENABLED || '').toLowerCase() === 'true';
    return run({ mode: 'live', silent: quiet || !autoSend, deps });
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

function start() {
  if (timer || startTimer) return false;
  const minutes = Math.max(15, Number(process.env.RECONCILE_EVERY_MIN || 60));
  const go = () => scheduledRun().catch((err) => console.error('Reconciliador DroPanas:', err.message));
  startTimer = setTimeout(() => {
    startTimer = null;
    go();
    timer = setInterval(go, minutes * 60 * 1000);
    timer.unref?.();
  }, 2 * 60 * 1000);
  startTimer.unref?.();
  return true;
}

function stop() {
  if (startTimer) clearTimeout(startTimer);
  if (timer) clearInterval(timer);
  startTimer = null;
  timer = null;
}

module.exports = { run, scheduledRun, start, stop, decide, selectSessions, readLog, MAX_PER_ID, MARKER_FOR };

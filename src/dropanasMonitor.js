'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./dataDir');
const api = require('./dropanasApi');

const STATE_PATH = path.join(DATA_DIR, 'dropanas-api-state.json');
const MAX_PENDING = 1000;
const MAX_DELIVERIES = 500;
let timer = null;
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
    deliveries: [],
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

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, STATE_PATH);
}

function orderComparable(order) {
  return {
    guia: order.guia,
    estadoPedido: order.estadoPedido,
    estadoAprobacion: order.estadoAprobacion,
    tipoEntrega: order.tipoEntrega,
    telefono: order.telefono,
    cliente: order.cliente,
    producto: order.producto,
    totalVentaBs: order.totalVentaBs,
    oficinaId: order.oficinaId,
  };
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

  if (!state.baselineAt) {
    state.baselineAt = now;
    state.snapshots = { orders: nextOrders, novelties: nextNovelties };
    return { baselineCreated: true, orderChanges: [], noveltyChanges: [] };
  }

  const orderChanges = [];
  for (const order of orders) {
    const hash = nextOrders[order.dropanasId];
    const previous = state.snapshots.orders?.[order.dropanasId];
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
  for (const change of [...orderChanges, ...noveltyChanges]) {
    // Si una entidad cambió varias veces antes de que el operador la revise,
    // solo interesa su estado más nuevo. Conservar estados intermedios podría
    // hacer retroceder una conversación o mandar avisos fuera de orden.
    state.pending = state.pending.filter((item) => {
      if (change.order && item.order) return item.order.dropanasId !== change.order.dropanasId;
      if (change.novelty && item.novelty) return item.novelty.id !== change.novelty.id;
      return true;
    });
    state.pending.push(change);
  }
  state.pending = state.pending.slice(-MAX_PENDING);
  state.snapshots = { orders: nextOrders, novelties: nextNovelties };
  return { baselineCreated: false, orderChanges, noveltyChanges };
}

async function sync(options = {}) {
  if (running) return running;
  running = (async () => {
    const now = new Date().toISOString();
    try {
      const [orderResult, noveltyResult] = await Promise.all([
        api.fetchOrders(options),
        api.fetchNovelties(options).catch((error) => {
          if (Number(error?.response?.status) !== 403) throw error;
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
      if (String(process.env.DROPANAS_AUTO_SEND_ENABLED || '').toLowerCase() === 'true') {
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
    lastWebhookAt: state.lastWebhookAt,
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

function recordWebhook(deliveryId) {
  if (!deliveryId) return false;
  const state = loadState();
  if (state.deliveries.includes(deliveryId)) return false;
  state.deliveries.push(deliveryId);
  state.deliveries = state.deliveries.slice(-MAX_DELIVERIES);
  state.lastWebhookAt = new Date().toISOString();
  saveState(state);
  return true;
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
  sync,
  status,
  listPending,
  acknowledge,
  recordWebhook,
  start,
  stop,
  webhookSignature,
  verifyWebhook,
};

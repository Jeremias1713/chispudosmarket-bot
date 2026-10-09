'use strict';
// S8: el reconciliador compara el estado ACTUAL de DroPanas con la etapa del
// chat y corrige, sin bajar etapas y sin mandar avisos viejos.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-reconciler');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const reconciler = require('../src/dropanasReconciler');
const monitor = require('../src/dropanasMonitor');
const shipping = require('../src/shipping');

after(() => cleanup(dataDir));

const NOW = new Date('2026-10-06T15:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

function harness(sessions, orders, { listFails = false, extra = {} } = {}) {
  const store = new Map(sessions.map((s) => [s.phone, { ...s }]));
  const calls = { arrival: 0, shipping: 0, delivered: 0, fetchOrder: 0, bulk: null };
  const fakeShipping = {
    alreadyNotified: shipping.alreadyNotified,
    maybeNotifyArrival: async () => { calls.arrival += 1; return { sent: true }; },
    maybeNotifyShipping: async () => { calls.shipping += 1; return { sent: true }; },
    maybeNotifyDelivered: async () => { calls.delivered += 1; return { sent: true }; },
  };
  const deps = {
    listSessions: () => [...store.values()],
    updateSession: (phone, patch) => { const next = { ...store.get(phone), ...patch }; store.set(phone, next); return next; },
    updateSessionsBulk: (patches) => { calls.bulk = patches; for (const [p, patch] of Object.entries(patches)) store.set(p, { ...store.get(p), ...patch }); },
    fetchOrders: async () => { if (listFails) { const e = new Error('403'); e.status = 403; throw e; } return { orders }; },
    fetchOrder: async (id) => { calls.fetchOrder += 1; return { order: orders.find((o) => o.dropanasId === String(id)) || null }; },
    statusCache: { putMany: () => {} },
    monitor,
    shipping: fakeShipping,
    isWindowOpen: () => false,
    notifyAdmin: () => {},
    pauseMs: 0,
    settings: { dropanasPaidMeansDelivered: true },
    ...extra,
  };
  return { store, calls, deps };
}

const chat = (phone, stage, extra = {}) => ({ phone, stage, orderClosed: true, stageUpdatedAt: hoursAgo(48), card: { nombre: 'Cliente', guia: `G${phone.slice(-3)}`, dropanasId: phone.slice(-3) }, ...extra });
const order = (id, estado, updatedAt = hoursAgo(72)) => ({ dropanasId: String(id), guia: `G${id}`, estadoPedido: estado, updatedAt });

test('esperando_retiro + "Pagado": pasa a entregado sin mensaje', async () => {
  const h = harness([chat('584120000101', 'esperando_retiro')], [order(101, 'Pagado', hoursAgo(1))]);
  const { summary } = await reconciler.run({ now: NOW, deps: h.deps });
  assert.equal(h.store.get('584120000101').stage, 'entregado');
  assert.equal(h.calls.delivered, 0);
  assert.equal(summary.corregidos, 1);
  assert.equal(summary.mensajes, 0);
});

test('en_camino + "En oficina" de hace 2 h: esperando_retiro y aviso de llegada', async () => {
  const h = harness([chat('584120000102', 'en_camino')], [order(102, 'En oficina', hoursAgo(2))]);
  const { summary } = await reconciler.run({ now: NOW, deps: h.deps });
  const s = h.store.get('584120000102');
  assert.equal(s.stage, 'esperando_retiro');
  assert.equal(s.stageSource, 'reconciler');
  assert.match(s.stageReason, /Reconciliador: DroPanas dice En oficina/);
  assert.equal(h.calls.arrival, 1);
  assert.equal(summary.mensajes, 1);
});

test('mismo caso con el cambio de hace 3 dias: sin mensaje y marca con silentFix', async () => {
  const h = harness([chat('584120000103', 'en_camino')], [order(103, 'En oficina', hoursAgo(72))]);
  await reconciler.run({ now: NOW, deps: h.deps });
  const s = h.store.get('584120000103');
  assert.equal(s.stage, 'esperando_retiro');
  assert.equal(h.calls.arrival, 0);
  assert.ok(s.arrivalNotifiedAt);
  assert.equal(s.silentFix.arrivalNotifiedAt, true);
});

test('entregado + "Devuelto": pasa a devolucion', async () => {
  const h = harness([chat('584120000104', 'entregado', { stageUpdatedAt: hoursAgo(24) })], [order(104, 'Devuelto')]);
  await reconciler.run({ now: NOW, deps: h.deps });
  assert.equal(h.store.get('584120000104').stage, 'devolucion');
});

test('esperando_retiro + "En tránsito" (listado atrasado): no baja', async () => {
  const h = harness([chat('584120000105', 'esperando_retiro')], [order(105, 'En tránsito', hoursAgo(1))]);
  const { summary } = await reconciler.run({ now: NOW, deps: h.deps });
  assert.equal(h.store.get('584120000105').stage, 'esperando_retiro');
  assert.equal(summary.corregidos, 0);
});

test('stageLocked + "Pagado": se corrige igual y conserva el candado', async () => {
  const h = harness([chat('584120000106', 'esperando_retiro', { stageLocked: true })], [order(106, 'Pagado')]);
  const { summary } = await reconciler.run({ now: NOW, deps: h.deps });
  const s = h.store.get('584120000106');
  assert.equal(s.stage, 'entregado');
  assert.equal(s.stageLocked, true);
  assert.equal(summary.corregidos, 1);
});

test('stageLocked + "En tránsito" atrasado: nunca baja la etapa', async () => {
  const h = harness([chat('584120000113', 'esperando_retiro', { stageLocked: true })], [order(113, 'En tránsito', hoursAgo(1))]);
  await reconciler.run({ now: NOW, deps: h.deps });
  assert.equal(h.store.get('584120000113').stage, 'esperando_retiro');
});

test('listado 403: consulta individual con tope 80 y rotacion por reconciledAt', async () => {
  const sessions = [];
  const orders = [];
  for (let i = 0; i < 90; i += 1) {
    const phone = `5841200${String(1000 + i).padStart(5, '0')}`;
    const id = phone.slice(-3);
    // Los primeros 10 se revisaron hace poco: quedan para la proxima corrida.
    sessions.push(chat(phone, 'en_camino', { reconciledAt: i < 10 ? hoursAgo(1) : null, card: { guia: `G${phone}`, dropanasId: `${i}x` } }));
    orders.push({ dropanasId: `${i}x`, guia: `G${phone}`, estadoPedido: 'En tránsito', updatedAt: hoursAgo(5) });
  }
  const h = harness(sessions, orders, { listFails: true });
  const { summary } = await reconciler.run({ now: NOW, deps: h.deps });
  assert.equal(h.calls.fetchOrder, reconciler.MAX_PER_ID);
  assert.equal(summary.readMode, 'per_id');
  // Ninguno de los 10 revisados hace poco entro en esta tanda.
  for (let i = 0; i < 10; i += 1) assert.equal(h.calls.bulk[sessions[i].phone], undefined);
});

test('mode dry no escribe nada', async () => {
  const h = harness([chat('584120000107', 'en_camino')], [order(107, 'En oficina', hoursAgo(2))]);
  const before = JSON.stringify([...h.store.values()]);
  const { preview } = await reconciler.run({ now: NOW, mode: 'dry', deps: h.deps });
  assert.equal(JSON.stringify([...h.store.values()]), before);
  assert.equal(h.calls.arrival, 0);
  assert.equal(preview[0].mensaje, true);
  assert.ok(monitor.loadState().lastReconcileDry);
});

test('apply con silent: true no llama a shipping aunque el cambio sea reciente', async () => {
  const h = harness([chat('584120000108', 'en_camino'), chat('584120000109', 'esperando_retiro')], [order(108, 'En oficina', hoursAgo(1)), order(109, 'Entregado', hoursAgo(1))]);
  const { summary } = await reconciler.run({ now: NOW, silent: true, deps: h.deps });
  assert.equal(h.calls.arrival + h.calls.shipping + h.calls.delivered, 0);
  assert.equal(summary.corregidos, 2);
  assert.equal(h.store.get('584120000109').stage, 'entregado');
});

test('primera corrida programada: solo vista previa y un push', async () => {
  const state = monitor.loadState();
  delete state.lastReconcile;
  delete state.lastReconcileDry;
  monitor.saveState(state);
  const pushes = [];
  const h = harness([chat('584120000110', 'en_camino')], [order(110, 'En oficina', hoursAgo(1))], {
    extra: { notifyAdmin: (_t, body) => pushes.push(body), monitor: { ...monitor, status: () => ({ enabled: true }) } },
  });
  await reconciler.scheduledRun(h.deps);
  assert.equal(h.store.get('584120000110').stage, 'en_camino');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /encontró 1 chats desincronizados/);
  const again = await reconciler.scheduledRun(h.deps);
  assert.equal(again.skipped, 'esperando_aprobacion');
});

test('silencio con un aviso reciente: mueve la etapa pero no escribe la marca (el aviso aun puede salir)', async () => {
  const h = harness([chat('584120000111', 'en_camino')], [order(111, 'En oficina', hoursAgo(1))]);
  await reconciler.run({ now: NOW, silent: true, deps: h.deps });
  const s = h.store.get('584120000111');
  assert.equal(s.stage, 'esperando_retiro');
  assert.equal(s.arrivalNotifiedAt, undefined);
});

test('guia reciente sin foto ni ventana: no se toca, la manda el flujo normal', async () => {
  const h = harness([chat('584120000112', 'vendido', { card: { nombre: 'X', dropanasId: '112' } })], [order(112, 'En tránsito', hoursAgo(1))]);
  await reconciler.run({ now: NOW, deps: h.deps });
  const s = h.store.get('584120000112');
  assert.equal(s.stage, 'vendido');
  assert.equal(s.card.guia, undefined);
  assert.equal(h.calls.shipping, 0);
});

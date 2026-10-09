'use strict';
// S5: recompras. El pedido nuevo del mismo cliente recibe sus propios avisos;
// las marcas del pedido anterior no lo bloquean. Dos pedidos abiertos a la
// vez quedan para revision con un push.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-recompra');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const auto = require('../src/dropanasAuto');
const shipping = require('../src/shipping');

after(() => cleanup(dataDir));

function harness(store, order, matchRows) {
  const calls = { shipping: 0, arrival: 0, pushes: [] };
  const overrides = {
    env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
    matchRows: matchRows || ((rows) => rows.map((row) => ({ ...row, matchType: 'sin_match', candidates: [] }))),
    listSessions: () => [store],
    getSession: () => ({ ...store }),
    updateSession: (_p, patch) => { Object.assign(store, patch); return { ...store }; },
    capture: async () => ({ filename: 'g2.png' }),
    mediaUrl: (f) => `https://x/${f}`,
    maybeNotifyShipping: async (_p, s) => { calls.shipping += 1; calls.shippedGuia = s.card.guia; return { sent: true }; },
    maybeNotifyArrival: async (_p, s) => { calls.arrival += 1; calls.arrivalGuia = s.card.guia; return { sent: true }; },
    notifyAdmin: (_t, body) => calls.pushes.push(body),
  };
  return auto.processChanges([{ key: `k-${order.estadoPedido}`, order }], overrides).then((result) => ({ result, calls }));
}

const firstOrder = () => ({
  phone: '584120000300', stage: 'entregado', orderClosed: true, soldAt: '2026-09-01T00:00:00Z',
  card: { nombre: 'Marta Diaz', telefono: '04120000300', guia: 'G100', dropanasId: '100' },
  shippingNotifiedAt: '2026-09-02T00:00:00Z', arrivalNotifiedAt: '2026-09-04T00:00:00Z', deliveredNotifiedAt: '2026-09-05T00:00:00Z',
  notifiedForOrderId: '100', notifiedForGuia: 'G100',
});

test('pedido 1 entregado + guia del pedido 2: aviso de guia del 2 y el 1 queda archivado', async () => {
  const store = firstOrder();
  const { result, calls } = await harness(store, { dropanasId: '200', guia: 'G200', telefono: '04120000300', estadoPedido: 'En tránsito', carrier: 'tealca' });
  assert.equal(calls.shipping, 1, JSON.stringify(result.results));
  assert.equal(calls.shippedGuia, 'G200');
  assert.equal(store.previousOrders.length, 1);
  assert.equal(store.previousOrders[0].card.guia, 'G100');
  assert.equal(store.card.dropanasId, '200');
  assert.equal(store.stage, 'en_camino');
  assert.equal(store.orderClosed, true);

  // Despues llega "En oficina" del pedido 2: se avisa la llegada.
  const next = await harness(store, { dropanasId: '200', guia: 'G200', telefono: '04120000300', estadoPedido: 'En oficina', carrier: 'tealca' }, (rows) => rows);
  assert.equal(next.calls.arrival, 1);
  assert.equal(next.calls.arrivalGuia, 'G200');
  assert.equal(store.stage, 'esperando_retiro');
});

test('"En oficina" del pedido 2 con el chat todavia en el pedido 1 entregado: archiva y avisa', async () => {
  const store = firstOrder();
  const { calls } = await harness(store, { dropanasId: '201', guia: 'G201', telefono: '04120000300', estadoPedido: 'En oficina', carrier: 'tealca' }, (rows) => rows);
  assert.equal(calls.arrival, 1);
  assert.equal(store.previousOrders.length, 1);
  assert.equal(store.card.guia, 'G201');
  assert.equal(store.stage, 'esperando_retiro');
});

test('una marca de otro pedido no cuenta como ya avisado', () => {
  const s = { arrivalNotifiedAt: '2026-09-04T00:00:00Z', notifiedForOrderId: '100', card: { dropanasId: '200', guia: 'G200' } };
  assert.equal(shipping.alreadyNotified(s, 'arrivalNotifiedAt'), false);
  assert.equal(shipping.alreadyNotified({ ...s, card: { dropanasId: '100' } }, 'arrivalNotifiedAt'), true);
  // Marcas viejas sin dueño: se respetan como antes.
  assert.equal(shipping.alreadyNotified({ arrivalNotifiedAt: 'x', card: { guia: 'G1' } }, 'arrivalNotifiedAt'), true);
  // La guia interna DP<orden> y la real son el mismo pedido.
  assert.equal(shipping.alreadyNotified({ arrivalNotifiedAt: 'x', notifiedForOrderId: '555', card: { guia: 'DP555' } }, 'arrivalNotifiedAt'), true);
});

test('dos pedidos abiertos a la vez: no se toca nada y un push', async () => {
  const store = { ...firstOrder(), stage: 'esperando_retiro' };
  const before = JSON.stringify(store);
  const { result, calls } = await harness(store, { dropanasId: '202', guia: 'G202', telefono: '04120000300', estadoPedido: 'En oficina', carrier: 'tealca' }, (rows) => rows);
  assert.equal(result.results[0].reason, 'dos_pedidos_abiertos');
  assert.equal(JSON.stringify(store), before);
  assert.equal(calls.pushes.length, 1);
  assert.match(calls.pushes[0], /G100.*G202/);
});

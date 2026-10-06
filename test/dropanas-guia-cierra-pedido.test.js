'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-guia-cierra-pedido');
// S4: si DroPanas tiene una guia real y el cruce es por evidencia fuerte, el
// pedido es una venta aunque el chat haya quedado en negociando/interesado.
const { test, after } = require('node:test');

const assert = require('node:assert/strict');
const auto = require('../src/dropanasAuto');

function harness(initial, evidence, order = {}) {
  const store = { ...initial };
  const calls = { shipping: 0, arrival: 0, patches: [] };
  const overrides = {
    env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
    matchRows: (rows) => rows.map((row) => ({ ...row, matchType: 'exacto', matchEvidence: evidence, phone: store.phone, sendEligible: false })),
    listSessions: () => [store],
    getSession: () => ({ ...store }),
    updateSession: (_p, patch) => { calls.patches.push(patch); Object.assign(store, patch); return { ...store }; },
    capture: async () => ({ filename: 'guia.png' }),
    mediaUrl: (f) => `https://x/${f}`,
    maybeNotifyShipping: async () => { calls.shipping += 1; return { sent: true }; },
    maybeNotifyArrival: async () => { calls.arrival += 1; return { sent: true }; },
    notifyAdmin: () => {},
  };
  const changes = [{ key: 'g1', order: { dropanasId: '901', guia: '84890100', telefono: '04120000901', carrier: 'tealca', estadoPedido: 'En tránsito', createdAt: '2026-10-01T15:00:00Z', ...order } }];
  return auto.processChanges(changes, overrides).then((result) => ({ result, calls, store }));
}

const chat = { phone: '584120000901', stage: 'negociando', card: { nombre: 'Pedro Perez' } };

test('chat en negociando + guia con match por telefono: cierra el pedido, en_camino y aviso de guia', async () => {
  const { result, calls, store } = await harness(chat, 'telefono');
  assert.equal(store.orderClosed, true);
  assert.equal(store.stage, 'en_camino');
  assert.equal(store.soldAt, '2026-10-01T15:00:00.000Z');
  assert.equal(store.card.guia, '84890100');
  assert.equal(calls.shipping, 1);
  assert.equal(result.results[0].sent, true);
});

test('mismo caso con match solo por nombre: no se toca', async () => {
  const { result, calls, store } = await harness(chat, 'nombre');
  assert.equal(store.stage, 'negociando');
  assert.equal(store.orderClosed, undefined);
  assert.equal(calls.shipping, 0);
  assert.equal(result.results[0].reason, 'estado_no_esperando_guia');
});

test('match por telefono+etapa tampoco alcanza', async () => {
  const { calls, store } = await harness(chat, 'telefono+etapa');
  assert.equal(store.stage, 'negociando');
  assert.equal(calls.shipping, 0);
});

test('pedido subido a mano (dropanasOrder.id) avanza por orden', async () => {
  const { calls, store } = await harness({ ...chat, stage: 'interesado', dropanasOrder: null }, 'orden');
  assert.equal(store.stage, 'en_camino');
  assert.equal(calls.shipping, 1);
});

test('"En oficina" de un chat en negociando con match por telefono: cierra y avisa la llegada', async () => {
  const store = { ...chat };
  const calls = { arrival: 0 };
  const result = await auto.processChanges(
    [{ key: 'o1', order: { dropanasId: '902', guia: '84890200', telefono: '04120000901', estadoPedido: 'En oficina', carrier: 'tealca' } }],
    {
      env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
      matchRows: (rows) => rows,
      listSessions: () => [store],
      updateSession: (_p, patch) => { Object.assign(store, patch); return { ...store }; },
      maybeNotifyArrival: async () => { calls.arrival += 1; return { sent: true }; },
      notifyAdmin: () => {},
    }
  );
  assert.equal(calls.arrival, 1);
  assert.equal(store.orderClosed, true);
  assert.equal(store.stage, 'esperando_retiro');
  assert.deepEqual(result.acknowledged, ['o1']);
});

after(() => cleanup(dataDir));

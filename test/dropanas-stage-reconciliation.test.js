'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-stage-reconciliation');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const auto = require('../src/dropanasAuto');
after(() => cleanup(dataDir));

function fixture(stage = 'en_camino') {
  let session = { phone: '584120000123', stage, card: { guia: 'G123', dropanasId: '123', nombre: 'Cliente Prueba' } };
  let sends = 0;
  const notify = async () => ({ sent: ++sends > 1, reason: sends === 1 ? 'error' : undefined });
  const deps = {
    env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
    matchRows: (rows) => rows.map(row => ({ ...row, matchType: 'exacto', phone: session.phone, sendEligible: ['vendido', 'esperando_guia'].includes(session.stage) })),
    listSessions: () => [session], getSession: () => session,
    updateSession: (_phone, patch) => (session = { ...session, ...patch }),
    maybeNotifyArrival: notify, maybeNotifyDelivered: notify,
    maybeNotifyNovelty: notify, maybeNotifyReturnPending: notify, maybeNotifyShipping: notify,
    capture: async () => ({ filename: 'guide.png' }), mediaUrl: () => 'https://example.com/guide.png',
    detectOrderConflict: () => null,
  };
  const change = status => [{ key: 'k123', order: { dropanasId: '123', guia: 'G123', telefono: session.phone, estadoPedido: status, carrier: 'tealca' } }];
  return { deps, change, session: () => session, sends: () => sends };
}

for (const [status, stage] of [['En oficina', 'esperando_retiro'], ['Entregado', 'entregado'], ['En novedad', 'novedad'], ['Pendiente de devolución', 'pendiente_devolucion']]) {
  test(`${status}: actualiza la etapa aunque WhatsApp falle y reintenta sin exigir la etapa anterior`, async () => {
    const f = fixture();
    const first = await auto.processChanges(f.change(status), f.deps);
    assert.equal(f.session().stage, stage);
    assert.equal(first.results[0].sent, false);
    assert.deepEqual(first.acknowledged, []);
    const retry = await auto.processChanges(f.change(status), f.deps);
    assert.equal(f.sends(), 2);
    assert.equal(retry.results[0].sent, true);
    assert.deepEqual(retry.acknowledged, ['k123']);
  });
}

test('un aviso de despacho fallido se reintenta con la misma guía estando ya en camino', async () => {
  const f = fixture('esperando_guia');
  await auto.processChanges(f.change('En camino'), f.deps);
  assert.equal(f.session().stage, 'en_camino');
  const retry = await auto.processChanges(f.change('En camino'), f.deps);
  assert.equal(f.sends(), 2);
  assert.equal(retry.results[0].sent, true);
});

for (const [status, stage] of [['Devolución', 'devolucion'], ['Devuelto', 'devolucion'], ['Pagado', 'entregado']]) {
  test(`${status}: sincroniza sin enviar avisos de despacho ni agradecimientos retroactivos`, async () => {
    const f = fixture('esperando_retiro');
    const result = await auto.processChanges(f.change(status), f.deps);
    assert.equal(f.session().stage, stage);
    assert.equal(f.sends(), 0);
    assert.deepEqual(result.acknowledged, ['k123']);
  });
}

test('en oficina puede recuperar esperando guía si la guía del mismo pedido ya está vinculada', async () => {
  const f = fixture('esperando_guia');
  await auto.processChanges(f.change('En oficina'), f.deps);
  assert.equal(f.session().stage, 'esperando_retiro');
});

test('una orden distinta no puede usar una guía igual para pisar el pedido activo', () => {
  assert.equal(auto.guideRelation({ card: { guia: 'G123', dropanasId: '123' } }, { guia: 'G123', dropanasId: '999' }).kind, 'different');
});

test('pedido ya vinculado se reconoce aunque falten el nombre y el teléfono en el webhook', async () => {
  const f = fixture();
  const change = f.change('Entregado');
  delete change[0].order.telefono;
  await auto.processChanges(change, f.deps);
  assert.equal(f.session().stage, 'entregado');
});

test('un estado sin guía en el webhook usa el vínculo de pedido ya guardado', async () => {
  const f = fixture();
  const change = f.change('Entregado');
  delete change[0].order.guia;
  await auto.processChanges(change, f.deps);
  assert.equal(f.session().stage, 'entregado');
});

test('sin guía ni vínculo de orden no basta coincidir por teléfono para cambiar la etapa', async () => {
  const f = fixture();
  f.session().card.dropanasId = null;
  const change = f.change('Entregado');
  delete change[0].order.guia;
  const result = await auto.processChanges(change, f.deps);
  assert.equal(f.session().stage, 'en_camino');
  assert.equal(f.sends(), 0);
  assert.equal(result.results[0].reason, 'guia_no_coincide');
});

test('un evento de oficina no retrocede un pedido entregado', async () => {
  const f = fixture('entregado');
  await auto.processChanges(f.change('En oficina'), f.deps);
  assert.equal(f.session().stage, 'entregado');
  assert.equal(f.sends(), 0);
});

test('un evento del pedido viejo no pisa una compra nueva pendiente', async () => {
  const f = fixture();
  f.deps.updateSession('x', { newOrderPending: true });
  await auto.processChanges(f.change('Entregado'), f.deps);
  assert.equal(f.session().stage, 'en_camino');
  assert.equal(f.sends(), 0);
});

'use strict';
// Avisos automaticos de DroPanas (llegada, entregado, despacho) cuando la guia
// cambia de la interna "DP<orden>" a la real de la transportadora, cuando
// llegan varios eventos juntos, y cuando el estado no amerita aviso de
// despacho. Datos simulados, sin red.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-avisos-guia-real');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const auto = require('../src/dropanasAuto');

after(() => cleanup(dataDir));

const ENV = { DROPANAS_AUTO_SEND_ENABLED: 'true' };

test('reconoce la guia real de la transportadora como el mismo pedido que DP<orden>', () => {
  const s = (guia, extra = {}) => ({ card: { guia, ...extra } });
  assert.deepEqual(auto.guideRelation(s('DP34695'), { dropanasId: '34695', guia: '84799843' }),
    { kind: 'upgrade', from: 'DP34695', to: '84799843' });
  assert.equal(auto.guideRelation(s('84799843'), { dropanasId: '34695', guia: '84799843' }).kind, 'same');
  assert.equal(auto.guideRelation(s('dp34695'), { dropanasId: '34695', guia: 'DP34695' }).kind, 'same');
  // Guia DP de OTRA orden: puede ser otra compra, no se asume nada.
  assert.equal(auto.guideRelation(s('DP35592'), { dropanasId: '36235', guia: '84822279' }).kind, 'different');
  // La sesion tiene guia real y llega una DP sin prueba de que sea la misma orden.
  assert.equal(auto.guideRelation(s('84840437'), { dropanasId: '37223', guia: 'DP37223' }).kind, 'different');
  // Con el numero de orden guardado si se sabe que es la misma, y nunca se baja a DP.
  assert.equal(auto.guideRelation(s('84840437', { dropanasId: '37223' }), { dropanasId: '37223', guia: 'DP37223' }).kind, 'same');
  assert.equal(auto.guideRelation({ card: {} }, { dropanasId: '1', guia: 'X' }).kind, 'none');
});

test('en oficina con guia real avisa la llegada y actualiza la guia de la conversacion', async () => {
  const updates = [];
  let notifiedWith = null;
  const session = { phone: '584120000100', stage: 'en_camino', card: { guia: 'DP500', nombre: 'Ana Perez' } };
  const result = await auto.processChanges(
    [{ key: 'a1', order: { dropanasId: '500', guia: '84800500', telefono: '04120000100', estadoPedido: 'En oficina', carrier: 'tealca' } }],
    {
      env: ENV,
      matchRows: (rows) => rows,
      listSessions: () => [session],
      updateSession: (_phone, patch) => { updates.push(patch); return { ...session, ...patch }; },
      maybeNotifyArrival: async (_phone, s) => { notifiedWith = s; return { sent: true, viaTemplate: true }; },
    }
  );
  assert.equal(result.results[0].sent, true);
  assert.deepEqual(result.acknowledged, ['a1']);
  assert.equal(updates[0].card.guia, '84800500');
  assert.equal(updates[0].card.guiaDropanas, 'DP500');
  assert.equal(updates[0].card.dropanasId, '500');
  assert.equal(updates[0].card.nombre, 'Ana Perez');
  assert.equal(notifiedWith.card.guia, '84800500');
  assert.equal(updates[1].stage, 'esperando_retiro');
});

test('entregado con guia real del mismo pedido manda el agradecimiento', async () => {
  let notified = 0;
  const session = { phone: '584120000101', stage: 'esperando_retiro', card: { guia: 'DP501' } };
  const result = await auto.processChanges(
    [{ key: 'a2', order: { dropanasId: '501', guia: '84800501', telefono: '04120000101', estadoPedido: 'Entregado', carrier: 'tealca' } }],
    {
      env: ENV,
      matchRows: (rows) => rows,
      listSessions: () => [session],
      updateSession: (_phone, patch) => ({ ...session, ...patch }),
      maybeNotifyDelivered: async () => { notified += 1; return { sent: true, viaTemplate: true }; },
    }
  );
  assert.equal(notified, 1);
  assert.deepEqual(result.acknowledged, ['a2']);
});

test('una guia de otra orden sigue quedando para revision manual', async () => {
  let notified = 0;
  let updated = false;
  const result = await auto.processChanges(
    [{ key: 'a3', order: { dropanasId: '36235', guia: '84822279', telefono: '04120000102', estadoPedido: 'Entregado', carrier: 'tealca' } }],
    {
      env: ENV,
      matchRows: (rows) => rows,
      listSessions: () => [{ phone: '584120000102', stage: 'esperando_retiro', card: { guia: 'DP35592' } }],
      updateSession: () => { updated = true; },
      maybeNotifyDelivered: async () => { notified += 1; return { sent: true }; },
    }
  );
  assert.equal(result.results[0].reason, 'guia_no_coincide');
  assert.equal(notified, 0);
  assert.equal(updated, false);
  assert.deepEqual(result.acknowledged, []);
});

test('varios eventos al mismo tiempo se procesan todos (antes se perdian)', async () => {
  const sessions = [1, 2, 3].map((n) => ({ phone: `58412000020${n}`, stage: 'en_camino', card: { guia: `G20${n}` } }));
  const sent = [];
  const overrides = {
    env: ENV,
    matchRows: (rows) => rows,
    listSessions: () => sessions,
    updateSession: () => ({}),
    maybeNotifyDelivered: async (phone) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      sent.push(phone);
      return { sent: true, viaTemplate: true };
    },
  };
  const calls = [1, 2, 3].map((n) => auto.processChanges(
    [{ key: `c${n}`, order: { dropanasId: `20${n}`, guia: `G20${n}`, telefono: `0412000020${n}`, estadoPedido: 'Entregado', carrier: 'tealca' } }],
    overrides
  ));
  const results = await Promise.all(calls);
  assert.deepEqual(results.map((r) => r.acknowledged), [['c1'], ['c2'], ['c3']]);
  assert.equal(sent.length, 3);
  assert.equal(auto.status().running, false);
});

test('un pedido cancelado no recibe el aviso de despacho', async () => {
  let captured = false;
  const result = await auto.processChanges(
    [{ key: 'a4', order: { dropanasId: '504', guia: '84800504', carrier: 'tealca', estadoPedido: 'Cancelado' } }],
    {
      env: ENV,
      matchRows: (rows) => rows.map((row) => ({ ...row, matchType: 'exacto', phone: '584120000104', shippingStage: 'vendido', sendEligible: true })),
      capture: async () => { captured = true; return { filename: 'x.png' }; },
    }
  );
  assert.equal(result.results[0].reason, 'estado_sin_aviso_de_despacho');
  assert.equal(captured, false);
});

test('una venta en "vendido" recibe el aviso de despacho de su primera guia', async () => {
  const result = await auto.processChanges(
    [{ key: 'a5', order: { dropanasId: '505', guia: 'DP505', carrier: 'tealca', estadoPedido: 'Generada' } }],
    {
      env: ENV,
      matchRows: (rows) => rows.map((row) => ({ ...row, matchType: 'exacto', phone: '584120000105', shippingStage: 'vendido', sendEligible: true })),
      getSession: () => ({ stage: 'vendido', card: {} }),
      detectOrderConflict: () => null,
      capture: async () => ({ filename: 'guias/505.png' }),
      mediaUrl: (f) => `https://bot.example/media/${f}`,
      updateSession: (_phone, patch) => ({ ...patch }),
      maybeNotifyShipping: async () => ({ sent: true }),
    }
  );
  assert.equal(result.results[0].sent, true);
  assert.deepEqual(result.acknowledged, ['a5']);
});

test('guia real de un pedido ya avisado: se actualiza sin repetir el aviso de despacho', async () => {
  const updates = [];
  let shipped = 0;
  const current = { phone: '584120000106', stage: 'en_camino', shippingNotifiedAt: '2026-09-20T00:00:00Z', card: { guia: 'DP506' } };
  const result = await auto.processChanges(
    [{ key: 'a6', order: { dropanasId: '506', guia: '84800506', carrier: 'tealca', estadoPedido: 'Generada' } }],
    {
      env: ENV,
      matchRows: (rows) => rows.map((row) => ({ ...row, matchType: 'exacto', phone: '584120000106', shippingStage: 'en_camino', sendEligible: false })),
      getSession: () => current,
      updateSession: (_phone, patch) => { updates.push(patch); return { ...current, ...patch }; },
      maybeNotifyShipping: async () => { shipped += 1; return { sent: true }; },
    }
  );
  assert.equal(result.results[0].reason, 'guia_actualizada');
  assert.deepEqual(result.acknowledged, ['a6']);
  assert.equal(shipped, 0);
  assert.equal(updates[0].card.guia, '84800506');
});

test('guia real de un pedido en camino que nunca fue avisado: manda el aviso con la guia real', async () => {
  let shippedWith = null;
  const current = { phone: '584120000107', stage: 'en_camino', card: { guia: 'DP507' } };
  const result = await auto.processChanges(
    [{ key: 'a7', order: { dropanasId: '507', guia: '84800507', carrier: 'tealca', estadoPedido: 'Generada' } }],
    {
      env: ENV,
      matchRows: (rows) => rows.map((row) => ({ ...row, matchType: 'exacto', phone: '584120000107', shippingStage: 'en_camino', sendEligible: false })),
      getSession: () => current,
      detectOrderConflict: () => { throw new Error('no deberia consultarse: es el mismo pedido'); },
      capture: async () => ({ filename: 'guias/507.png' }),
      mediaUrl: (f) => `https://bot.example/media/${f}`,
      updateSession: (_phone, patch) => ({ ...current, ...patch }),
      maybeNotifyShipping: async (_phone, s) => { shippedWith = s; return { sent: true }; },
    }
  );
  assert.equal(result.results[0].sent, true);
  assert.equal(shippedWith.card.guia, '84800507');
  assert.equal(shippedWith.card.guiaDropanas, 'DP507');
  assert.deepEqual(result.acknowledged, ['a7']);
});

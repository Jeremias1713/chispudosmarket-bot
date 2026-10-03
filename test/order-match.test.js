// Cruce pedido DroPanas <-> conversacion (orderMatch.js) usando los datos que
// el cliente le dio al bot.
'use strict';
const { setupTempDataDir, writeJson, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('order-match');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { matchOrder, sessionIdentity } = require('../src/orderMatch');
const dropanas = require('../src/dropanas');

after(() => cleanup(dataDir));

const ses = (phone, extra = {}) => ({
  phone, stage: 'vendido', orderClosed: true, name: null, history: [],
  card: { nombre: null, telefono: null, cedula: null, guia: null }, ...extra,
});

test('BUG DE HOY: el cliente escribe desde un numero y da otro para el pedido -> exacto por telefono', () => {
  const s = ses('584121111111', { card: { nombre: 'Maria Lopez', telefono: '0414-2222222' } });
  const r = matchOrder({ dropanasId: '9', guia: 'G1', cliente: 'Otro Nombre', telefono: '04142222222' }, [s]);
  assert.equal(r.matchType, 'exacto');
  assert.equal(r.evidence, 'telefono');
  assert.equal(r.phone, '584121111111');
});

test('el mismo caso por el camino de dropanas.matchRow (integracion)', () => {
  writeJson(dataDir, 'sessions.json', { '584121111111': ses('584121111111', { card: { nombre: 'Maria Lopez', telefono: '0414-2222222' } }) });
  const r = dropanas.matchRow({ dropanasId: '9', guia: 'G1', cliente: 'Zzz Yyy', telefono: '584142222222' });
  assert.equal(r.matchType, 'exacto');
  assert.equal(r.matchEvidence, 'telefono');
  assert.equal(r.phone, '584121111111');
  assert.equal(r.sendEligible, true);
});

test('numero de orden gana aunque telefono y nombre no coincidan', () => {
  const s = ses('584120000001', { dropanasOrder: { id: 555 }, card: { nombre: 'Ana Gomez' } });
  const r = matchOrder({ dropanasId: '555', guia: 'X', cliente: 'Nadie Parecido', telefono: '04169999999' }, [s, ses('584120000002')]);
  assert.equal(r.evidence, 'orden');
  assert.equal(r.phone, '584120000001');
});

test('referencia externa igual, y por forma CHISPUDOS-<10 digitos>-<stamp>', () => {
  const s = ses('584120000001', { dropanasOrder: { id: 1, externalReference: 'CHISPUDOS-4120000001-20261001' } });
  assert.equal(matchOrder({ dropanasId: '2', externalReference: 'CHISPUDOS-4120000001-20261001' }, [s]).evidence, 'referencia');
  const t = ses('584167778899');
  assert.equal(matchOrder({ dropanasId: '3', externalReference: 'CHISPUDOS-4167778899-20270101' }, [t]).evidence, 'referencia_telefono');
});

test('guia igual o DP<id> de la orden', () => {
  const s = ses('584120000001', { card: { guia: 'ab123' } });
  assert.equal(matchOrder({ dropanasId: '7', guia: 'AB123' }, [s]).evidence, 'guia');
  const t = ses('584120000002', { card: { dropanasId: '77' } });
  assert.ok(['orden', 'guia'].includes(matchOrder({ dropanasId: '8', guia: 'DP77' }, [t]).evidence));
});

test('dos chats con el mismo telefono: desempata por etapa (en_camino vs perdido)', () => {
  const a = ses('584120000001', { stage: 'en_camino', card: { telefono: '04141234567' } });
  const b = ses('584120000002', { stage: 'perdido', orderClosed: false, card: { telefono: '04141234567' } });
  const r = matchOrder({ dropanasId: '1', telefono: '584141234567', cliente: 'X' }, [a, b]);
  assert.equal(r.matchType, 'exacto');
  assert.equal(r.evidence, 'telefono+etapa');
  assert.equal(r.phone, '584120000001');
});

test('dos chats con el mismo telefono: desempata por cedula y por nombre; si no, ambiguo', () => {
  const a = ses('584120000001', { card: { telefono: '04141234567', cedula: 'V-11.111.111', nombre: 'Pedro Ruiz' } });
  const b = ses('584120000002', { card: { telefono: '04141234567', cedula: 'V-22.222.222', nombre: 'Luis Mora' } });
  assert.equal(matchOrder({ telefono: '04141234567', cedula: '22222222' }, [a, b]).evidence, 'telefono+cedula');
  assert.equal(matchOrder({ telefono: '04141234567', cliente: 'Luis Mora' }, [a, b]).evidence, 'telefono+nombre');
  assert.equal(matchOrder({ telefono: '04141234567', cliente: 'Zzz' }, [a, b]).matchType, 'ambiguo');
});

test('nombre del perfil de WhatsApp, sin card.nombre, con pedido cerrado -> exacto por nombre', () => {
  const s = ses('584120000001', { name: 'José Velásquez' });
  const r = matchOrder({ dropanasId: '1', cliente: 'Jose Gregorio Velasquez' }, [s]);
  assert.equal(r.matchType, 'exacto');
  assert.equal(r.evidence, 'nombre');
});

test('un lead (sin pedido cerrado) NO se matchea por nombre', () => {
  const lead = ses('584120000001', { stage: 'nuevo', orderClosed: false, card: { nombre: 'Jose Velasquez' } });
  assert.equal(matchOrder({ cliente: 'Jose Velasquez' }, [lead]).matchType, 'sin_match');
});

test('cedula V-12.345.678 contra 12345678 -> exacto por cedula', () => {
  const s = ses('584120000001', { card: { cedula: 'V-12.345.678', nombre: 'Algo Distinto' } });
  const r = matchOrder({ dropanasId: '1', cedula: '12345678', cliente: 'Otro Nombre' }, [s]);
  assert.equal(r.evidence, 'cedula');
});

test('"Ana" contra "Ana Maria" es ambiguo, nunca exacto', () => {
  const s = ses('584120000001', { card: { nombre: 'Ana Maria' } });
  const r = matchOrder({ cliente: 'Ana' }, [s]);
  assert.equal(r.matchType, 'ambiguo');
});

test('sessionIdentity junta todo y no incluye BSUID como telefono', () => {
  const id = sessionIdentity({
    phone: 'CO.1076333752055749', name: 'Pedro',
    card: { telefono: '0412-5550000', cedula: 'E-1.234.567', guia: 'abc', dropanasId: '5' },
    dropanasOrderEdit: { telefono: '04165551111', nombre: 'Pedro', apellido: 'Paez', cedula: '7654321' },
    dropanasOrderHistory: [{ id: 3, externalReference: 'R3' }],
  });
  assert.deepEqual(id.phones.sort(), ['584125550000', '584165551111']);
  assert.deepEqual(id.cedulas.sort(), ['1234567', '7654321']);
  assert.deepEqual(id.orderIds.sort(), ['3', '5']);
  assert.ok(id.names.includes('Pedro Paez'));
  assert.deepEqual(id.guias, ['ABC']);
});

const auto = require('../src/dropanasAuto');

test('dropanasAuto: cruce por telefono dado en el chat, avisa y aprende card.dropanasId', async () => {
  let patch = null;
  let avisos = 0;
  const s = { phone: '584121111111', stage: 'en_camino', card: { guia: 'ABC1', telefono: '04142222222', nombre: 'X Y' } };
  const result = await auto.processChanges(
    [{ key: 'k1', order: { dropanasId: '31', guia: 'ABC1', telefono: '584142222222', cliente: 'Nadie', estadoPedido: 'En oficina', carrier: 'tealca' } }],
    {
      env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
      matchRows: (rows) => rows,
      listSessions: () => [s],
      updateSession: (_p, p) => { patch = p; return { ...s, ...p }; },
      maybeNotifyArrival: async () => { avisos += 1; return { sent: true }; },
    }
  );
  assert.equal(avisos, 1);
  assert.deepEqual(result.acknowledged, ['k1']);
  assert.equal(patch.card.dropanasId, '31');
});

test('dropanasAuto: pedido ambiguo avisa por push una sola vez por pedido', async () => {
  const pushes = [];
  const a = { phone: '584120000001', stage: 'en_camino', orderClosed: true, card: { nombre: 'Ana Maria' } };
  const b = { phone: '584120000002', stage: 'en_camino', orderClosed: true, card: { nombre: 'Ana Isabel' } };
  const run = () => auto.processChanges(
    [{ key: 'k2', order: { dropanasId: '40', guia: 'ZZZ', cliente: 'Ana', estadoPedido: 'En oficina', carrier: 'tealca' } }],
    { env: { DROPANAS_AUTO_SEND_ENABLED: 'true' }, matchRows: (rows) => rows, listSessions: () => [a, b], notifyAdmin: (t, body) => pushes.push(body) }
  );
  const r1 = await run();
  await run();
  assert.equal(r1.results[0].reason, 'requiere_revision');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /40/);
});

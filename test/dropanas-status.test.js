'use strict';
// S1: tabla unica de estados DroPanas. "Pagado" = retiro y pago (entregado sin
// mensaje), "Devuelto" = devolucion desde cualquier etapa, cancelado = push y
// sin cambio de etapa, estados raros = quedan registrados para el panel.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-status');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { classifyStatus, statusRank } = require('../src/dropanasStatus');
const auto = require('../src/dropanasAuto');
const monitor = require('../src/dropanasMonitor');

after(() => cleanup(dataDir));

test('cada estado de la tabla se clasifica bien (sin tildes ni mayusculas)', () => {
  const cases = {
    Entregado: ['delivered', 'entregado'], ENTREGADA: ['delivered', 'entregado'],
    Pagado: ['delivered', 'entregado'], pagada: ['delivered', 'entregado'],
    'En oficina': ['in_office', 'esperando_retiro'], 'En agencia': ['in_office', 'esperando_retiro'], 'Listo para retirar': ['in_office', 'esperando_retiro'],
    'En novedad': ['novelty', 'esperando_retiro'], Novedad: ['novelty', 'esperando_retiro'],
    'Pendiente devolución': ['return_pending', 'pendiente_devolucion'], 'Pendiente de devolucion': ['return_pending', 'pendiente_devolucion'],
    Devuelto: ['returned', 'devolucion'], Devuelta: ['returned', 'devolucion'], Devolución: ['returned', 'devolucion'], 'En devolución': ['returned', 'devolucion'],
    Cancelado: ['cancelled', null], Anulada: ['cancelled', null], Rechazado: ['cancelled', null],
    'En tránsito': ['shipped', 'en_camino'], 'En camino': ['shipped', 'en_camino'], Despachado: ['shipped', 'en_camino'],
    'Guia generada': ['shipped', 'en_camino'], 'En ruta': ['shipped', 'en_camino'], Recolectado: ['shipped', 'en_camino'],
    'Algo raro': ['unknown', null], '': ['unknown', null],
  };
  for (const [estado, [kind, stage]] of Object.entries(cases)) {
    const r = classifyStatus(estado, { dropanasPaidMeansDelivered: true });
    assert.equal(r.kind, kind, estado);
    assert.equal(r.stage, stage, estado);
  }
  assert.ok(statusRank('Entregado') > statusRank('En oficina'));
  assert.ok(statusRank('En oficina') > statusRank('En tránsito'));
});

test('"Pagado" con el setting apagado es un estado desconocido', () => {
  assert.equal(classifyStatus('Pagado', { dropanasPaidMeansDelivered: true }).paid, true);
  assert.equal(classifyStatus('Pagado', { dropanasPaidMeansDelivered: false }).kind, 'unknown');
});

function run(session, estado, extra = {}) {
  const calls = { patches: [], delivered: 0, arrival: 0, pushes: [], unknown: [] };
  return auto.processChanges(
    [{ key: 'k1', order: { dropanasId: '70', guia: 'G70', telefono: '04120000070', estadoPedido: estado, carrier: 'tealca' } }],
    {
      env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
      settings: { dropanasPaidMeansDelivered: true },
      matchRows: (rows) => rows,
      listSessions: () => [session],
      updateSession: (_p, patch) => { calls.patches.push(patch); return { ...session, ...patch, card: patch.card || session.card }; },
      maybeNotifyDelivered: async () => { calls.delivered += 1; return { sent: true }; },
      maybeNotifyArrival: async () => { calls.arrival += 1; return { sent: true }; },
      notifyAdmin: (_t, body) => calls.pushes.push(body),
      ...extra,
    }
  ).then((result) => ({ result, calls }));
}

const base = { phone: '584120000070', orderClosed: true, card: { guia: 'G70', nombre: 'Luis' } };

test('chat esperando_retiro + "Pagado": pasa a entregado sin mensaje y se confirma', async () => {
  const { result, calls } = await run({ ...base, stage: 'esperando_retiro' }, 'Pagado');
  assert.equal(calls.delivered, 0);
  const p = calls.patches.find((x) => x.stage);
  assert.equal(p.stage, 'entregado');
  assert.deepEqual(result.acknowledged, ['k1']);
});

test('chat entregado + "Entregado" no reenvia el agradecimiento', async () => {
  const { result, calls } = await run({ ...base, stage: 'entregado' }, 'Entregado');
  assert.equal(calls.delivered, 0);
  assert.equal(result.results[0].reason, 'ya_finalizado');
});

test('chat esperando_retiro + "Entregado": manda el agradecimiento y mueve la etapa', async () => {
  const { calls } = await run({ ...base, stage: 'esperando_retiro' }, 'Entregado');
  assert.equal(calls.delivered, 1);
  assert.equal(calls.patches.find((x) => x.stage).stage, 'entregado');
});

test('chat entregado + "Devuelto": pasa a devolucion sin mensaje', async () => {
  const { result, calls } = await run({ ...base, stage: 'entregado' }, 'Devuelto');
  assert.equal(calls.delivered + calls.arrival, 0);
  assert.equal(calls.patches.find((x) => x.stage).stage, 'devolucion');
  assert.deepEqual(result.acknowledged, ['k1']);
});

test('cancelado: no cambia la etapa, un push por pedido y ack', async () => {
  const { result, calls } = await run({ ...base, stage: 'en_camino' }, 'Anulado');
  assert.equal(calls.patches.length, 0);
  assert.equal(calls.pushes.length, 1);
  assert.deepEqual(result.acknowledged, ['k1']);
  const again = await run({ ...base, stage: 'en_camino' }, 'Anulado');
  assert.equal(again.calls.pushes.length, 0);
});

test('un estado raro queda registrado en unknownStatuses', async () => {
  await run({ ...base, stage: 'en_camino', card: { ...base.card } }, 'Retenido en aduana', {
    matchRows: (rows) => rows.map((r) => ({ ...r, matchType: 'sin_match' })),
  });
  const state = monitor.loadState();
  assert.equal(state.unknownStatuses['Retenido en aduana'].count, 1);
  assert.equal(state.unknownStatuses['Retenido en aduana'].ejemploOrderId, '70');
});

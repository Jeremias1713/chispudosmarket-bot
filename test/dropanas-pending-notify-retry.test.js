'use strict';
// Un aviso (llegada a oficina, entregado, etc.) que dropanasAuto no pudo
// confirmar en su primer intento ya no se pierde para siempre: se reintenta
// solo cada cierto tiempo, sin duplicar avisos ya enviados. Datos simulados,
// sin red.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-pending-notify-retry');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DROPANAS_AUTO_SEND_ENABLED = 'true';
const monitor = require('../src/dropanasMonitor');

after(() => {
  delete process.env.DROPANAS_AUTO_SEND_ENABLED;
  cleanup(dataDir);
});

function queueOrder(id) {
  return monitor.queueWebhookOrder(
    { dropanasId: id, guia: `G-${id}`, estadoPedido: 'En oficina', telefono: '584140000000', cliente: 'Cliente Prueba' },
    new Date().toISOString(),
    'order.status_changed',
  );
}

test('un aviso que falla la primera vez queda pendiente y se reintenta', async () => {
  queueOrder(1001);
  let calls = 0;
  const failing = async () => { calls += 1; return { acknowledged: [], results: [{ sent: false, reason: 'error' }] }; };
  const result = await monitor.retryPendingNotifications({ ignoreQuietHours: true, processChanges: failing });
  assert.equal(result.enabled, true);
  assert.equal(calls, 1);
  assert.equal(monitor.listPending().some((item) => item.order.dropanasId === 1001), true);
});

test('cuando el reintento confirma el aviso, sale de la cola de pendientes', async () => {
  const change = queueOrder(1002);
  const ok = async (items) => ({ acknowledged: items.map((i) => i.key), results: items.map(() => ({ sent: true })) });
  await monitor.retryPendingNotifications({ ignoreQuietHours: true, processChanges: ok });
  assert.equal(monitor.listPending().some((item) => item.key === change.key), false);
});

test('un aviso ya entregado antes (ya_avisado) tambien se saca de la cola sin reenviarlo', async () => {
  const change = queueOrder(1003);
  const already = async (items) => ({ acknowledged: items.map((i) => i.key), results: items.map(() => ({ sent: false, reason: 'ya_avisado' })) });
  await monitor.retryPendingNotifications({ ignoreQuietHours: true, processChanges: already });
  assert.equal(monitor.listPending().some((item) => item.key === change.key), false);
});

// S2: antes eran 8 intentos cada 10 minutos (80 minutos) y despues nunca mas.
test('un pendiente que falla 9 veces sigue programado con backoff', async () => {
  const change = queueOrder(1004);
  let calls = 0;
  const failing = async (items) => { calls += items.filter((i) => i.key === change.key).length; return { acknowledged: [], results: [{ orderId: 1004, sent: false, reason: 'error' }] }; };
  let now = Date.parse(change.detectedAt);
  for (let i = 0; i < 9; i += 1) {
    await monitor.retryPendingNotifications({ ignoreQuietHours: true, now, processChanges: failing });
    now += monitor.backoffMs(i + 1) + 1000;
  }
  assert.equal(calls, 9);
  assert.equal(monitor.listPending().some((item) => item.key === change.key), true);
  const state = monitor.loadState();
  assert.ok(Date.parse(state.pendingNextAttemptAt[change.key]) > Date.parse(change.detectedAt));
});

test('antes del proximo reintento programado no se vuelve a intentar', async () => {
  const change = queueOrder(1007);
  let calls = 0;
  const failing = async (items) => { calls += items.filter((i) => i.key === change.key).length; return { acknowledged: [], results: [{ orderId: 1007, sent: false, reason: 'error' }] }; };
  const t0 = Date.parse(change.detectedAt);
  await monitor.retryPendingNotifications({ ignoreQuietHours: true, now: t0, processChanges: failing });
  await monitor.retryPendingNotifications({ ignoreQuietHours: true, now: t0 + 60 * 1000, processChanges: failing });
  assert.equal(calls, 1);
});

test('un ya_avisado no confirmado se saca de la cola en el primer intento', async () => {
  const change = queueOrder(1008);
  const already = async () => ({ acknowledged: [], results: [{ orderId: 1008, sent: false, reason: 'ya_avisado' }] });
  await monitor.retryPendingNotifications({ ignoreQuietHours: true, processChanges: already });
  assert.equal(monitor.listPending().some((item) => item.key === change.key), false);
  assert.ok(monitor.loadState().dismissed.some((d) => d.key === change.key && d.reason === 'ya_avisado'));
});

test('sin DROPANAS_AUTO_SEND_ENABLED no reintenta nada', async () => {
  delete process.env.DROPANAS_AUTO_SEND_ENABLED;
  queueOrder(1005);
  const result = await monitor.retryPendingNotifications({ ignoreQuietHours: true, processChanges: async () => { throw new Error('no deberia llamarse'); } });
  assert.equal(result.enabled, false);
  process.env.DROPANAS_AUTO_SEND_ENABLED = 'true';
});

test('un aviso de hace mas de 5 dias sale a vencidos y avisa a Jere una vez', async () => {
  const change = queueOrder(1006);
  let calls = 0;
  const pushes = [];
  const later = Date.parse(change.detectedAt) + 6 * 24 * 60 * 60 * 1000;
  await monitor.retryPendingNotifications({ ignoreQuietHours: true,
    now: later,
    notifyAdmin: (_t, body) => pushes.push(body),
    processChanges: async (items) => { calls += items.filter((i) => i.key === change.key).length; return { acknowledged: [], results: [] }; },
  });
  assert.equal(calls, 0);
  assert.equal(monitor.listPending().some((item) => item.key === change.key), false);
  assert.ok(monitor.loadState().expired.some((e) => e.key === change.key), JSON.stringify(monitor.loadState().expired.map((e) => e.key)) + ' ' + change.key);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /vencieron sin enviarse/);
  assert.ok(monitor.status().expired >= 1);
});

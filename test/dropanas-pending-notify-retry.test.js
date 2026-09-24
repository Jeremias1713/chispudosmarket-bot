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

test('deja de reintentar tras el maximo de intentos, sin trabarse', async () => {
  const change = queueOrder(1004);
  let calls = 0;
  const failing = async () => { calls += 1; return { acknowledged: [], results: [{ sent: false, reason: 'error' }] }; };
  for (let i = 0; i < monitor.PENDING_RETRY_MAX + 3; i += 1) {
    await monitor.retryPendingNotifications({ ignoreQuietHours: true, processChanges: failing });
  }
  assert.equal(calls, monitor.PENDING_RETRY_MAX);
  assert.equal(monitor.listPending().some((item) => item.key === change.key), true);
});

test('sin DROPANAS_AUTO_SEND_ENABLED no reintenta nada', async () => {
  delete process.env.DROPANAS_AUTO_SEND_ENABLED;
  queueOrder(1005);
  const result = await monitor.retryPendingNotifications({ ignoreQuietHours: true, processChanges: async () => { throw new Error('no deberia llamarse'); } });
  assert.equal(result.enabled, false);
  process.env.DROPANAS_AUTO_SEND_ENABLED = 'true';
});

test('un aviso de hace mas de 5 dias no se reintenta solo (queda para revisar en el panel)', async () => {
  const change = queueOrder(1006);
  let calls = 0;
  const later = Date.parse(change.detectedAt) + monitor.PENDING_RETRY_MAX_AGE_MS + 60 * 1000;
  await monitor.retryPendingNotifications({ ignoreQuietHours: true,
    now: later,
    processChanges: async (items) => { calls += items.filter((i) => i.key === change.key).length; return { acknowledged: [], results: [] }; },
  });
  assert.equal(calls, 0);
  assert.equal(monitor.listPending().some((item) => item.key === change.key), true);
});

test('de noche (hora de Venezuela) no manda avisos: quedan para las 8:00', async () => {
  const change = queueOrder(1007);
  let calls = 0;
  const processChanges = async (items) => { calls += 1; return { acknowledged: items.map((i) => i.key), results: [] }; };
  const night = await monitor.retryPendingNotifications({ now: '2026-09-24T03:30:00.000Z', processChanges }); // 23:30 VET
  assert.equal(night.quietHours, true);
  assert.equal(calls, 0);
  assert.equal(monitor.listPending().some((item) => item.key === change.key), true);
  await monitor.retryPendingNotifications({ now: '2026-09-24T12:05:00.000Z', processChanges }); // 8:05 VET
  assert.equal(calls, 1);
  assert.equal(monitor.listPending().some((item) => item.key === change.key), false);
  assert.equal(monitor.isQuietHours(new Date('2026-09-24T23:59:00.000Z')), false); // 19:59 VET: todavia se puede
  assert.equal(monitor.isQuietHours(new Date('2026-09-25T00:00:00.000Z')), true); // 20:00 VET: ya no
});

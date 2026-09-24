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
  const result = await monitor.retryPendingNotifications({ processChanges: failing });
  assert.equal(result.enabled, true);
  assert.equal(calls, 1);
  assert.equal(monitor.listPending().some((item) => item.order.dropanasId === 1001), true);
});

test('cuando el reintento confirma el aviso, sale de la cola de pendientes', async () => {
  const change = queueOrder(1002);
  const ok = async (items) => ({ acknowledged: items.map((i) => i.key), results: items.map(() => ({ sent: true })) });
  await monitor.retryPendingNotifications({ processChanges: ok });
  assert.equal(monitor.listPending().some((item) => item.key === change.key), false);
});

test('un aviso ya entregado antes (ya_avisado) tambien se saca de la cola sin reenviarlo', async () => {
  const change = queueOrder(1003);
  const already = async (items) => ({ acknowledged: items.map((i) => i.key), results: items.map(() => ({ sent: false, reason: 'ya_avisado' })) });
  await monitor.retryPendingNotifications({ processChanges: already });
  assert.equal(monitor.listPending().some((item) => item.key === change.key), false);
});

test('deja de reintentar tras el maximo de intentos, sin trabarse', async () => {
  const change = queueOrder(1004);
  let calls = 0;
  const failing = async () => { calls += 1; return { acknowledged: [], results: [{ sent: false, reason: 'error' }] }; };
  for (let i = 0; i < monitor.PENDING_RETRY_MAX + 3; i += 1) {
    await monitor.retryPendingNotifications({ processChanges: failing });
  }
  assert.equal(calls, monitor.PENDING_RETRY_MAX);
  assert.equal(monitor.listPending().some((item) => item.key === change.key), true);
});

test('sin DROPANAS_AUTO_SEND_ENABLED no reintenta nada', async () => {
  delete process.env.DROPANAS_AUTO_SEND_ENABLED;
  queueOrder(1005);
  const result = await monitor.retryPendingNotifications({ processChanges: async () => { throw new Error('no deberia llamarse'); } });
  assert.equal(result.enabled, false);
  process.env.DROPANAS_AUTO_SEND_ENABLED = 'true';
});

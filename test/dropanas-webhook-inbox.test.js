'use strict';
// Webhook de DroPanas: un evento recibido nunca se pierde (se guarda antes de
// responder 200 y se reintenta si falla) y un mismo evento reenviado con otro
// X-DroPanas-Delivery no se procesa dos veces. Datos simulados, sin red.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-webhook-inbox');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.DROPANAS_WEBHOOK_SECRET = 'secreto-de-prueba';
delete process.env.DROPANAS_API_ENABLED;
delete process.env.DROPANAS_AUTO_SEND_ENABLED;
const monitor = require('../src/dropanasMonitor');

after(() => cleanup(dataDir));

test('un webhook que falla queda guardado y se reintenta hasta el máximo', async () => {
  assert.equal(monitor.recordWebhook('d-1', { payload: { evento: 'x' }, bodyHash: 'h-1' }), true);
  let calls = 0;
  const failing = async () => { calls += 1; throw new Error('falla simulada'); };
  await assert.rejects(monitor.processInboxItem('d-1', { process: failing }));
  let item = monitor.loadState().inbox.find((row) => row.deliveryId === 'd-1');
  assert.equal(item.attempts, 1);
  assert.match(monitor.loadState().lastError, /falla simulada/);

  for (let i = 0; i < monitor.INBOX_MAX_ATTEMPTS + 2; i += 1) await monitor.retryInbox({ process: failing });
  item = monitor.loadState().inbox.find((row) => row.deliveryId === 'd-1');
  assert.equal(item.attempts, monitor.INBOX_MAX_ATTEMPTS);
  assert.equal(calls, monitor.INBOX_MAX_ATTEMPTS);
});

test('cuando el reintento funciona, el evento sale de la bandeja', async () => {
  monitor.recordWebhook('d-2', { payload: { evento: 'y' }, bodyHash: 'h-2' });
  await assert.rejects(monitor.processInboxItem('d-2', { process: async () => { throw new Error('una vez'); } }));
  await monitor.retryInbox({ process: async () => ({ ok: true }) });
  assert.equal(monitor.loadState().inbox.some((row) => row.deliveryId === 'd-2'), false);
});

test('el mismo cuerpo con otro X-DroPanas-Delivery se descarta', () => {
  assert.equal(monitor.recordWebhook('d-3', { payload: {}, bodyHash: 'h-3' }), true);
  assert.equal(monitor.recordWebhook('d-3', { payload: {}, bodyHash: 'h-otro' }), false);
  assert.equal(monitor.recordWebhook('d-4', { payload: {}, bodyHash: 'h-3' }), false);
});

test('la ruta /dropanas/webhook guarda el evento y lo procesa', async () => {
  const { app } = require('../src/server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const body = JSON.stringify({
      evento: 'order.delivered',
      timestamp: '2026-09-23T12:00:00Z',
      datos: { orden_id: 5555, cliente: { nombre: 'Prueba', telefono: '04120000000' }, pedido: { transportadora: 'Tealca' } },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = monitor.webhookSignature(Buffer.from(body), process.env.DROPANAS_WEBHOOK_SECRET);
    const send = (delivery) => new Promise((resolve, reject) => {
      const req = http.request({
        port: server.address().port, path: '/dropanas/webhook', method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-dropanas-signature': signature,
          'x-dropanas-timestamp': timestamp, 'x-dropanas-delivery': delivery,
        },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(await send('route-1'), 200);
    // Esperar el procesamiento en segundo plano.
    for (let i = 0; i < 50 && monitor.loadState().inbox.some((row) => row.deliveryId === 'route-1'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = monitor.loadState();
    assert.equal(state.inbox.some((row) => row.deliveryId === 'route-1'), false);
    assert.ok(state.pending.some((change) => change.order?.dropanasId === '5555'));
    // Reenvío del mismo cuerpo con otro delivery: se acepta (200) pero no se duplica.
    const pendingBefore = state.pending.length;
    assert.equal(await send('route-2'), 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(monitor.loadState().pending.length, pendingBefore);
    assert.equal(monitor.loadState().inbox.some((row) => row.deliveryId === 'route-2'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

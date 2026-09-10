// FASE 5 (H35): el webhook ahora tambien procesa `value.statuses` (eventos
// de sent/delivered/read/failed que manda Meta sobre un mensaje que YA
// mandamos nosotros), ademas de `value.messages` (mensajes entrantes de un
// cliente) que ya procesaba antes. Se prueba invocando el handler real de
// la ruta POST /webhook directamente (sin levantar un servidor HTTP ni usar
// la red), con un payload que solo trae `statuses` (sin `messages`), asi no
// se dispara ningun procesamiento del bot/IA.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('server-webhook-status');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { appendMessage, getSession } = require('../src/state');
const { app } = require('../src/server');

after(() => cleanup(dataDir));

function findWebhookHandler() {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/webhook' && l.route.methods.post);
  if (!layer) throw new Error('no se encontro la ruta POST /webhook');
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle; // el ultimo: el handler real, despues de verifyWebhookSignature
}

function fakeReq(body) {
  return { body, get: () => undefined, rawBody: Buffer.from(JSON.stringify(body)) };
}

function fakeRes() {
  return { sendStatus() { return this; } };
}

test('H35 - un evento de status con wamid conocido actualiza el mensaje en sessions.json', async () => {
  const phone = '59172222222';
  appendMessage(phone, 'human', '[plantilla] guia_envio', {
    template: { name: 'guia_envio', wamid: 'wamid.WEBHOOK-1', status: 'sent' },
  });

  const handler = findWebhookHandler();
  const payload = {
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.WEBHOOK-1', status: 'delivered' }] } }] }],
  };
  await handler(fakeReq(payload), fakeRes());

  const session = getSession(phone);
  const msg = session.history[session.history.length - 1];
  assert.equal(msg.template.status, 'delivered');
});

test('H35 - un payload de status vacio o mal formado no rompe el webhook (queda contenido en su propio try/catch)', async () => {
  const handler = findWebhookHandler();
  await assert.doesNotReject(() => handler(fakeReq({ entry: [{}] }), fakeRes()));
  await assert.doesNotReject(() => handler(fakeReq({}), fakeRes()));
});

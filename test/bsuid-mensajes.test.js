// Meta manda algunos mensajes SIN "from" (telefono), solo con "from_user_id"
// (BSUID) cuando el cliente tiene nombre de usuario de WhatsApp. Antes el bot
// los descartaba ("Mensaje entrante sin from, se ignora") y el cliente nunca
// recibia respuesta.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('bsuid-mensajes');
process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
process.env.WHATSAPP_TOKEN = 'x';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { getSession } = require('../src/state');
const { app } = require('../src/server');
const { addressee, isBsuid } = require('../src/whatsapp');

after(() => { cleanup(dataDir); setTimeout(() => process.exit(0), 50).unref(); });

function findWebhookHandler() {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/webhook' && l.route.methods.post);
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle;
}

test('addressee: BSUID usa "recipient", telefono usa "to"', () => {
  assert.deepEqual(addressee('CO.1076333752055749'), { recipient: 'CO.1076333752055749' });
  assert.deepEqual(addressee('PE.1637814447901291'), { recipient: 'PE.1637814447901291' });
  assert.deepEqual(addressee('584121234567'), { to: '584121234567' });
  assert.equal(isBsuid('584121234567'), false);
  assert.equal(isBsuid('US.ENT.1234567'), true);
});

test('un mensaje con from_user_id (sin from) se guarda en un chat con el BSUID como clave', async () => {
  const bsuid = 'CO.1076333752055749';
  const body = {
    entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: 'Pedro' }, user_id: bsuid }],
      messages: [{ from_user_id: bsuid, id: 'wamid.X1', timestamp: '1790913854', type: 'text', text: { body: 'Shilajit' } }],
    } }] }],
  };
  const handler = findWebhookHandler();
  await handler({ body, get: () => undefined, rawBody: Buffer.from(JSON.stringify(body)) }, { sendStatus() { return this; } });
  const session = getSession(bsuid);
  assert.ok(session.history.some((m) => m.role === 'user' && /Shilajit/.test(m.content)), 'el mensaje debe quedar guardado');
  assert.equal(session.name, 'Pedro');
});

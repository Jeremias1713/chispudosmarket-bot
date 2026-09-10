// FASE 5 (H35): state.applyTemplateStatus conecta la logica pura de
// messageStatus.js con sessions.json de verdad -- lo que despues llama el
// webhook (server.js) cuando le llega un evento de status de Meta.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('state-apply-template-status');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { appendMessage, getSession, applyTemplateStatus } = require('../src/state');

after(() => cleanup(dataDir));

test('H35 - applyTemplateStatus encuentra el mensaje por wamid en sessions.json y lo actualiza de verdad', () => {
  const phone = '59171111111';
  appendMessage(phone, 'human', '[plantilla] guia_envio', {
    template: { name: 'guia_envio', origin: 'bot', wamid: 'wamid.REAL-1', status: 'sent' },
  });

  const resultado = applyTemplateStatus({ id: 'wamid.REAL-1', status: 'delivered' });
  assert.equal(resultado.updated, true);

  // Releido desde disco (getSession vuelve a leer sessions.json), no desde
  // una referencia en memoria: confirma que de verdad se persistio.
  const session = getSession(phone);
  const msg = session.history[session.history.length - 1];
  assert.equal(msg.template.status, 'delivered');
});

test('H35 - un wamid desconocido no rompe ni escribe nada raro', () => {
  const resultado = applyTemplateStatus({ id: 'wamid.NO-EXISTE-EN-NINGUN-LADO', status: 'read' });
  assert.equal(resultado.updated, false);
});

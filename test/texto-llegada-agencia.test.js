// El texto libre del aviso de llegada incluye la agencia y el monto; si no se
// conocen, se omiten en vez de escribir "agencia -".
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('texto-llegada');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const whatsapp = require('../src/whatsapp');
const enviados = [];
whatsapp.sendText = async (_to, text) => { enviados.push(text); return {}; };
whatsapp.sendAudioByLink = async () => ({});
const { updateSettings } = require('../src/settings');
const state = require('../src/state');
const shipping = require('../src/shipping');

updateSettings({ audioReplyEnabled: false, audioReplyOnVoice: false });
after(() => cleanup(dataDir));

test('texto de llegada: incluye agencia y monto, y los omite si no se conocen', async () => {
  state.appendMessage('584120000071', 'user', 'hola'); // ventana de 24 h abierta
  state.updateSession('584120000071', { name: 'Rosa', card: { producto: 'Shilajit', guia: 'G71', agencia: 'Tealca Chacao', monto: 900 } });
  await shipping.maybeNotifyArrival('584120000071', state.getSession('584120000071'));
  assert.match(enviados[0], /ya llegó a la agencia Tealca Chacao/);
  assert.match(enviados[0], /Número de guía: G71/);
  assert.match(enviados[0], /Monto a pagar al retirar: /);

  state.appendMessage('584120000072', 'user', 'hola');
  state.updateSession('584120000072', { name: 'Luis', card: { producto: 'Maca', guia: 'G72' } });
  await shipping.maybeNotifyArrival('584120000072', state.getSession('584120000072'));
  assert.doesNotMatch(enviados[1], /agencia -|\{\{/);
  assert.match(enviados[1], /ya llegó a la agencia y está listo/);
  assert.doesNotMatch(enviados[1], /Monto a pagar/);
});

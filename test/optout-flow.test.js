// Un cliente que pide "no me escriban mas" queda con optOut, recibe UNA
// confirmacion y la IA no corre en ese turno.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('optout-flow');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const whatsapp = require('../src/whatsapp');
const enviados = [];
whatsapp.sendText = async (to, text) => { enviados.push({ to, text }); return {}; };
whatsapp.sendAudioByLink = async () => ({});
const ai = require('../src/ai');
let iaLlamada = 0;
for (const k of Object.keys(ai)) if (typeof ai[k] === 'function') { const f = ai[k]; ai[k] = async (...a) => { iaLlamada += 1; return f(...a); }; }
const { updateSettings } = require('../src/settings');
const state = require('../src/state');
const flow = require('../src/flow');

after(() => cleanup(dataDir));

test('opt-out por texto: marca la sesion, confirma una vez y no llama a la IA', async () => {
  updateSettings({ botEnabled: true, audioReplyEnabled: false, audioReplyOnVoice: false });
  const phone = '584120007001';
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'No me escriban más por favor' }, id: 'w1' }, 'Ana');
  const s = state.getSession(phone);
  assert.equal(s.optOut, true);
  assert.equal(s.optOutSource, 'cliente');
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].text, /no te enviaremos/i);
  assert.equal(iaLlamada, 0);
});

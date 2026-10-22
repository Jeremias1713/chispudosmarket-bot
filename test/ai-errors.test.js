'use strict';
// Cuando la IA (OpenAI) falla: se registra el motivo, se avisa a Jere una vez por
// hora y al cliente se le pide repetir como mucho una vez cada 30 minutos (antes
// le llegaba el mismo "Disculpa" a cada mensaje).
process.env.SPLIT_GAP_MIN_MS = '5';
process.env.SPLIT_GAP_MAX_MS = '8';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('ai-errors');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const whatsapp = require('../src/whatsapp');
const ai = require('../src/ai');
const classifierMod = require('../src/classifier');
const { updateSettings } = require('../src/settings');
const state = require('../src/state');

updateSettings({ replyDelayMs: 5, audioReplyEnabled: false, audioReplyOnVoice: false });
const sent = [];
whatsapp.sendText = async (to, t) => { sent.push(t); return { messages: [{ id: 'w' }] }; };
whatsapp.sendImageByLink = async () => ({});
classifierMod.classifyConversation = async () => null;
ai.getAssistantReply = async () => { const e = new Error('Rate limit reached for gpt-4o-mini'); e.status = 429; throw e; };
const push = require('../src/push');
const pushes = [];
push.notifyAdmin = async (t, b) => { pushes.push(b); };
const flow = require('../src/flow');
const aiErrors = require('../src/aiErrors');

after(() => cleanup(dataDir));
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));

test('la IA falla 3 veces seguidas: un solo "Disculpa", un solo aviso a Jere y el motivo queda registrado', async () => {
  aiErrors.reset();
  const P = '584125550400';
  state.updateSession(P, { stage: 'interesado', name: 'Jorge', history: [] });
  for (const t of ['hola', 'cuanto cuesta', 'hola??']) {
    await flow.handleIncomingMessage(P, { type: 'text', text: { body: t } }, 'Jorge');
    await wait();
  }
  assert.equal(sent.filter((t) => /tuve un problema para responderte/.test(t)).length, 1);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /por minuto/);
  const s = aiErrors.summary();
  assert.equal(s.ultimas24h, 3);
  assert.equal(s.ultimos[0].kind, 'limite_por_minuto');
});

test('clasifica los motivos tipicos', () => {
  assert.equal(aiErrors.kindOf({ status: 429, code: 'insufficient_quota', message: 'You exceeded your current quota' }), 'sin_saldo');
  assert.equal(aiErrors.kindOf({ status: 401, message: 'Incorrect API key' }), 'clave_invalida');
  assert.equal(aiErrors.kindOf({ status: 503, message: 'Service unavailable' }), 'openai_caido');
  assert.equal(aiErrors.kindOf({ message: 'Request timed out.' }), 'red_o_demora');
});

// El candado (stageLocked) es solo de una persona: con candado el clasificador
// sigue actualizando la ficha pero no cambia la etapa; con pedido vinculado a
// DroPanas el clasificador no mueve la logistica.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('flow-candado');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const whatsapp = require('../src/whatsapp');
const ai = require('../src/ai');
const classifierMod = require('../src/classifier');
const { updateSettings } = require('../src/settings');
const state = require('../src/state');

updateSettings({ replyDelayMs: 5, splitGapMinMs: 5, splitGapMaxMs: 8, audioReplyEnabled: false, audioReplyOnVoice: false });
whatsapp.sendText = async () => ({ messages: [{ id: 'w' }] });
whatsapp.sendAudioByLink = async () => ({});
let classification = null;
classifierMod.classifyConversation = async () => classification;
ai.getAssistantReply = async () => ({ text: 'Claro, dime.', images: [] });
const flow = require('../src/flow');
after(() => cleanup(dataDir));
const espera = (ms = 200) => new Promise((r) => setTimeout(r, ms));

test('con candado manual: la ficha se actualiza, la etapa no', async () => {
  const phone = '584120006001';
  state.updateSession(phone, { stage: 'interesado', stageLocked: true, card: { ciudad: null } });
  classification = { stage: 'vendido', razon: 'x', card: { ciudad: 'Maracaibo' } };
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'vivo en Maracaibo' } }, 'Ana');
  await espera();
  const s = state.getSession(phone);
  assert.equal(s.stage, 'interesado');
  assert.equal(s.card.ciudad, 'Maracaibo');
});

test('chat que antes DroPanas dejaba bloqueado ahora sigue actualizando la ficha', async () => {
  const phone = '584120006002';
  state.updateSession(phone, { stage: 'esperando_retiro', stageLocked: false, stageSource: 'dropanas', card: { guia: 'G9', dropanasId: '9', nombre: 'Luis' } });
  classification = { stage: 'esperando_retiro', razon: 'x', card: { ciudad: 'Valencia' } };
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'hola' } }, 'Luis');
  await espera();
  assert.equal(state.getSession(phone).card.ciudad, 'Valencia');
});

test('con pedido vinculado, el clasificador no manda el chat a entregado sin confirmacion del cliente', async () => {
  const phone = '584120006003';
  state.updateSession(phone, { stage: 'esperando_retiro', card: { guia: 'G10', dropanasId: '10' } });
  classification = { stage: 'entregado', razon: 'x', card: {} };
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'gracias' } }, 'Luis');
  await espera();
  assert.equal(state.getSession(phone).stage, 'esperando_retiro');
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'ya lo retire, gracias' } }, 'Luis');
  await espera();
  assert.equal(state.getSession(phone).stage, 'entregado');
});

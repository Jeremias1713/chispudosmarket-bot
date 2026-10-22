'use strict';
// La plantilla ultimo_aviso_retiro_pedido puede estar aprobada SIN botones: el
// cliente contesta escribiendo. Se reconocen sus palabras y, si escribe otra
// cosa, se le ofrecen los 3 botones una vez (la IA igual contesta).
process.env.SPLIT_GAP_MIN_MS = '5';
process.env.SPLIT_GAP_MAX_MS = '8';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('last-notice-sin-botones');
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const whatsapp = require('../src/whatsapp');
const ai = require('../src/ai');
const classifierMod = require('../src/classifier');
const { updateSettings } = require('../src/settings');
const state = require('../src/state');

updateSettings({ replyDelayMs: 5, audioReplyEnabled: false, audioReplyOnVoice: false });
const texts = [];
const buttons = [];
whatsapp.sendText = async (to, t) => { texts.push(t); return { messages: [{ id: 'w' }] }; };
whatsapp.sendButtons = async (to, t, b) => { buttons.push({ t, b }); return { messages: [{ id: 'wb' }] }; };
whatsapp.sendImageByLink = async () => ({});
classifierMod.classifyConversation = async () => null;
let aiCalls = 0;
ai.getAssistantReply = async () => { aiCalls += 1; return { text: 'La agencia abre de 8 a 5.', images: [] }; };
const push = require('../src/push');
push.notifyAdmin = async () => {};
const flow = require('../src/flow');
const lastNotice = require('../src/lastNotice');

after(() => cleanup(dataDir));
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const P = '584125550300';

beforeEach(() => {
  texts.length = 0; buttons.length = 0; aiCalls = 0;
  state.updateSession(P, {
    stage: 'esperando_retiro', name: 'Ana', paused: false, orderClosed: true,
    history: [{ role: 'human', content: '[ultimo aviso] ultimo_aviso_retiro_pedido', at: new Date().toISOString() }],
    card: { guia: 'G300', producto: 'Shilajit' },
    lastNoticeSentAt: new Date().toISOString(), lastNoticeGuia: 'G300', lastNoticeVia: 'template',
    lastNoticeAnswer: null, lastNoticeButtonsOfferedAt: null, returnReasonAskedAt: null,
  });
});

test('escribe "ya no lo quiero": cuenta como el boton (pendiente de devolucion, sin IA)', async () => {
  await flow.handleIncomingMessage(P, { type: 'text', text: { body: 'Ya no lo quiero, gracias' } }, 'Ana');
  await wait();
  const s = state.getSession(P);
  assert.equal(s.lastNoticeAnswer, 'cancel');
  assert.equal(s.stage, 'pendiente_devolucion');
  assert.equal(aiCalls, 0);
});

test('escribe "mañana lo retiro": cuenta como "Voy a retirarlo"', async () => {
  await flow.handleIncomingMessage(P, { type: 'text', text: { body: 'mañana lo retiro' } }, 'Ana');
  await wait();
  assert.equal(state.getSession(P).lastNoticeAnswer, 'pickup');
  assert.match(texts.join(' '), /Te esperamos/);
});

test('escribe otra cosa: se le ofrecen los 3 botones una sola vez y la IA contesta', async () => {
  await flow.handleIncomingMessage(P, { type: 'text', text: { body: 'a que hora abre la agencia?' } }, 'Ana');
  await wait();
  assert.equal(buttons.length, 1);
  assert.deepEqual(buttons[0].b.map((x) => x.id), ['ld_pickup', 'ld_change', 'ld_cancel']);
  assert.equal(aiCalls, 1);
  await flow.handleIncomingMessage(P, { type: 'text', text: { body: 'y los sabados?' } }, 'Ana');
  await wait();
  assert.equal(buttons.length, 1, 'solo una vez');
});

test('sin ultimo aviso pendiente las mismas palabras no hacen nada especial', () => {
  const s = { ...state.getSession(P), lastNoticeAnswer: 'pickup' };
  assert.equal(lastNotice.idFromText(s, 'ya no lo quiero'), '');
  assert.equal(lastNotice.idFromText({ ...state.getSession(P), lastNoticeGuia: 'OTRA' }, 'ya no lo quiero'), '');
});

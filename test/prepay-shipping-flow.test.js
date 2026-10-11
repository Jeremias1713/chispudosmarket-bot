'use strict';
// Descuento por pagar el envio por adelantado, de punta a punta en flow.js:
// el boton y la captura los atiende prepayShipping, no la IA.
process.env.SPLIT_GAP_MIN_MS = '20';
process.env.SPLIT_GAP_MAX_MS = '30';
const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('prepay-shipping-flow');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const whatsapp = require('../src/whatsapp');
const ai = require('../src/ai');
const classifierMod = require('../src/classifier');
const { updateSettings } = require('../src/settings');
const { getSession } = require('../src/state');

updateSettings({ replyDelayMs: 5, prepayEnabled: true, prepayDiscountPercent: 10, prepayShippingAmount: '450 Bs', prepayPaymentInfo: 'Banco X 0414-0000000' });
const enviados = [];
whatsapp.sendText = async (to, text) => { enviados.push(text); return { messages: [{ id: 'wamid.T' }] }; };
whatsapp.sendButtons = async () => ({});
whatsapp.sendImageByLink = async () => ({});
classifierMod.classifyConversation = async () => null;
let aiCalls = 0;
ai.getAssistantReply = async () => { aiCalls += 1; return { text: 'IA', images: [] }; };
const push = require('../src/push');
push.notifyAdmin = async () => {};
push.notifySale = () => {};
const flow = require('../src/flow');

after(() => cleanup(dataDir));
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const PHONE = '584120000911';
const soldAt = new Date().toISOString();

test('boton "Sí, quiero descuento" y captura: no pasan por la IA', async () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [PHONE]: {
    step: 'IDLE', cart: [], name: 'Ana', stage: 'vendido', orderClosed: true, soldAt, paused: false,
    history: [{ role: 'user', content: 'listo', at: new Date().toISOString() }],
    card: { nombre: 'Ana', producto: 'Shilajit', monto: 50000 },
    prepay: { status: 'offered', soldAt, percent: 10, offeredAt: new Date().toISOString() },
  } }));
  await flow.handleIncomingMessage(PHONE, { type: 'interactive', interactive: { button_reply: { id: 'pp_yes', title: 'Sí, quiero descuento' } } }, 'Ana');
  await wait();
  assert.equal(getSession(PHONE).prepay.status, 'awaiting_payment');
  // El panel muestra que el cliente respondio tocando el boton.
  const tap = getSession(PHONE).history.find((m) => m.role === 'user' && m.buttonReply);
  assert.deepEqual(tap.buttonReply, { id: 'pp_yes', title: 'Sí, quiero descuento' });
  assert.equal(tap.content, 'Sí, quiero descuento');
  assert.match(enviados.join('\n'), /0414-0000000/);
  await flow.handleIncomingMessage(PHONE, { type: 'image', image: { id: 'img1' } }, 'Ana');
  await wait();
  assert.equal(getSession(PHONE).prepay.status, 'receipt_sent');
  assert.match(enviados.at(-1), /Recibido/);
  assert.equal(aiCalls, 0);
});

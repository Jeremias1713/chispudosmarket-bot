// Recompra en el mismo chat: orderClosed quedaba en true para siempre y el
// segundo pedido no marcaba vendido, no ponia soldAt, no subia a DroPanas.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('flow-recompra');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const whatsapp = require('../src/whatsapp');
const ai = require('../src/ai');
const classifierMod = require('../src/classifier');
const { updateSettings } = require('../src/settings');
const state = require('../src/state');

updateSettings({ replyDelayMs: 5, splitGapMinMs: 5, splitGapMaxMs: 8, audioReplyEnabled: false, audioReplyOnVoice: false });

const enviados = [];
whatsapp.sendText = async (to, text) => { enviados.push(text); return { messages: [{ id: 'w' }] }; };
whatsapp.sendImageByLink = async () => ({});
whatsapp.sendAudioByLink = async () => ({});
classifierMod.classifyConversation = async () => null;
let reply = '';
ai.getAssistantReply = async () => ({ text: reply, images: [] });

const flow = require('../src/flow');
const push = require('../src/push');
let ventas = 0;
push.notifySale = () => { ventas += 1; };

after(() => cleanup(dataDir));

const CIERRE_1 = 'Listo Maria, tu pedido queda asi: 2 frascos de Shilajit, retiras en Tealca Chacao. El pago es contra entrega. En cuanto tengamos la guia de Tealca te avisamos.';
const CIERRE_2 = 'Listo Maria, tu pedido queda asi: 1 frasco de Shilajit y 1 de Maca, retiras en Tealca Altamira. El pago es contra entrega. En cuanto tengamos la guia de Tealca te avisamos.';

const espera = (ms = 200) => new Promise((r) => setTimeout(r, ms));

function seed(phone, extra) {
  state.updateSession(phone, {
    name: 'Maria', orderClosed: true, soldAt: '2026-09-01T00:00:00.000Z', lastCloseSummary: CIERRE_1,
    arrivalNotifiedAt: '2026-09-10T00:00:00.000Z', shippingNotifiedAt: '2026-09-05T00:00:00.000Z',
    pickupReminderCount: 2, dropanasOrder: { id: 5, externalReference: 'CHISPUDOS-4120000001-1' },
    card: { nombre: 'Maria Perez', cedula: 'V-1234567', telefono: '04120000001', producto: 'Shilajit', guia: 'G1', dropanasId: '5', agencia: 'Chacao', monto: 900 },
    ...extra,
  });
}

test('recompra: venta 1 entregada, el cliente pide de nuevo y el bot manda un cierre con otro resumen -> pedido nuevo', async () => {
  const phone = '584120008001';
  seed(phone, { stage: 'entregado' });
  reply = CIERRE_2;
  ventas = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'quiero otro Shilajit y una maca' } }, 'Maria');
  await espera();
  const s = state.getSession(phone);
  assert.equal(s.stage, 'vendido');
  assert.notEqual(s.soldAt, '2026-09-01T00:00:00.000Z');
  assert.equal(s.previousOrders.length, 1);
  assert.equal(s.previousOrders[0].card.guia, 'G1');
  assert.equal(s.arrivalNotifiedAt, null);
  assert.equal(s.shippingNotifiedAt, null);
  assert.equal(s.card.guia, null);
  assert.equal(s.card.nombre, 'Maria Perez', 'los datos personales se conservan');
  assert.equal(s.dropanasOrder, null);
  assert.equal(s.dropanasOrderHistory.length, 1);
  assert.equal(s.pickupReminderCount, 0);
  assert.equal(s.stageSource, 'cierre_bot');
  assert.equal(s.lastCloseSummary, CIERRE_2);
  assert.equal(ventas, 1);
  assert.match(enviados.join(' '), /Altamira/, 'el cierre sale completo');
});

test('NO es recompra: pedido en camino y la IA repite el mismo resumen', async () => {
  const phone = '584120008002';
  seed(phone, { stage: 'en_camino' });
  reply = CIERRE_1;
  ventas = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'y cuando llega?' } }, 'Maria');
  await espera();
  const s = state.getSession(phone);
  assert.equal(s.soldAt, '2026-09-01T00:00:00.000Z');
  assert.equal(s.previousOrders, undefined);
  assert.equal(s.arrivalNotifiedAt, '2026-09-10T00:00:00.000Z');
  assert.equal(ventas, 0);
});

test('NO es recompra: el pedido anterior aun no avanzo (vendido) aunque el resumen cambie', async () => {
  const phone = '584120008003';
  seed(phone, { stage: 'vendido' });
  reply = CIERRE_2;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'cambiale la agencia' } }, 'Maria');
  await espera();
  assert.equal(state.getSession(phone).previousOrders, undefined);
});

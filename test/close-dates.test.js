// Fecha estimada al cerrar la venta: antes se le pedia a la IA que la agregara
// al mensaje de cierre y la mayoria de las veces no lo hacia. Ahora la manda
// el codigo en un mensaje fijo, una sola vez por venta.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('close-dates');
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
const push = require('../src/push');
push.notifySale = () => {};
push.notifyAdmin = async () => {};
const flow = require('../src/flow');

after(() => cleanup(dataDir));
const espera = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const CIERRE_1 = 'Listo Maria, tu pedido queda asi: 2 frascos de Shilajit, retiras en Tealca Chacao. El pago es contra entrega. En cuanto tengamos la guia de Tealca te avisamos.';
const CIERRE_2 = 'Listo Maria, tu pedido queda asi: 1 frasco de Shilajit y 1 de Maca, retiras en Tealca Altamira. El pago es contra entrega. En cuanto tengamos la guia de Tealca te avisamos.';

function seed(phone) {
  state.updateSession(phone, {
    name: 'Maria', orderClosed: true, soldAt: '2026-09-01T00:00:00.000Z', lastCloseSummary: CIERRE_1, stage: 'entregado',
    card: { nombre: 'Maria Perez', cedula: 'V-1234567', telefono: '04120000001', producto: 'Shilajit', agencia: 'Chacao', monto: 900 },
  });
}

test('con calendario configurado, al cerrar la venta sale el mensaje con la fecha estimada (una sola vez)', async () => {
  updateSettings({ calendarEnabled: true, dispatchCutoffHour: 15, dispatchOnSaturday: false });
  const phone = '584120009101';
  seed(phone);
  enviados.length = 0;
  reply = CIERRE_2;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'quiero otro Shilajit y una maca' } }, 'Maria');
  await espera();
  const fechas = enviados.filter((t) => /^🚚 Tu pedido sale .+ y llegaría a la agencia .+ \(estimado\)/.test(t));
  assert.equal(fechas.length, 1, enviados.join(' || '));
  assert.equal(state.getSession(phone).closeDatesSoldAt, state.getSession(phone).soldAt);
  // El cliente sigue escribiendo: no se repite.
  reply = 'De nada Maria!';
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'gracias' } }, 'Maria');
  await espera();
  assert.equal(enviados.filter((t) => t.startsWith('🚚')).length, 1);
});

test('sin calendario configurado (falta la hora de corte) no se manda ninguna fecha', async () => {
  updateSettings({ calendarEnabled: true, dispatchCutoffHour: null, dispatchOnSaturday: false });
  const phone = '584120009102';
  seed(phone);
  enviados.length = 0;
  reply = CIERRE_2;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'quiero otro Shilajit y una maca' } }, 'Maria');
  await espera();
  assert.equal(enviados.filter((t) => t.startsWith('🚚')).length, 0);
});

// Caso real (…2494): el bot pregunta "¿Confirmas?", el cliente dice "Si" y la
// venta la marca el CLASIFICADOR, no el cierre deterministico. Por ese camino
// no salian ni la fecha ni la oferta del descuento.
test('venta marcada por el clasificador: tambien salen la fecha y la oferta del descuento', async () => {
  updateSettings({
    calendarEnabled: true, dispatchCutoffHour: 15, dispatchOnSaturday: false,
    prepayEnabled: true, prepayActivatedAt: '2026-01-01T00:00:00.000Z', prepayDiscountPercent: 10,
    prepayShippingAmount: '4000 Bs', prepayPaymentInfo: 'Banco X 0414',
  });
  const botones = [];
  whatsapp.sendButtons = async (to, text, buttons) => { botones.push({ text, buttons }); return { messages: [{ id: 'wb' }] }; };
  const phone = '584120009103';
  state.updateSession(phone, {
    name: 'Jeison', stage: 'negociando', orderClosed: false, soldAt: null,
    history: [{ role: 'assistant', content: 'Tendras 5 dias habiles para retirarlo. ¿Confirmas que podras hacerlo en ese plazo?', at: new Date().toISOString() }],
    card: { nombre: 'Jeison Ramirez', cedula: '24018871', telefono: '04165522494', producto: 'Shilajit', ciudad: 'Guanare', monto: 36900 },
  });
  enviados.length = 0;
  reply = '¡Perfecto! Entonces tu pedido esta confirmado.';
  classifierMod.classifyConversation = async () => ({ stage: 'vendido', razon: 'confirmo', card: {} });
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'Si perfectamente' } }, 'Jeison');
  await espera(400);
  classifierMod.classifyConversation = async () => null;
  const s = state.getSession(phone);
  assert.equal(s.stage, 'vendido');
  assert.equal(enviados.filter((t) => t.startsWith('🚚')).length, 1, enviados.join(' || '));
  assert.equal(botones.length, 1);
  assert.match(botones[0].text, /3\.690 Bs del producto/);
  assert.equal(s.prepay.status, 'offered');
});

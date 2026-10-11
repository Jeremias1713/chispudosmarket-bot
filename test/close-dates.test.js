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

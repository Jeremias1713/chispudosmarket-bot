'use strict';
// Mensajes con botones: se revisan contra los limites de WhatsApp antes de
// mandarlos y se guardan en el historial con sus botones y su estado
// (enviado/entregado/leido), para que el panel los muestre.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('buttons-panel');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const whatsapp = require('../src/whatsapp');
const { checkButtons, buttonsHistoryExtra } = whatsapp;
const { updateSettings, getSettings } = require('../src/settings');
const { getSession, updateSession } = require('../src/state');
const { applyStatusUpdate } = require('../src/messageStatus');
const prepay = require('../src/prepayShipping');
const orderConfirm = require('../src/orderConfirm');
const lastNotice = require('../src/lastNotice');

after(() => cleanup(dataDir));

test('todos los botones reales del bot cumplen los limites de WhatsApp', () => {
  for (const [nombre, botones] of [
    ['confirmar pedido', orderConfirm.BUTTONS],
    ['ultimo aviso', lastNotice.BUTTONS],
    ['descuento envio', prepay.OFFER_BUTTONS],
  ]) {
    assert.deepEqual(checkButtons('Texto de prueba', botones), [], nombre);
  }
});

test('detecta botones que WhatsApp rechazaria', () => {
  assert.match(checkButtons('x', [{ id: 'a', title: 'Este titulo es demasiado largo' }]).join(), /1 a 20/);
  assert.match(checkButtons('x', [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `B${i}` }))).join(), /4 botones/);
  assert.match(checkButtons('x', [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }]).join(), /id repetido/);
  assert.match(checkButtons('', [{ id: 'a', title: 'A' }]).join(), /vacio/);
  assert.match(checkButtons('x'.repeat(1025), [{ id: 'a', title: 'A' }]).join(), /1024/);
});

test('sendButtons no manda nada si el mensaje es invalido', async () => {
  await assert.rejects(() => whatsapp.sendButtons('584120000000', 'hola', []), /invalido/);
});

test('la oferta del descuento queda en el historial con sus botones y el wamid', async () => {
  const PHONE = '584120000921';
  updateSettings({ prepayEnabled: true, prepayActivatedAt: null, prepayDiscountPercent: 10, prepayShippingAmount: '450 Bs', prepayPaymentInfo: 'Banco X' });
  updateSession(PHONE, {
    stage: 'vendido', orderClosed: true, soldAt: new Date().toISOString(), paused: false,
    history: [{ role: 'user', content: 'listo', at: new Date().toISOString() }],
    card: { nombre: 'Ana', producto: 'Shilajit', monto: 50000 },
  });
  let enviado = null;
  const deps = {
    sendButtons: async (to, text, buttons) => {
      enviado = { text, buttons };
      return { messages: [{ id: 'wamid.BTN1' }] };
    },
    sendText: async () => {}, notifyAdmin: async () => {}, maybeCreate: () => {}, sessions: () => [],
  };
  assert.equal(await prepay.offerAfterClose(PHONE, deps, getSettings()), true);
  // El texto real que ve el cliente tambien cumple los limites.
  assert.deepEqual(checkButtons(enviado.text, enviado.buttons), []);
  const msg = getSession(PHONE).history.at(-1);
  assert.equal(msg.role, 'assistant');
  assert.deepEqual(msg.interactive.buttons.map((b) => b.title), ['Sí, quiero descuento', 'Pago al retirar']);
  assert.equal(msg.interactive.wamid, 'wamid.BTN1');
  assert.equal(msg.interactive.status, 'sent');
});

test('el estado de WhatsApp (entregado, leido, fallo) se aplica al mensaje con botones', () => {
  const sessions = { '58412': { history: [{ role: 'assistant', content: 'x', ...buttonsHistoryExtra([{ id: 'a', title: 'A' }], { messages: [{ id: 'wamid.Z' }] }) }] } };
  assert.equal(applyStatusUpdate(sessions, { id: 'wamid.Z', status: 'delivered' }).updated, true);
  assert.equal(applyStatusUpdate(sessions, { id: 'wamid.Z', status: 'read' }).updated, true);
  assert.equal(sessions['58412'].history[0].interactive.status, 'read');
  // No retrocede de leido a entregado.
  assert.equal(applyStatusUpdate(sessions, { id: 'wamid.Z', status: 'delivered' }).updated, false);
  const s2 = { '1': { history: [{ role: 'assistant', content: 'x', ...buttonsHistoryExtra([{ id: 'a', title: 'A' }], { messages: [{ id: 'wamid.F' }] }) }] } };
  applyStatusUpdate(s2, { id: 'wamid.F', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] });
  assert.equal(s2['1'].history[0].interactive.failReason, 'Re-engagement message');
});

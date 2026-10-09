'use strict';
// Fase 7A: confirmacion del pedido con botones antes de subirlo a DroPanas.
// Nunca se llama a Meta ni a DroPanas: todo el envio se inyecta o se simula.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('order-confirm');
process.env.DROPANAS_AUTO_CREATE_ALLOWED = '1';
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const settingsStore = require('../src/settings');
const orderConfirm = require('../src/orderConfirm');
const automation = require('../src/dropanasOrderAutomation');
const whatsapp = require('../src/whatsapp');

after(() => cleanup(dataDir));

const PHONE = '584141112233';
const NOW = new Date('2026-10-06T14:00:00Z'); // 10:00 Caracas

function seed(extra = {}) {
  state.updateSession(PHONE, {
    name: 'Maria Perez', stage: 'vendido', orderClosed: true, soldAt: '2026-10-06T13:00:00.000Z',
    // La ventana de 24 h usa el reloj real: el mensaje tiene que ser de verdad reciente
    // (antes era relativo a NOW fijo y el test empezo a fallar a los dias).
    history: [{ role: 'user', content: 'hola', at: new Date(Date.now() - 3600000).toISOString() }],
    card: { nombre: 'Maria Perez', producto: 'Shilajit Viking', monto: 51900, agencia: 'Sabana Grande' },
    orderConfirm: undefined,
    ...extra,
  });
}

function makeDeps() {
  const calls = { buttons: [], push: [] };
  return {
    calls,
    sendButtons: async (to, text, buttons) => { calls.buttons.push({ to, text, buttons }); },
    notifyAdmin: (t, b) => calls.push.push({ t, b }),
    sessions: () => state.listSessions(),
  };
}

beforeEach(() => {
  settingsStore.updateSettings({ orderConfirmEnabled: true, orderConfirmActivatedAt: '2026-10-01T00:00:00.000Z', calendarEnabled: false });
  seed();
});

test('desactivado o venta anterior a la activacion: no bloquea', () => {
  settingsStore.updateSettings({ orderConfirmEnabled: false });
  assert.equal(orderConfirm.gate(state.getSession(PHONE)).ok, true);
  settingsStore.updateSettings({ orderConfirmEnabled: true, orderConfirmActivatedAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(orderConfirm.gate(state.getSession(PHONE)).ok, true);
});

test('activado: bloquea hasta confirmar y la subida automatica devuelve esperando_confirmacion', async () => {
  assert.deepEqual(orderConfirm.gate(state.getSession(PHONE)), { ok: false, reason: 'esperando_confirmacion' });
  automation.saveConfig({ uploadEnabled: true, autoCreateEnabled: true, mappings: automation.defaultMappings() });
  const r = await automation.createForPhone(PHONE, { automatic: true });
  assert.equal(r.reason, 'esperando_confirmacion');
});

test('scheduleForClose programa una sola vez por venta', () => {
  assert.equal(orderConfirm.scheduleForClose(PHONE, NOW), true);
  const first = state.getSession(PHONE).orderConfirm.scheduledFor;
  assert.equal(orderConfirm.scheduleForClose(PHONE, new Date(NOW.getTime() + 60000)), false);
  assert.equal(state.getSession(PHONE).orderConfirm.scheduledFor, first);
  assert.equal(new Date(first) - NOW, 20 * 60000);
});

test('cerca del corte de despacho se confirma mas rapido', () => {
  settingsStore.updateSettings({ calendarEnabled: true, dispatchCutoffHour: 10, dispatchCutoffMinute: 30, dispatchOnSaturday: false });
  orderConfirm.scheduleForClose(PHONE, NOW);
  assert.equal(new Date(state.getSession(PHONE).orderConfirm.scheduledFor) - NOW, 5 * 60000);
});

test('tick envia los botones con los datos de la ficha, una sola vez y marca antes de enviar', async () => {
  orderConfirm.scheduleForClose(PHONE, NOW);
  const deps = makeDeps();
  const later = new Date(NOW.getTime() + 21 * 60000);
  assert.equal((await orderConfirm.tick(later, deps)).sent, 1);
  assert.equal(deps.calls.buttons.length, 1);
  const msg = deps.calls.buttons[0];
  assert.match(msg.text, /Shilajit Viking por 51\.900 Bs/);
  assert.match(msg.text, /Sabana Grande/);
  assert.deepEqual(msg.buttons.map((b) => b.id), ['oc_yes', 'oc_change']);
  assert.equal(state.getSession(PHONE).orderConfirm.status, 'sent');
  await orderConfirm.tick(new Date(later.getTime() + 60000), deps);
  assert.equal(deps.calls.buttons.length, 1);
});

test('con ventana de 24 h cerrada no se envia: se avisa al admin', async () => {
  seed({ history: [{ role: 'user', content: 'hola', at: '2026-10-01T10:00:00.000Z' }] });
  orderConfirm.scheduleForClose(PHONE, NOW);
  const deps = makeDeps();
  // La ventana usa el reloj real; el mensaje del cliente es de hace dias.
  await orderConfirm.tick(new Date(NOW.getTime() + 21 * 60000), deps);
  assert.equal(deps.calls.buttons.length, 0);
  assert.equal(state.getSession(PHONE).orderConfirm.status, 'no_window');
  assert.equal(deps.calls.push.length, 1);
});

test('ficha sin monto: no se inventa nada, queda incompleto', async () => {
  seed({ card: { nombre: 'Maria', producto: 'Shilajit Viking', agencia: 'Sabana Grande' }, history: [{ role: 'user', content: 'hola', at: new Date().toISOString() }] });
  orderConfirm.scheduleForClose(PHONE, NOW);
  const deps = makeDeps();
  await orderConfirm.tick(new Date(NOW.getTime() + 21 * 60000), deps);
  assert.equal(state.getSession(PHONE).orderConfirm.status, 'incomplete');
  assert.equal(deps.calls.buttons.length, 0);
});

test('boton "Si, confirmo" confirma, guarda el monto y libera la subida', async () => {
  const sent = [];
  const orig = whatsapp.sendText;
  whatsapp.sendText = async (to, text) => { sent.push(text); };
  try {
    state.updateSession(PHONE, { orderConfirm: { status: 'sent', sentAt: NOW.toISOString(), monto: 51900 } });
    assert.equal(await orderConfirm.handleReply(PHONE, 'oc_yes', makeDeps()), true);
    const oc = state.getSession(PHONE).orderConfirm;
    assert.equal(oc.status, 'confirmed');
    assert.equal(oc.confirmedBy, 'cliente_boton');
    assert.equal(oc.monto, 51900);
    assert.equal(orderConfirm.gate(state.getSession(PHONE)).ok, true);
    assert.match(sent[0], /confirmado/);
  } finally { whatsapp.sendText = orig; }
});

test('boton "Quiero cambiar algo" avisa y no confirma', async () => {
  const orig = whatsapp.sendText;
  whatsapp.sendText = async () => {};
  try {
    state.updateSession(PHONE, { orderConfirm: { status: 'sent', sentAt: NOW.toISOString() } });
    const deps = makeDeps();
    await orderConfirm.handleReply(PHONE, 'oc_change', deps);
    assert.equal(state.getSession(PHONE).orderConfirm.status, 'change');
    assert.equal(deps.calls.push.length, 1);
    assert.equal(orderConfirm.gate(state.getSession(PHONE)).ok, false);
  } finally { whatsapp.sendText = orig; }
});

test('un "si" escrito confirma solo si hay confirmacion enviada; otro texto no', () => {
  state.updateSession(PHONE, { orderConfirm: { status: 'sent', sentAt: NOW.toISOString() } });
  assert.equal(orderConfirm.confirmByText(PHONE, 'quiero mas info'), false);
  assert.equal(orderConfirm.confirmByText(PHONE, 'Sí'), true);
  assert.equal(state.getSession(PHONE).orderConfirm.confirmedBy, 'cliente_texto');
  assert.equal(orderConfirm.confirmByText(PHONE, 'si'), false);
});

test('recordatorio a las 4 h y expiracion a las 20 h', async () => {
  state.updateSession(PHONE, { history: [{ role: 'user', content: 'hola', at: new Date().toISOString() }], orderConfirm: { status: 'sent', sentAt: new Date(Date.now() - 5 * 3600000).toISOString() } });
  const deps = makeDeps();
  await orderConfirm.tick(new Date(), deps);
  assert.equal(deps.calls.buttons.length, 1);
  assert.ok(state.getSession(PHONE).orderConfirm.reminderSentAt);
  state.updateSession(PHONE, { orderConfirm: { ...state.getSession(PHONE).orderConfirm, sentAt: new Date(Date.now() - 21 * 3600000).toISOString() } });
  await orderConfirm.tick(new Date(), deps);
  assert.equal(state.getSession(PHONE).orderConfirm.status, 'expired');
  assert.equal(deps.calls.push.length, 1);
});

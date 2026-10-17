'use strict';
// Recordatorios de retiro en modo fijo (dias 1, 3 y 5 desde la llegada) con las
// plantillas nuevas: recordatorio_retiro_pedido (dias 1 y 3) y
// ultimo_aviso_retiro_pedido (dia 5, con botones). Sin Meta ni DroPanas reales.
process.env.AUTO_SEND_ANYTIME = '1';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('pickup-schedule-fixed');
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const reminders = require('../src/pickupReminders');
const lastNotice = require('../src/lastNotice');
const shipping = require('../src/shipping');
const whatsapp = require('../src/whatsapp');

after(() => cleanup(dataDir));

const P = '584125550100';
const ARRIVED = '2026-10-05T14:00:00.000Z'; // lunes 5, 10:00 Caracas = dia 0
const day = (n, hourUtc = 15) => new Date(Date.parse(`2026-10-05T${String(hourUtc).padStart(2, '0')}:00:00.000Z`) + n * 86400000);
const SETTINGS = {
  pickupReminderEnabled: true, pickupReminderHour: 10, pickupReminderActivatedAt: '2026-01-01T00:00:00.000Z',
  pickupTemplateName: 'pedido_ha_llegado_a_tealca',
  pickupReminderTemplateName: 'recordatorio_retiro_pedido', pickupReminderTemplateLanguage: 'es',
  lastNoticeEnabled: true, lastNoticeHour: 10, lastNoticeTemplateName: 'ultimo_aviso_retiro_pedido', lastNoticeTemplateLanguage: 'es',
  reminderScheduleMode: 'fixed', reminderFixedActivatedAt: '2026-01-01T00:00:00.000Z', lastNoticeDailyCap: 25,
  maxAutoSendsPerDay: 2, holidays: [],
};
const OLD_MSG = [{ role: 'user', content: 'hola', at: '2026-09-01T10:00:00.000Z' }]; // ventana de 24 h cerrada

function seed(phone = P, extra = {}) {
  state.updateSession(phone, {
    stage: 'esperando_retiro', arrivalNotifiedAt: ARRIVED, name: 'Ana Perez', history: OLD_MSG,
    card: { guia: 'G100', producto: 'Shilajit', agencia: 'Sabana Grande', monto: 38900 },
    pickupReminderCount: 0, pickupReminderGuia: null, pickupReminderLastDate: null, pickupReminderAnchorDate: null,
    lastNoticeSentAt: null, lastNoticeGuia: null, lastNoticeAnswer: null, autoSends: null,
    optOut: false, paused: false, phoneContactAt: null, returnReasonAskedAt: null,
    ...extra,
  });
}

function makeDeps(phones = [P], estado = 'En oficina') {
  const sent = [];
  return {
    sent,
    settings: SETTINGS,
    ignoreDecided: true,
    lookupPauseMs: 0,
    listSessions: () => phones.map((ph) => ({ ...state.getSession(ph), phone: ph })),
    updateSession: (...a) => state.updateSession(...a),
    appendMessage: (...a) => state.appendMessage(...a),
    fetchOrders: async () => ({ orders: phones.map((ph, i) => ({ dropanasId: String(i + 1), guia: state.getSession(ph).card.guia, estadoPedido: estado })) }),
    fetchOrder: async () => ({ order: null }),
    statusCache: { load: () => null, getFresh: () => null, putMany: () => {} },
    officeStatus: async (sessions) => new Map(sessions.map((s) => [s.phone, { state: estado === 'En oficina' ? 'en_oficina' : 'otro_estado' }])),
    sendTemplateWithSnapshot: async (a) => { sent.push({ kind: 'template', ...a }); return { wamid: `w${sent.length}`, snapshot: null }; },
    sendButtons: async (to, text, buttons) => { sent.push({ kind: 'buttons', to, text, buttons }); return { messages: [{ id: 'wb' }] }; },
    notifyAdmin: () => {},
  };
}

// Un dia completo: primero recordatorios, despues ultimo aviso (como corren en el servidor).
async function runDay(n, deps, hourUtc = 15) {
  reminders.resetDecided();
  await reminders.run(day(n, hourUtc), deps);
  await lastNotice.run(day(n, hourUtc), deps);
}

beforeEach(() => seed());

test('1. dias 1 y 3 usan recordatorio_retiro_pedido con [nombre, producto, guia, monto]', async () => {
  const d = makeDeps();
  const v = shipping.placeholderValues(state.getSession(P));
  await runDay(1, d);
  await runDay(2, d);
  await runDay(3, d);
  assert.equal(d.sent.length, 2);
  for (const m of d.sent) {
    assert.equal(m.templateName, 'recordatorio_retiro_pedido');
    assert.deepEqual(m.values, [v.nombre, v.producto, v.guia, v.monto]);
    assert.deepEqual(m.values.slice(0, 3), ['Ana Perez', 'Shilajit', 'G100']);
  }
  const hist = state.getSession(P).history.filter((h) => h.template);
  assert.ok(hist.every((h) => h.template.origin === 'seguimiento'));
});

test('2. dia 5 con ultimo aviso prendido: sale ultimo_aviso (plantilla fuera de ventana, botones dentro) y no el recordatorio', async () => {
  const d = makeDeps();
  for (const n of [1, 3, 5]) await runDay(n, d);
  assert.equal(d.sent.length, 3);
  const last = d.sent[2];
  assert.equal(last.templateName, 'ultimo_aviso_retiro_pedido');
  const v = shipping.placeholderValues(state.getSession(P));
  assert.deepEqual(last.values, [v.nombre, v.producto, v.guia, v.monto]);
  assert.equal(d.sent.filter((m) => m.templateName === 'recordatorio_retiro_pedido').length, 2);
});

test('2b. dentro de la ventana de 24 h el ultimo aviso va con los 3 botones; nunca el mismo dia que un recordatorio', async () => {
  const lastMsg = new Date(day(5).getTime() - 3 * 3600000).toISOString();
  seed(P, { history: [{ role: 'user', content: 'ok', at: lastMsg }], pickupReminderCount: 2, pickupReminderGuia: 'G100', pickupReminderLastDate: '2026-10-10' });
  const d = makeDeps();
  assert.equal((await lastNotice.run(day(5), d)).length, 0, 'mismo dia que un recordatorio: no sale');
  state.updateSession(P, { pickupReminderLastDate: '2026-10-08' });
  const r = await lastNotice.run(day(5), d);
  assert.equal(r[0]?.sent, true, JSON.stringify(r));
  assert.equal(d.sent[0].kind, 'buttons');
  assert.deepEqual(d.sent[0].buttons.map((b) => b.id), ['ld_pickup', 'ld_change', 'ld_cancel']);
  assert.doesNotMatch(d.sent[0].text, /—/);
  assert.match(d.sent[0].text, /guía G100/);
});

test('3. dia 5 con ultimo aviso apagado: sale el recordatorio normal', async () => {
  const d = makeDeps();
  d.settings = { ...SETTINGS, lastNoticeEnabled: false };
  for (const n of [1, 3, 5]) await runDay(n, d);
  assert.deepEqual(d.sent.map((m) => m.templateName), ['recordatorio_retiro_pedido', 'recordatorio_retiro_pedido', 'recordatorio_retiro_pedido']);
});

test('4. nunca mas de 3 mensajes de retiro por pedido ni dos el mismo dia', async () => {
  const d = makeDeps();
  for (let n = 0; n <= 12; n += 1) { await runDay(n, d); await runDay(n, d, 21); }
  assert.equal(d.sent.length, 3);
  const days = d.sent.map((_, i) => i);
  assert.equal(new Set(days).size, 3);
  const s = state.getSession(P);
  assert.equal(s.pickupReminderCount, 2);
  assert.ok(s.lastNoticeSentAt);
  // Pedido que ya recibio 3 recordatorios (sistema viejo): el ultimo aviso no sale.
  seed(P, { pickupReminderCount: 3, pickupReminderGuia: 'G100', pickupReminderLastDate: '2026-10-08' });
  assert.equal(lastNotice.eligible({ ...state.getSession(P), phone: P }, SETTINGS, day(7), 'en_oficina'), false);
});

test('5. sin aviso de llegada ni confirmacion de DroPanas no sale nada; DroPanas "Entregado/Pagado/Devolucion" tampoco', async () => {
  seed(P, { arrivalNotifiedAt: null });
  const s = { ...state.getSession(P), phone: P };
  assert.equal(reminders.eligible(s, SETTINGS, day(1), null), false);
  assert.equal(lastNotice.eligible(s, SETTINGS, day(5), null), false);
  seed();
  for (const estado of ['Entregado', 'Pagado', 'Devolucion']) {
    const d = makeDeps([P], estado);
    for (const n of [1, 3, 5]) await runDay(n, d);
    assert.equal(d.sent.length, 0, estado);
  }
});

test('6. botones por texto (sin payload): retirar, cambiar agencia, ya no lo quiero', async () => {
  assert.equal(lastNotice.buttonIdFrom({ type: 'button', button: { text: 'Voy a retirarlo' } }), 'ld_pickup');
  assert.equal(lastNotice.buttonIdFrom({ type: 'button', button: { text: 'Cambiar agencia' } }), 'ld_change');
  assert.equal(lastNotice.buttonIdFrom({ type: 'button', button: { text: 'Ya no lo quiero' } }), 'ld_cancel');
  const said = [];
  const orig = whatsapp.sendText;
  whatsapp.sendText = async (to, t) => { said.push(t); };
  try {
    const d = makeDeps();
    await lastNotice.handleReply(P, 'ld_pickup', d, day(5));
    assert.match(said[0], /Te esperamos/);
    assert.doesNotMatch(said[0], /tienes hasta/); // modo fijo sin fecha limite
    await lastNotice.handleReply(P, 'ld_change', d, day(5));
    assert.match(said[1], /agencia/);
    await lastNotice.handleReply(P, 'ld_cancel', d, day(5));
    await lastNotice.handleReply(P, 'ld_cancel', d, day(5));
    const s = state.getSession(P);
    assert.equal(s.stage, 'pendiente_devolucion');
    assert.equal(said.filter((t) => /por qué/.test(t)).length, 1);
  } finally { whatsapp.sendText = orig; }
  // Con respuesta al ultimo aviso no hay mas recordatorios.
  seed(P, { lastNoticeAnswer: 'pickup', lastNoticeGuia: 'G100' });
  assert.equal(reminders.eligible({ ...state.getSession(P), phone: P }, SETTINGS, day(3), 'en_oficina'), false);
});

test('7. al activar, los atrasados salen de a poco: tope diario y el mas viejo primero', async () => {
  const phones = ['584125550201', '584125550202', '584125550203', '584125550204'];
  const arrivals = ['2026-09-20', '2026-09-25', '2026-09-28', '2026-10-01'];
  phones.forEach((ph, i) => seed(ph, { arrivalNotifiedAt: `${arrivals[i]}T14:00:00.000Z`, card: { guia: `G${i}`, producto: 'Shilajit', monto: 38900 } }));
  const d = makeDeps(phones);
  d.settings = { ...SETTINGS, lastNoticeDailyCap: 2 };
  const first = await lastNotice.run(day(5), d);
  assert.deepEqual(first.map((r) => r.phone), ['584125550201', '584125550202']);
  const plan = await lastNotice.plan(day(5, 18), d);
  assert.equal(plan.sentToday, 2);
  assert.equal(plan.due.length, 0);
  assert.equal(plan.waiting, 2);
  const second = await lastNotice.run(day(6), d);
  assert.deepEqual(second.map((r) => r.phone), ['584125550203', '584125550204']);
});

test('8. opt-out, pausado y cliente conversando (<48 h) no reciben nada', () => {
  for (const extra of [{ optOut: true }, { paused: true }]) {
    seed(P, extra);
    const s = { ...state.getSession(P), phone: P };
    assert.equal(reminders.eligible(s, SETTINGS, day(1), 'en_oficina'), false, JSON.stringify(extra));
    assert.equal(lastNotice.eligible(s, SETTINGS, day(5), 'en_oficina'), false, JSON.stringify(extra));
  }
  // Conversando: no le llegan los recordatorios de los dias 1 y 3 (el ultimo aviso
  // si sale, una sola vez y con botones si la ventana esta abierta).
  seed(P, { history: [{ role: 'user', content: 'ya casi voy', at: day(2).toISOString() }] });
  const s = { ...state.getSession(P), phone: P };
  assert.equal(reminders.eligible(s, SETTINGS, day(3), 'en_oficina'), false);
});

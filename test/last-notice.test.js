'use strict';
// Fase 7D: ultimo aviso con botones, motivo de devolucion y lista "Llamar hoy".
// Nada llama a Meta ni a DroPanas: todo se inyecta o se simula.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('last-notice');
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const lastNotice = require('../src/lastNotice');
const whatsapp = require('../src/whatsapp');

after(() => cleanup(dataDir));

const PHONE = '584125550001';
// Llego el lunes 5 oct; guarda 7 dias -> limite lunes 12; vispera domingo 11 -> uso 5 dias para tener una vispera habil.
const base = { lastNoticeEnabled: true, lastNoticeHour: 10, tealcaStorageDays: 5, tealcaStorageBusinessDays: false, holidays: [], dispatchOnSaturday: false, lastNoticeTemplateName: 'ultimo_aviso_retiro' };
const ARRIVED = '2026-10-05T14:00:00.000Z';
const EVE = new Date('2026-10-09T15:00:00Z'); // viernes 11:00 Caracas = vispera del limite (sabado 10)
const session = (extra = {}) => ({
  phone: PHONE, stage: 'esperando_retiro', arrivalNotifiedAt: ARRIVED, name: 'Ana Perez',
  history: [{ role: 'user', content: 'hola', at: new Date().toISOString() }],
  card: { guia: 'G77', producto: 'Shilajit', agencia: 'Sabana Grande' }, ...extra,
});

function deps(state_ = 'en_oficina') {
  const calls = { buttons: [], templates: [], push: [] };
  return {
    calls,
    listSessions: () => [state.getSession(PHONE) && { ...state.getSession(PHONE), phone: PHONE }],
    sendButtons: async (to, text, buttons) => calls.buttons.push({ to, text, buttons }),
    sendTemplateWithSnapshot: async (a) => { calls.templates.push(a); return { wamid: 'w', snapshot: null }; },
    officeStatus: async () => new Map([[PHONE, { state: state_ }]]),
    notifyAdmin: (t, b) => calls.push.push({ t, b }),
    settings: base,
  };
}

beforeEach(() => { state.updateSession(PHONE, { ...session(), lastNoticeSentAt: null, lastNoticeGuia: null, lastNoticeAnswer: null, phoneContactAt: null, returnReasonAskedAt: null, returnReason: null, stage: 'esperando_retiro' }); });

test('la vispera de la fecha limite sale el aviso con 3 botones y la marca queda guardada', async () => {
  const d = deps();
  const r = await lastNotice.run(EVE, d);
  assert.equal(r[0].sent, true);
  assert.deepEqual(d.calls.buttons[0].buttons.map((b) => b.id), ['ld_pickup', 'ld_change', 'ld_cancel']);
  assert.match(d.calls.buttons[0].text, /tienes hasta el sábado 10 de octubre/);
  assert.equal(state.getSession(PHONE).lastNoticeGuia, 'G77');
  assert.equal((await lastNotice.run(new Date(EVE.getTime() + 3600000), d)).length, 0); // una sola vez
});

test('no sale: dia equivocado, apagado, sin confirmacion de DroPanas, otro estado, o ya llamado hoy', async () => {
  const d = deps();
  assert.equal((await lastNotice.run(new Date('2026-10-08T15:00:00Z'), d)).length, 0);
  assert.equal((await lastNotice.run(EVE, { ...d, settings: { ...base, lastNoticeEnabled: false } })).length, 0);
  assert.equal((await lastNotice.run(EVE, { ...d, officeStatus: async () => new Map([[PHONE, { state: null }]]) })).length, 0);
  assert.equal((await lastNotice.run(EVE, { ...d, officeStatus: async () => new Map([[PHONE, { state: 'otro_estado' }]]) })).length, 0);
  assert.equal((await lastNotice.run(new Date('2026-10-09T13:00:00Z'), d)).length, 0); // 09:00, antes de la hora
  lastNotice.setPhoneContact(PHONE, 'hablamos', EVE);
  assert.equal((await lastNotice.run(EVE, d)).length, 0);
  assert.equal(d.calls.buttons.length, 0);
});

test('sin dias de guarda cargados no se avisa nada', async () => {
  const d = deps();
  assert.equal((await lastNotice.run(EVE, { ...d, settings: { ...base, tealcaStorageDays: null } })).length, 0);
});

test('con ventana cerrada va la plantilla; sin plantilla cargada no sale', async () => {
  state.updateSession(PHONE, { history: [{ role: 'user', content: 'hola', at: '2026-09-01T10:00:00.000Z' }] });
  const d = deps();
  const r = await lastNotice.run(EVE, d);
  assert.equal(r[0].viaTemplate, true);
  assert.deepEqual(d.calls.templates[0].values, ['Ana Perez', 'Shilajit', 'Sabana Grande', 'el sábado 10 de octubre']);
  state.updateSession(PHONE, { lastNoticeSentAt: null, lastNoticeGuia: null });
  const r2 = await lastNotice.run(EVE, { ...deps(), settings: { ...base, lastNoticeTemplateName: null } });
  assert.equal(r2[0].reason, 'sin_plantilla');
});

test('botones: retirar / cambiar agencia / ya no lo quiero', async () => {
  const sent = [];
  const orig = whatsapp.sendText;
  whatsapp.sendText = async (to, t) => { sent.push(t); };
  try {
    const d = deps();
    await lastNotice.handleReply(PHONE, 'ld_pickup', d, EVE);
    assert.equal(state.getSession(PHONE).lastNoticeAnswer, 'pickup');
    assert.match(sent[0], /Te esperamos/);
    await lastNotice.handleReply(PHONE, 'ld_change', d, EVE);
    assert.equal(state.getSession(PHONE).lastNoticeAnswer, 'change');
    assert.equal(d.calls.push.length, 1);
    await lastNotice.handleReply(PHONE, 'ld_cancel', d, EVE);
    const s = state.getSession(PHONE);
    assert.equal(s.stage, 'pendiente_devolucion');
    assert.equal(s.stageSource, 'cliente_ultimo_aviso');
    assert.ok(s.returnReasonAskedAt);
    assert.match(sent[sent.length - 1], /por qué/);
    assert.equal(await lastNotice.handleReply(PHONE, 'otra_cosa', d, EVE), false);
  } finally { whatsapp.sendText = orig; }
});

test('el motivo de devolucion se pregunta una vez y la respuesta se clasifica', async () => {
  const orig = whatsapp.sendText;
  const sent = [];
  whatsapp.sendText = async (to, t) => { sent.push(t); };
  try {
    await lastNotice.handleReply(PHONE, 'ld_cancel', deps(), EVE);
    await lastNotice.handleReply(PHONE, 'ld_cancel', deps(), EVE);
    assert.equal(sent.filter((t) => /por qué/.test(t)).length, 1);
    assert.equal(await lastNotice.captureReason(PHONE, 'es que me parece muy caro'), true);
    const s = state.getSession(PHONE);
    assert.equal(s.returnReason, 'precio');
    assert.equal(await lastNotice.captureReason(PHONE, 'otra cosa'), false); // ya respondio
  } finally { whatsapp.sendText = orig; }
  assert.equal(lastNotice.classifyReason('me demoro mucho'), 'demora');
  assert.equal(lastNotice.classifyReason('xyz'), 'otro');
});

test('boton de plantilla sin payload se reconoce por su texto', () => {
  assert.equal(lastNotice.buttonIdFrom({ type: 'button', button: { text: 'Ya no lo quiero', payload: 'Ya no lo quiero' } }), 'ld_cancel');
  assert.equal(lastNotice.buttonIdFrom({ type: 'interactive', interactive: { button_reply: { id: 'ld_pickup', title: 'x' } } }), 'ld_pickup');
  assert.equal(lastNotice.buttonIdFrom({ type: 'text' }), '');
});

test('"Llamar hoy": vencen hoy/manana o sin respuesta, y desaparece al marcar contactado', () => {
  const s1 = { ...state.getSession(PHONE), phone: PHONE };
  const rows = lastNotice.callToday([s1], base, EVE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].daysLeft, 1);
  lastNotice.setPhoneContact(PHONE, 'llamado', EVE);
  assert.equal(lastNotice.callToday([{ ...state.getSession(PHONE), phone: PHONE }], base, EVE).length, 0);
  const far = lastNotice.callToday([{ ...s1, arrivalNotifiedAt: '2026-10-09T14:00:00.000Z' }], base, EVE);
  assert.equal(far.length, 0);
});

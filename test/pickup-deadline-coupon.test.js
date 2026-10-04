'use strict';
// Fase 7C: fecha limite de retiro y cupon por retiro rapido. Sin Meta ni DroPanas.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('pickup-deadline');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const reminders = require('../src/pickupReminders');
const pickupDeadline = require('../src/pickupDeadline');
const coupons = require('../src/coupons');
const shipping = require('../src/shipping');

after(() => cleanup(dataDir));

// Llego el lunes 2026-10-05 (10:00 Caracas).
const ARRIVED = '2026-10-05T14:00:00.000Z';
const base = { holidays: [], dispatchOnSaturday: false, tealcaStorageDays: 7, tealcaStorageBusinessDays: false };
const sess = (extra = {}) => ({ phone: '584120000009', stage: 'esperando_retiro', arrivalNotifiedAt: ARRIVED, name: 'Ana', card: { guia: 'G1', producto: 'Shilajit', agencia: 'Sabana Grande' }, ...extra });

test('fecha limite: dias corridos o habiles, y null si no hay dato cargado', () => {
  assert.equal(pickupDeadline.deadlineFor(sess(), base), '2026-10-12');
  assert.equal(pickupDeadline.deadlineFor(sess(), { ...base, tealcaStorageBusinessDays: true }), '2026-10-14');
  assert.equal(pickupDeadline.deadlineFor(sess(), { ...base, tealcaStorageDays: null }), null);
  assert.equal(pickupDeadline.deadlineFor(sess({ arrivalNotifiedAt: null }), base), null);
  assert.equal(pickupDeadline.deadlineText(sess(), base), 'el lunes 12 de octubre');
  assert.equal(pickupDeadline.deadlineText(sess(), { ...base, tealcaStorageDays: null }), '');
});

test('con ultimo aviso prendido y dias de guarda cargados, el dia 5 ya no lleva recordatorio', () => {
  const settings = { pickupReminderEnabled: true, pickupReminderHour: 10, pickupTemplateName: 'x', ...base, lastNoticeEnabled: true };
  const at = (n) => new Date(Date.parse(ARRIVED) + n * 86400000);
  const s = sess({ pickupReminderCount: 2, pickupReminderGuia: 'G1' });
  assert.equal(reminders.eligible(s, settings, at(5), 'en_oficina'), false);
  assert.equal(reminders.eligible(s, { ...settings, lastNoticeEnabled: false }, at(5), 'en_oficina'), true);
  assert.equal(reminders.eligible(s, { ...settings, tealcaStorageDays: null }, at(5), 'en_oficina'), true);
  assert.equal(reminders.eligible(sess(), settings, at(1), 'en_oficina'), true);
});

test('el recordatorio usa la plantilla de fecha limite con [nombre, producto, agencia, fecha]', async () => {
  const sent = [];
  const deps = {
    updateSession: () => {}, appendMessage: () => {},
    sendTemplateWithSnapshot: async (a) => { sent.push(a); return { wamid: 'w', snapshot: null }; },
  };
  const settings = { ...base, pickupTemplateName: 'pedido_ha_llegado_a_tealca', pickupDeadlineTemplateName: 'retiro_fecha_limite', pickupDeadlineTemplateLanguage: 'es' };
  await reminders.sendReminder(sess(), settings, new Date('2026-10-06T14:00:00Z'), deps);
  assert.equal(sent[0].templateName, 'retiro_fecha_limite');
  assert.deepEqual(sent[0].values, ['Ana', 'Shilajit', 'Sabana Grande', 'el lunes 12 de octubre']);
  // Sin la plantilla cargada (o sin fecha) sale la de siempre.
  await reminders.sendReminder(sess(), { ...settings, pickupDeadlineTemplateName: null }, new Date('2026-10-06T14:00:00Z'), deps);
  assert.equal(sent[1].templateName, 'pedido_ha_llegado_a_tealca');
});

test('cupon: codigo unico RETIRO-XXXXXX, ligado al telefono y de un solo uso', () => {
  const a = coupons.createQuickPickupCoupon({ phone: '58412111', discountPercent: 10, validDays: 30 });
  const b = coupons.createQuickPickupCoupon({ phone: '58412111', discountPercent: 10, validDays: 30 });
  assert.match(a.code, /^RETIRO-[A-Z2-9]{6}$/);
  assert.notEqual(a.code, b.code);
  assert.equal(coupons.redeemQuickPickup(a.code, '58412999', { redeem: false }).reason, 'otro_telefono');
  assert.equal(coupons.redeemQuickPickup(a.code, '58412111').ok, true);
  assert.equal(coupons.redeemQuickPickup(a.code, '58412111').reason, 'ya_usado');
  assert.equal(coupons.redeemQuickPickup('RETIRO-NOEXIS', '58412111').reason, 'no_existe');
  const late = coupons.createQuickPickupCoupon({ phone: '58412111', discountPercent: 10, validDays: 1, now: new Date('2026-01-01T00:00:00Z') });
  assert.equal(coupons.redeemQuickPickup(late.code, '58412111').reason, 'vencido');
});

test('cupon por retiro rapido: solo dentro de las horas, una vez por pedido, apagado por defecto', () => {
  state.updateSession('584120000009', sess());
  const settings = { quickPickupCouponEnabled: true, quickPickupHours: 48, quickPickupDiscountPercent: 10, quickPickupCouponValidDays: 30 };
  const within = new Date(Date.parse(ARRIVED) + 30 * 3600000);
  const outside = new Date(Date.parse(ARRIVED) + 60 * 3600000);
  assert.equal(shipping.quickPickupCouponText(sess(), { ...settings, quickPickupCouponEnabled: false }, within), '');
  assert.equal(shipping.quickPickupCouponText(sess(), settings, outside), '');
  const text = shipping.quickPickupCouponText(sess(), settings, within);
  assert.match(text, /10% de descuento .* RETIRO-[A-Z2-9]{6}/);
  // Ya se le dio uno por esta guia: no se repite.
  assert.equal(shipping.quickPickupCouponText(state.getSession('584120000009'), settings, within), '');
  assert.equal(coupons.listCoupons().filter((c) => c.phone === '584120000009').length, 1);
});

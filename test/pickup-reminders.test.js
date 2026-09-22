const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTempDataDir } = require('./helpers/tempDataDir');

setupTempDataDir('pickup-reminders');
const reminders = require('../src/pickupReminders');

const settings = {
  pickupReminderEnabled: true,
  pickupReminderHour: 10,
  pickupReminderMaxDays: 5,
  pickupReminderActivatedAt: '2026-09-21T12:00:00.000Z',
};

test('solo recuerda pedidos nuevos que siguen esperando retiro', () => {
  const now = new Date('2026-09-23T14:10:00.000Z'); // 10:10 en Venezuela
  assert.equal(reminders.eligible({ stage: 'esperando_retiro', arrivalNotifiedAt: '2026-09-22T14:00:00.000Z' }, settings, now), true);
  assert.equal(reminders.eligible({ stage: 'en_camino', arrivalNotifiedAt: '2026-09-22T14:00:00.000Z' }, settings, now), false);
  assert.equal(reminders.eligible({ stage: 'esperando_retiro', arrivalNotifiedAt: '2026-09-20T14:00:00.000Z' }, settings, now), false);
});

test('no duplica el mismo dia ni supera el limite', () => {
  const now = new Date('2026-09-23T14:10:00.000Z');
  const base = { stage: 'esperando_retiro', arrivalNotifiedAt: '2026-09-22T14:00:00.000Z' };
  assert.equal(reminders.eligible({ ...base, pickupReminderLastDate: '2026-09-23' }, settings, now), false);
  assert.equal(reminders.eligible({ ...base, pickupReminderCount: 5 }, settings, now), false);
});

test('no repite la plantilla el mismo dia de la llegada', () => {
  const now = new Date('2026-09-23T14:10:00.000Z');
  assert.equal(reminders.eligible({ stage: 'esperando_retiro', arrivalNotifiedAt: '2026-09-23T12:00:00.000Z' }, settings, now), false);
});

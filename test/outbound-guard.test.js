'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('outbound-guard');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../src/outboundGuard');
const state = require('../src/state');
const janitor = require('../src/diskJanitor');

after(() => { delete process.env.AUTO_SEND_ANYTIME; cleanup(dataDir); });

const S = { maxAutoSendsPerDay: 2, autoSendHourStart: 8, autoSendHourEnd: 20, qualityGuardActive: false };
const NOON = new Date('2026-10-03T16:00:00.000Z'); // 12:00 Caracas

test('opt-out frena marketing pero no los avisos logisticos', () => {
  const s = { phone: '1', optOut: true };
  assert.deepEqual(guard.canSendAutomatic(s, 'remarketing', NOON, S), { ok: false, reason: 'opt_out' });
  assert.deepEqual(guard.canSendAutomatic(s, 'broadcast', NOON, S), { ok: false, reason: 'opt_out' });
  assert.equal(guard.canSendAutomatic(s, 'arrival', NOON, S).ok, true);
  assert.equal(guard.canSendAutomatic(s, 'shipping', NOON, S).ok, true);
});

test('calidad en riesgo frena solo marketing', () => {
  const q = { ...S, qualityGuardActive: true };
  assert.equal(guard.canSendAutomatic({}, 'pickup_reminder', NOON, q).reason, 'calidad_en_riesgo');
  assert.equal(guard.canSendAutomatic({}, 'delivered', NOON, q).ok, true);
});

test('horario de Caracas', () => {
  delete process.env.AUTO_SEND_ANYTIME;
  try {
    assert.equal(guard.canSendAutomatic({}, 'remarketing', new Date('2026-10-03T04:00:00.000Z'), S).reason, 'fuera_de_horario'); // 00:00
    assert.equal(guard.canSendAutomatic({}, 'remarketing', new Date('2026-10-04T00:30:00.000Z'), S).reason, 'fuera_de_horario'); // 20:30
    assert.equal(guard.canSendAutomatic({}, 'remarketing', NOON, S).ok, true);
  } finally {
    process.env.AUTO_SEND_ANYTIME = '1';
  }
});

test('tope diario: marketing se corta, transaccional no, y reserve cuenta', () => {
  const phone = '584120001111';
  state.updateSession(phone, { name: 'x' });
  let s = state.getSession(phone);
  guard.reserveAutomatic(phone, 'remarketing', NOON, s);
  s = state.getSession(phone);
  guard.reserveAutomatic(phone, 'arrival', NOON, s);
  s = state.getSession(phone);
  assert.equal(s.autoSends.count, 2);
  assert.equal(guard.canSendAutomatic(s, 'remarketing', NOON, S).reason, 'tope_diario');
  assert.equal(guard.canSendAutomatic(s, 'arrival', NOON, S).ok, true);
  // al dia siguiente se reinicia
  assert.equal(guard.canSendAutomatic(s, 'remarketing', new Date(NOON.getTime() + 86400000), S).ok, true);
});

test('reserveAutomatic propaga el error si no se puede guardar', () => {
  assert.throws(() => guard.reserveAutomatic('1', 'remarketing', NOON, null, () => { throw new Error('ENOSPC'); }), /ENOSPC/);
});

test('disco critico frena todo, incluso lo logistico', () => {
  janitor.markEnospc();
  assert.equal(guard.canSendAutomatic({}, 'arrival', NOON, S).reason, 'disco_critico');
});

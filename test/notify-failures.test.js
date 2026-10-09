'use strict';
// S6: un aviso automatico que Meta acepta y despues rechaza (status failed) se
// reintenta (131047/131026) o va a "Llamar hoy" (131049 y otros), y si una
// plantilla falla mucho en el dia se avisa a Jere.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('notify-failures');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { appendMessage, getSession, updateSession, applyTemplateStatus } = require('../src/state');
const { rememberWamid } = require('../src/notifyFailures');
const lastNotice = require('../src/lastNotice');

after(() => cleanup(dataDir));

function sentArrival(phone, wamid, template = 'pedido_ha_llegado_a_tealca') {
  appendMessage(phone, 'human', `[plantilla automatica] ${template}`, {
    template: { name: template, origin: 'bot', wamid, status: 'sent' },
  });
  updateSession(phone, { stage: 'esperando_retiro', arrivalNotifiedAt: '2026-10-06T14:00:00Z', ...rememberWamid(getSession(phone), wamid, 'arrivalNotifiedAt') });
}

const failed = (wamid, code) => ({ id: wamid, status: 'failed', errors: [{ code, title: 'x' }] });

test('failed 131047 de una llegada: se libera la marca y notifyRetries queda en 1', () => {
  const phone = '584120000401';
  sentArrival(phone, 'wamid.A1');
  const r = applyTemplateStatus(failed('wamid.A1', 131047), { notifyAdmin: () => {} });
  assert.equal(r.notifyFailure.action, 'released');
  const s = getSession(phone);
  assert.equal(s.arrivalNotifiedAt, null);
  assert.equal(s.notifyRetries.arrivalNotifiedAt, 1);
});

test('despues de 2 reintentos un 131047 ya no libera la marca', () => {
  const phone = '584120000402';
  sentArrival(phone, 'wamid.B1');
  updateSession(phone, { notifyRetries: { arrivalNotifiedAt: 2 } });
  const r = applyTemplateStatus(failed('wamid.B1', 131047), { notifyAdmin: () => {} });
  assert.equal(r.notifyFailure.action, 'call_today');
});

test('failed 131049: la marca se queda y el chat aparece en Llamar hoy', () => {
  const phone = '584120000403';
  sentArrival(phone, 'wamid.C1');
  const r = applyTemplateStatus(failed('wamid.C1', 131049), { notifyAdmin: () => {} });
  assert.equal(r.notifyFailure.action, 'call_today');
  const s = getSession(phone);
  assert.ok(s.arrivalNotifiedAt);
  assert.equal(s.notifyFailed.arrivalNotifiedAt.code, 131049);
  const rows = lastNotice.callToday([s], {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].motivo, 'aviso no entregado');
});

test('un mensaje que no es aviso automatico no hace nada extra', () => {
  const phone = '584120000404';
  appendMessage(phone, 'human', '[plantilla] promo', { template: { name: 'promo', wamid: 'wamid.D1', status: 'sent' } });
  const r = applyTemplateStatus(failed('wamid.D1', 131049));
  assert.equal(r.notifyFailure.action, 'none');
});

test('6 fallos de la misma plantilla en el dia: un solo push', () => {
  const pushes = [];
  for (let i = 0; i < 7; i += 1) {
    const phone = `58412000050${i}`;
    sentArrival(phone, `wamid.E${i}`, 'plantilla_rota');
    applyTemplateStatus(failed(`wamid.E${i}`, 132001), { notifyAdmin: (_t, body) => pushes.push(body) });
  }
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /plantilla_rota.*132001/);
});

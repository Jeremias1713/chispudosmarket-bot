// FASE 1 (H13 + H29 parcial):
// H13 - antes /api/settings guardaba cualquier valor numerico tal cual
// (negativos, texto, fuera de rango) sin ningun chequeo; un maxWordsPerMessage
// negativo, en particular, colgaba chunkByWords (ai.js) en un loop infinito.
// H29 - /panel/login no tenia limite de intentos, y el backup (/api/backup)
// dejaba afuera library/agencias/broadcasts/push (se perdian en un reinicio
// del disco no persistente igual que sessions.json).
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('panel-settings-login');
process.env.PANEL_USER = 'admin';
process.env.PANEL_PASS = 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = 'secreto-de-prueba';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const panelRouter = require('../src/web/panel');
const { enforceMessageLimits } = require('../src/ai');

after(() => cleanup(dataDir));

test('H13 - validateNumericSettings acepta valores validos y guarda solo esos', () => {
  const { patch, errors } = panelRouter.validateNumericSettings({ maxWordsPerMessage: '40', remarketingHourStart: 8 });
  assert.deepEqual(errors, []);
  assert.equal(patch.maxWordsPerMessage, 40);
  assert.equal(patch.remarketingHourStart, 8);
});

test('H13 - validateNumericSettings rechaza un valor negativo con un mensaje claro que nombra el campo', () => {
  const { patch, errors } = panelRouter.validateNumericSettings({ maxWordsPerMessage: -5 });
  assert.equal(Object.keys(patch).length, 0, 'BUG H13 corregido: un valor invalido no se guarda');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /maxWordsPerMessage/);
});

test('H13 - validateNumericSettings rechaza texto no numerico y valores fuera de rango (hora 25)', () => {
  const r1 = panelRouter.validateNumericSettings({ openaiHistoryN: 'no-es-un-numero' });
  assert.equal(r1.errors.length, 1);

  const r2 = panelRouter.validateNumericSettings({ remarketingHourEnd: 25 });
  assert.equal(r2.errors.length, 1);
  assert.match(r2.errors[0], /remarketingHourEnd/);
});

test('H13 - chunkByWords (via enforceMessageLimits) con un maxWords invalido ya no se cuelga: lo trata como "sin tope"', () => {
  const texto = 'una dos tres cuatro cinco seis siete';
  // Antes de la reparacion, maxWords=-5 entraba en un loop infinito aca.
  const resultado = enforceMessageLimits([texto], -5, 10);
  assert.deepEqual(resultado, [texto], 'BUG H13 corregido: un maxWords invalido no corta ni cuelga, devuelve el texto entero');
});

test('H29 - /panel/login bloquea despues de varios intentos fallidos seguidos desde la misma IP', () => {
  const { loginRateLimit, registerFailedLogin, loginAttemptsByIp } = panelRouter._testLoginRateLimit;
  const ip = '203.0.113.5';
  loginAttemptsByIp.delete(ip); // aislar de otros tests

  const fakeReq = () => ({ ip, socket: { remoteAddress: ip } });
  let bloqueado = false;
  const fakeRes = () => ({
    status(code) {
      if (code === 429) bloqueado = true;
      return this;
    },
    type() { return this; },
    send() { return this; },
  });

  // 5 intentos fallidos: ninguno todavia bloqueado por loginRateLimit (se
  // registra el fallo DESPUES de que el login real lo verifica), pero
  // registerFailedLogin es lo que lleva la cuenta.
  for (let i = 0; i < 5; i++) registerFailedLogin(fakeReq());

  // El 6to intento (o cualquiera desde ahora) tiene que quedar bloqueado por
  // el middleware ANTES de siquiera revisar usuario/clave.
  loginRateLimit(fakeReq(), fakeRes(), () => {
    throw new Error('BUG H29: next() no deberia llamarse, la IP ya deberia estar bloqueada');
  });
  assert.ok(bloqueado, 'BUG H29 corregido: tras 5 intentos fallidos, el siguiente intento se bloquea con 429');
});

test('H29 - /api/backup incluye library, agencies, broadcasts y pushSubscriptions ademas de lo que ya traia', () => {
  const layer = panelRouter.stack.find((l) => l.route && l.route.path === '/api/backup' && l.route.methods.get);
  assert.ok(layer, 'la ruta /api/backup existe');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  let jsonRecibido = null;
  const fakeReq = {};
  const fakeRes = {
    setHeader() {},
    json(body) { jsonRecibido = body; },
  };
  handler(fakeReq, fakeRes);

  assert.ok(jsonRecibido, 'el handler respondio algo');
  for (const key of ['sessions', 'products', 'coupons', 'settings', 'library', 'agencies', 'broadcasts', 'pushSubscriptions']) {
    assert.ok(key in jsonRecibido, `BUG H29 corregido: el backup incluye "${key}"`);
  }
});

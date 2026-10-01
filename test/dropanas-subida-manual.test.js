'use strict';
// La subida automatica de pedidos a DroPanas queda bloqueada por defecto:
// solo se sube con el boton "Enviar a DroPanas" que aprieta una persona.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-subida-manual');
delete process.env.DROPANAS_AUTO_CREATE_ALLOWED;
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const automation = require('../src/dropanasOrderAutomation');
const state = require('../src/state');

after(() => cleanup(dataDir));

test('aunque el panel mande autoCreateEnabled=true, no se activa (bloqueado por defecto)', () => {
  const saved = automation.saveConfig({ uploadEnabled: true, autoCreateEnabled: true, mappings: automation.defaultMappings() });
  assert.equal(saved.autoCreateEnabled, false);
  assert.equal(saved.autoCreateLocked, true);
  assert.equal(saved.uploadEnabled, true);
  assert.equal(saved.activatedAt, null);
});

test('maybeCreate no intenta subir nada cuando esta bloqueado', async () => {
  const phone = '584140000001';
  state.updateSession(phone, { stage: 'vendido', orderClosed: true, soldAt: new Date().toISOString() });
  automation.maybeCreate(phone);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.getSession(phone).dropanasOrder, undefined);
});

test('draftForPhone devuelve el borrador de un chat y rechaza telefonos desconocidos', async () => {
  const phone = '584140000002';
  state.updateSession(phone, { stage: 'vendido', orderClosed: true, soldAt: new Date().toISOString() });
  const draft = await automation.draftForPhone(phone);
  assert.equal(draft.phone, phone);
  assert.ok(Array.isArray(draft.issues));
  await assert.rejects(() => automation.draftForPhone('584149999999'), /No existe una conversación/);
});

// Reproduce H03 (un comando normal borra historial y pedido) y H04 (un JSON
// corrupto se reemplaza silenciosamente, perdiendo todo lo anterior).
//
// Estos tests documentan el comportamiento ACTUAL (antes de reparar nada en
// la Fase 1). Sirven de "antes" para comparar una vez que H03/H04 se
// corrijan: en ese momento, los asserts marcados "// FASE 1" deben cambiar
// de expectativa (de "se pierde" a "se conserva").
'use strict';
const { setupTempDataDir, writeRaw, readJson, loadFixture, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('state');
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const state = require('../src/state');

after(() => cleanup(dataDir));

test('H03 - resetSession borra historial, card y adCode de un pedido cerrado (comportamiento actual)', () => {
  const fixture = loadFixture('sesiones-dos-pedidos-mismo-cliente.json');
  const phone = '584120000003';
  writeRaw(dataDir, 'sessions.json', JSON.stringify(fixture));

  const before = state.listSessions().find((s) => s.phone === phone);
  assert.ok(before.history.length > 0, 'la fixture trae historial');
  assert.equal(before.card.producto, 'Shilajit 30 caps');

  const after = state.resetSession(phone);

  // FASE 1: hoy 'resetSession' borra TODO. El hallazgo H03 pide que un
  // reinicio de flujo conversacional normal ('menu', 'inicio', etc.) no
  // pueda destruir esto. Este assert documenta el bug, no lo aprueba.
  assert.deepEqual(after.history, [], 'BUG H03: el historial se pierde por completo');
  assert.equal(after.card.producto, null, 'BUG H03: la ficha del pedido se pierde por completo');
  assert.equal(after.adCode, null, 'BUG H03: hasta el codigo de anuncio original se pierde');
  assert.equal(after.soldAt, undefined, 'BUG H03: la fecha de venta tambien desaparece');
  assert.equal(after.shippingNotifiedAt, undefined, 'BUG H03: el aviso de envio tambien desaparece');
});

test('H04 - un sessions.json corrupto se reemplaza sin avisar, perdiendo las sesiones anteriores', () => {
  const fixture = loadFixture('sesiones-nombres-parecidos.json');
  writeRaw(dataDir, 'sessions.json', JSON.stringify(fixture));
  assert.equal(state.listSessions().length, 2, 'arranca con 2 sesiones validas');

  // Simula corrupcion: el archivo queda con JSON invalido (ej. escritura
  // cortada a mitad de camino, ver H04).
  writeRaw(dataDir, 'sessions.json', '{"584120000001": { "card": { ROTO');

  // getSession crea una sesion nueva para un tercer telefono.
  const nuevo = state.getSession('584120099999');
  assert.ok(nuevo);

  // FASE 1: con la logica actual, loadAll() no distingue "corrupto" de
  // "vacio": devuelve {} y luego saveAll() escribe encima. Las dos sesiones
  // de la fixture (Ana María y Ana Isabel) desaparecen para siempre.
  const sessions = readJson(dataDir, 'sessions.json');
  assert.equal(Object.keys(sessions).length, 1, 'BUG H04: solo sobrevive la sesion nueva; las 2 anteriores se perdieron');
  assert.ok(!sessions['584120000001'], 'BUG H04: Ana María ya no existe en el archivo');
});

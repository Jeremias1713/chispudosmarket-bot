// FASE 1: valida la reparacion de H03 (un comando normal borraba historial y
// pedido) y H04 (un JSON corrupto se reemplazaba silenciosamente, perdiendo
// todo lo anterior, cuando SI habia una copia de seguridad para restaurar).
// Estos tests reemplazan a los de Fase 0, que documentaban el bug; ahora
// documentan el comportamiento correcto. El caso "sin ninguna copia de
// seguridad disponible" vive aparte en state-corrupt-sin-backup.test.js,
// porque BOT_DATA_DIR solo se puede fijar una vez por archivo (ver
// test/helpers/tempDataDir.js).
'use strict';
const { setupTempDataDir, writeRaw, readJson, loadFixture, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('state');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const state = require('../src/state');

after(() => cleanup(dataDir));

test('H03 - resetSession ya NO borra historial, card, adCode ni marcas de venta de un pedido cerrado', () => {
  const fixture = loadFixture('sesiones-dos-pedidos-mismo-cliente.json');
  const phone = '584120000003';
  writeRaw(dataDir, 'sessions.json', JSON.stringify(fixture));

  const before = state.listSessions().find((s) => s.phone === phone);
  assert.ok(before.history.length > 0, 'la fixture trae historial');
  assert.equal(before.card.producto, 'Shilajit 30 caps');

  const after = state.resetSession(phone);

  // FASE 1 (H03 reparado): "menu"/"inicio"/"reiniciar"/"start" solo reinicia
  // el flujo conversacional (step), nunca el pedido ya cerrado.
  assert.equal(after.step, 'START', 'el flujo conversacional si se reinicia');
  assert.deepEqual(after.history, before.history, 'el historial se conserva');
  assert.equal(after.card.producto, 'Shilajit 30 caps', 'la ficha del pedido se conserva');
  assert.equal(after.adCode, before.adCode, 'el codigo de anuncio original se conserva');
  assert.equal(after.soldAt, before.soldAt, 'la fecha de venta se conserva');
  assert.equal(after.shippingNotifiedAt, before.shippingNotifiedAt, 'el aviso de envio se conserva');
  assert.equal(after.stage, before.stage, 'la etapa (entregado/vendido/etc.) no se toca');
});

test('H03 (caso bueno) - resetSession de una sesion nueva sigue dejando un flujo en blanco normal', () => {
  const phone = '584120055555';
  const nueva = state.getSession(phone);
  assert.equal(nueva.step, 'START');

  const after = state.resetSession(phone);
  assert.equal(after.step, 'START');
  assert.deepEqual(after.history, []);
});

test('H04 - un sessions.json corrupto se restaura desde la ultima copia de seguridad valida, sin perder sesiones', () => {
  // Primero, una escritura "legitima" via el modulo (updateSession), para
  // que saveAll() ya haya generado al menos una copia de seguridad antes de
  // que el archivo se corrompa.
  const fixture = loadFixture('sesiones-nombres-parecidos.json');
  writeRaw(dataDir, 'sessions.json', JSON.stringify(fixture));
  state.updateSession('584120000001', { name: 'Ana María (confirmada)' }); // dispara saveAll -> crea backup del contenido anterior
  assert.equal(state.listSessions().length, 2, 'arranca con 2 sesiones validas');

  // Simula corrupcion: el archivo queda con JSON invalido (ej. escritura
  // cortada a mitad de camino, ver H04).
  writeRaw(dataDir, 'sessions.json', '{"584120000001": { "card": { ROTO');

  // FASE 1 (H04 reparado): loadAll() ya NO devuelve {} en silencio ante un
  // JSON invalido; restaura desde la copia de seguridad mas reciente.
  // getSession() fuerza un loadAll() + saveAll() para el telefono pedido.
  state.getSession('584120099999');
  const sessions = readJson(dataDir, 'sessions.json');

  assert.ok(sessions['584120000001'], 'BUG H04 corregido: Ana María sigue existiendo (restaurada del backup)');
  assert.ok(sessions['584120000002'], 'BUG H04 corregido: Ana Isabel sigue existiendo (restaurada del backup)');
  assert.ok(sessions['584120099999'], 'la sesion nueva tambien quedo guardada');
});

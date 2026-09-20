// Punto 4 del pedido de recuperacion: "Comprueba si el codigo anterior puede
// leer los datos actuales. No restaures un backup antiguo encima de los
// pedidos recientes ni borres campos o sesiones."
//
// Esta prueba arma un sessions.json como el que deja la version ACTUAL
// (con campos que la version recuperada -86d5731- nunca escribe ni lee:
// agenciaConfirmadaEnChat, lastOrderCloseHistoryIndex, orderDataRequested
// con semantica nueva, etc.) y confirma que:
//   1. getSession lo lee sin explotar y sin perder ningun campo.
//   2. Un updateSession (como el que hace flow.js en cada turno) preserva
//      TODOS los campos que no toca, incluidos los que el codigo viejo no
//      conoce -- porque estado.js fusiona con spread, no reemplaza.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('state-compat-datos-actuales');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { getSession, updateSession } = require('../src/state');

after(() => cleanup(dataDir));

const SESION_FORMA_ACTUAL = {
  step: 'IDLE',
  cart: [],
  history: [{ role: 'user', content: 'hola', at: '2026-09-20T00:00:00.000Z' }],
  stage: 'vendido',
  card: {
    nombre: 'Pedro Gomez',
    cedula: '9988776',
    telefono: '04141112233',
    producto: 'Shilajit',
    agencia: 'Tealca Maracay',
    // Campo que SOLO existe en la version actual (posterior a 86d5731):
    agenciaConfirmadaEnChat: true,
  },
  orderClosed: true,
  orderDataRequested: true,
  // Campo que SOLO existe en la version actual:
  lastOrderCloseHistoryIndex: 4,
  soldAt: '2026-09-20T01:00:00.000Z',
  createdAt: '2026-09-19T23:00:00.000Z',
  updatedAt: '2026-09-20T01:00:00.000Z',
};

test('getSession lee una sesion con campos de la version actual sin perder ninguno', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ '584140000111': SESION_FORMA_ACTUAL }));
  const session = getSession('584140000111');
  assert.equal(session.card.agenciaConfirmadaEnChat, true, 'el campo nuevo se preserva aunque el codigo viejo no lo use');
  assert.equal(session.lastOrderCloseHistoryIndex, 4, 'el campo nuevo se preserva aunque el codigo viejo no lo use');
  assert.equal(session.orderClosed, true);
  assert.equal(session.card.nombre, 'Pedro Gomez');
});

test('updateSession (como lo usa flow.js en produccion) NO borra los campos nuevos que no toca', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ '584140000112': SESION_FORMA_ACTUAL }));
  // Simula un patch tipico de flow.js: solo toca `updatedAt` y agrega un
  // mensaje al historial, como pasaria en un turno cualquiera post-cierre.
  const nuevaSesion = updateSession('584140000112', {
    history: [...SESION_FORMA_ACTUAL.history, { role: 'assistant', content: 'De nada!', at: '2026-09-20T02:00:00.000Z' }],
  });
  assert.equal(nuevaSesion.card.agenciaConfirmadaEnChat, true, 'BUG: se perdio un campo nuevo que el patch no tocaba');
  assert.equal(nuevaSesion.lastOrderCloseHistoryIndex, 4, 'BUG: se perdio un campo nuevo que el patch no tocaba');
  assert.equal(nuevaSesion.orderDataRequested, true, 'BUG: se perdio orderDataRequested (este SI lo usa el codigo viejo)');
  assert.equal(nuevaSesion.card.nombre, 'Pedro Gomez', 'BUG: se perdio un dato de cliente ya cargado');
  assert.equal(nuevaSesion.history.length, 2, 'el mensaje nuevo se agrego sin pisar el historial anterior');

  // Releer desde disco (no solo el objeto en memoria) para confirmar que lo
  // que quedo GUARDADO tambien preserva todo.
  const releida = getSession('584140000112');
  assert.equal(releida.card.agenciaConfirmadaEnChat, true);
  assert.equal(releida.lastOrderCloseHistoryIndex, 4);
});

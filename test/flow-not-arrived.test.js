// Deteccion de respuestas que contradicen la llegada del pedido (Hallazgo 3
// del reporte). Cubre las dos frases reales reportadas por el negocio,
// generaliza la causa (no solo esas dos frases puntuales), y confirma que
// una negacion CORRECTA de esa misma idea no se bloquea por error.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('flow-not-arrived');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { looksLikeSaysNotArrivedYet, ALREADY_ARRIVED_CORRECTION } = require('../src/flow');

after(() => cleanup(dataDir));

test('detecta las dos frases reales reportadas por el negocio', () => {
  assert.equal(
    looksLikeSaysNotArrivedYet('Recuerda que tu pedido tiene que llegar primero'),
    true,
    'BUG reportado: "tiene que llegar primero" no se detectaba como contradiccion'
  );
  assert.equal(
    looksLikeSaysNotArrivedYet('Debes esperar a que llegue para retirarlo'),
    true,
    'BUG reportado: "debes esperar a que llegue" no se detectaba como contradiccion'
  );
});

test('detecta otras variantes de la misma idea (no solo las dos frases puntuales)', () => {
  assert.equal(looksLikeSaysNotArrivedYet('Todavia no ha llegado a la agencia'), true);
  assert.equal(looksLikeSaysNotArrivedYet('Tu pedido sigue en camino'), true);
  assert.equal(looksLikeSaysNotArrivedYet('Hay que esperar a que llegue para poder retirarlo'), true);
  assert.equal(looksLikeSaysNotArrivedYet('Todavia esta en transito'), true);
  assert.equal(looksLikeSaysNotArrivedYet('Cuando llegue te aviso'), true);
});

test('NO marca como contradiccion una negacion correcta de esa misma idea', () => {
  assert.equal(
    looksLikeSaysNotArrivedYet('No tienes que esperar a que llegue: ya esta disponible'),
    false,
    'una respuesta que niega correctamente la idea de "todavia no llego" no debe bloquearse'
  );
  assert.equal(looksLikeSaysNotArrivedYet('Ya llego a la agencia, ya lo podes retirar'), false);
  assert.equal(looksLikeSaysNotArrivedYet('Ya esta disponible para que lo retires'), false);
});

test('un mensaje sin ninguna relacion con la llegada no se marca como contradiccion', () => {
  assert.equal(looksLikeSaysNotArrivedYet('Que bueno que te sirvio, cualquier cosa me escribis'), false);
  assert.equal(looksLikeSaysNotArrivedYet(''), false);
  assert.equal(looksLikeSaysNotArrivedYet(null), false);
});

test('el texto de correccion fijo no contradice la llegada (no se auto-bloquearia a si mismo)', () => {
  assert.equal(looksLikeSaysNotArrivedYet(ALREADY_ARRIVED_CORRECTION), false);
});

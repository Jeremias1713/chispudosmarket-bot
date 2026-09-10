// FASE 3 (H05/H18): logica compartida de comparacion de nombres, usada por
// dropanas.js y seguimiento.js para cruzar el Excel de Dropanas contra las
// conversaciones del bot.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compareNames, phonesMatch } = require('../src/nameMatch');

test('H05 - una sola palabra en comun no alcanza para "exacto" ("Ana" vs "Ana María")', () => {
  assert.equal(compareNames('Ana María', 'Ana'), 'parcial');
  assert.equal(compareNames('Ana Isabel', 'Ana'), 'parcial');
});

test('H05 (caso bueno) - el mismo nombre completo (con o sin tildes) es "exacto"', () => {
  assert.equal(compareNames('Ana María', 'Ana Maria'), 'exacto');
  assert.equal(compareNames('ANA MARÍA', 'ana maria'), 'exacto');
});

test('H18 - un nombre con un segundo nombre intercalado SI matchea "exacto" (2+ palabras en comun)', () => {
  assert.equal(compareNames('Jose Gregorio Velasquez', 'Jose Velasquez'), 'exacto');
});

test('H18 - orden de apellidos distinto sigue siendo "exacto"', () => {
  assert.equal(compareNames('Velasquez Jose', 'Jose Velasquez'), 'exacto');
});

test('sin ninguna palabra en comun es "sin_match"', () => {
  assert.equal(compareNames('Carlos Perez', 'Maria Jose Gonzalez'), 'sin_match');
});

test('nombre vacio de cualquiera de los dos lados es "sin_match"', () => {
  assert.equal(compareNames('', 'Ana Maria'), 'sin_match');
  assert.equal(compareNames('Ana Maria', ''), 'sin_match');
});

test('phonesMatch compara los ultimos digitos, ignorando formato/separadores', () => {
  assert.equal(phonesMatch('584120000001', '4120000001'), true);
  assert.equal(phonesMatch('+58 412-000-0001', '584120000001'), true);
  assert.equal(phonesMatch('584120000001', '584120000002'), false);
  assert.equal(phonesMatch('', '584120000001'), false);
  // Nota: el "0" inicial de un numero local venezolano (0412-...) no
  // corresponde a ningun digito del formato internacional (58412...), asi
  // que comparar sufijos de igual longitud puede fallar en ese caso
  // puntual. Hoy ningun llamador real depende de esa combinacion exacta
  // (el Excel de Dropanas no trae telefono todavia); documentado para no
  // asumir que esta funcion cubre absolutamente todos los formatos.
});

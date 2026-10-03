'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectOptOut } = require('../src/optOut');

test('detectOptOut: frases claras', () => {
  for (const t of [
    'No me escriban más', 'no me manden mas', 'Por favor no me molesten más', 'deja de escribirme', 'dejen de mandarme mensajes',
    'No quiero recibir más mensajes', 'no deseo publicidad', 'sácame de la lista', 'borrame de su lista', 'STOP', ' baja ', 'Parar!', 'cancelar suscripción',
  ]) assert.equal(detectOptOut(t), true, t);
});

test('detectOptOut: casos que NO deben disparar', () => {
  for (const t of [
    'no me llegó el mensaje', 'deja de llover y voy', 'stop de motor', '¿me das de baja el precio?', 'no me escribió la agencia',
    'hola', '', 'quiero comprar el shilajit', 'no quiero más de 2 unidades',
  ]) assert.equal(detectOptOut(t), false, t);
});

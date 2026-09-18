'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { foldSearchText, matchesConversation } = require('../src/conversationSearch');

function session(overrides = {}) {
  return {
    phone: '584120000001',
    name: 'Perfil cualquiera',
    card: {},
    history: [],
    ...overrides,
  };
}

test('normaliza mayusculas y tildes', () => {
  assert.equal(foldSearchText('  José GIMÉNEZ  '), 'jose gimenez');
});

test('encuentra por nombre guardado en la ficha aunque el perfil sea distinto', () => {
  const item = session({ name: '.', card: { nombre: 'Wilfredo Pacheco' } });
  assert.equal(matchesConversation(item, 'wilfredo pacheco'), true);
});

test('encuentra contenido de mensajes anteriores, no solo el ultimo', () => {
  const item = session({
    history: [
      { role: 'user', content: 'Mi nombre es Jesús Domínguez' },
      { role: 'assistant', content: 'Tu pedido quedó registrado' },
    ],
  });
  assert.equal(matchesConversation(item, 'Jesus Dominguez'), true);
});

test('encuentra por ciudad, producto y telefono de la ficha', () => {
  const item = session({
    card: { telefono: '0412-555-0199', ciudad: 'San Cristóbal', producto: 'Shilajit Viking' },
  });
  assert.equal(matchesConversation(item, 'san cristobal'), true);
  assert.equal(matchesConversation(item, 'shilajit viking'), true);
  assert.equal(matchesConversation(item, '0412 555 0199'), true);
});

test('tolera errores pequenos en nombres', () => {
  const item = session({ card: { nombre: 'Javier Santolla' } });
  assert.equal(matchesConversation(item, 'Javier Santoya'), true);
});

test('no acepta una coincidencia parcial de un nombre compuesto', () => {
  const item = session({ card: { nombre: 'José Ramírez' } });
  assert.equal(matchesConversation(item, 'Jose Herrera'), false);
});

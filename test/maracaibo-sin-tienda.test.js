const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildDirectAgencyMessage } = require('../src/ai');

test('la lista de agencias de Maracaibo ya no ofrece la tienda propia', () => {
  const msg = buildDirectAgencyMessage('maracaibo');
  assert.ok(msg, 'debe seguir armando la lista de agencias');
  assert.doesNotMatch(msg, /tienda|palacio de eventos|PBG/i);
});

test('el prompt le prohibe ofrecer la tienda de Maracaibo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai.js'), 'utf8');
  const line = src.split('\n').find((l) => l.startsWith('  - MARACAIBO (estado Zulia)'));
  assert.ok(line);
  assert.match(line, /NO ofrezcas/);
  assert.doesNotMatch(line, /PBG-16|Palacio de Eventos/);
});

test('el prompt contesta que el producto no esta en la tienda fisica y no confunde agencia con tienda', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai.js'), 'utf8');
  const line = src.split('\n').find((l) => l.startsWith('  - MARACAIBO (estado Zulia)'));
  assert.match(line, /no esta en la tienda fisica de Maracaibo ahora mismo/);
  assert.match(line, /llaman "tienda" a la agencia/);
});

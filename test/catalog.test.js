// Reproduce la causa de H39: loadProducts() no normaliza el campo
// 'triggers' al leer (a diferencia de introImageIds, que si se normaliza),
// asi que un producto viejo/importado con triggers guardado como texto
// llega crudo al panel. app.js#openProduct hace
// (p?.triggers || []).join(', '), que lanza "triggers.join is not a
// function" sobre un string. Ese ultimo paso es de frontend/DOM y no se
// reproduce aqui (la auditoria ya lo verifico con DOM simulado); este test
// cubre el backend: la falta de normalizacion en la lectura.
'use strict';
const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('catalog');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../src/catalog');

after(() => cleanup(dataDir));

test('H39 - loadProducts() no normaliza triggers guardado como cadena (dato viejo/importado)', () => {
  writeRaw(
    dataDir,
    'products.json',
    JSON.stringify([
      {
        id: 'p1',
        name: 'Audifonos Bluetooth',
        sku: 'AUD-1',
        price: 100,
        currency: 'Bs',
        description: '',
        active: true,
        triggers: 'audifonos, oferta', // dato viejo: string, no array
        introImageIds: [],
      },
    ])
  );

  const products = catalog.loadProducts();
  const producto = products[0];

  // FASE 5 (H39): esto deberia normalizarse a ['audifonos', 'oferta'] igual
  // que introImageIds se normaliza en la misma funcion (ver linea 21 de
  // src/catalog.js). Hoy queda crudo:
  assert.equal(typeof producto.triggers, 'string', 'BUG H39: triggers sigue siendo un string, no un array, tras loadProducts()');

  // Esto es exactamente lo que hace que app.js#openProduct explote con
  // "triggers.join is not a function": un string no tiene .join().
  assert.throws(() => producto.triggers.join(', '), /is not a function/);
});

test('H39 (caso bueno, para no romperlo al reparar) - triggers guardado como array normal sigue funcionando', () => {
  writeRaw(
    dataDir,
    'products.json',
    JSON.stringify([
      {
        id: 'p2',
        name: 'Colageno',
        sku: 'COL-1',
        price: 200,
        currency: 'Bs',
        description: '',
        active: true,
        triggers: ['colageno', 'piel'],
        introImageIds: [],
      },
    ])
  );

  const products = catalog.loadProducts();
  assert.deepEqual(products[0].triggers, ['colageno', 'piel']);
  assert.doesNotThrow(() => products[0].triggers.join(', '));
});

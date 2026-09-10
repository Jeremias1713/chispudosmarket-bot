// FASE 3 (H12): la plantilla de guia debe comunicar el monto REAL acordado
// con el cliente (card.monto, cargado a mano desde el panel) cuando existe,
// en vez de siempre recalcularlo desde el precio actual del catalogo.
'use strict';
const { setupTempDataDir, writeJson, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('shipping-monto');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const shipping = require('../src/shipping');

after(() => cleanup(dataDir));

writeJson(dataDir, 'products.json', [
  { id: 'p1', name: 'Shilajit 30 caps', price: 42000, currency: 'Bs', active: true },
]);

test('H12 (reparado) - con card.monto cargado, se usa el monto real del pedido, no el precio actual del catalogo', () => {
  const session = { name: 'Carlos', card: { producto: 'Shilajit 30 caps', monto: 38900 } };
  const values = shipping.placeholderValues(session);
  assert.equal(values.monto, '38900Bs', 'BUG H12 si esto da el precio de catalogo: se ignoro el monto real acordado');
});

test('H12 - sin card.monto cargado, sigue cayendo al precio de catalogo como respaldo', () => {
  const session = { name: 'Carlos', card: { producto: 'Shilajit 30 caps' } };
  const values = shipping.placeholderValues(session);
  assert.equal(values.monto, '42000Bs');
});

test('H12 - card.monto en 0 (venta real de cero, caso raro pero valido) se respeta y no cae al catalogo', () => {
  const session = { name: 'Carlos', card: { producto: 'Shilajit 30 caps', monto: 0 } };
  const values = shipping.placeholderValues(session);
  assert.equal(values.monto, '0Bs');
});

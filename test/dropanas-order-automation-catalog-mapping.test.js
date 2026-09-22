// FASE 3g: antes, un producto solo podia crear pedidos automaticos en
// DroPanas si estaba duplicado a mano en la tabla de mapeo separada de
// "Subir pedidos" (3 productos hardcodeados de arranque, o los que el
// operador agregara ahi mismo) -- cualquier producto real cargado solo en
// el catalogo normal (el que ya usa la IA para vender, con su propio
// nombre/precio) quedaba SIEMPRE bloqueado con "no tiene un mapeo unico a
// DroPanas", sin importar cuantos productos tuviera el negocio. Estas
// pruebas confirman que ahora basta con cargarle a un producto del
// catalogo su dropanasProductId (y opcionalmente su bodega) para que
// participe solo, sin tocar la tabla de mapeo manual, y que un mapeo
// manual para el mismo id de DroPanas sigue ganando si existe.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-order-automation-catalog-mapping');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const automation = require('../src/dropanasOrderAutomation');
const catalog = require('../src/catalog');

after(() => cleanup(dataDir));

function soldSession(overrides = {}) {
  return {
    name: 'Maria Perez', stage: 'vendido', orderClosed: true,
    soldAt: '2026-09-20T12:00:00.000Z',
    card: { nombre: 'Maria Perez', cedula: '26448320', telefono: '04227167341', producto: 'Colageno Marino' },
    currentOrder: { product: 'Colageno Marino', quantity: 1, total: 28900, agency: 'TURMERO', accepted: true, closed: true },
    ...overrides,
  };
}

test('BUG - un producto del catalogo (no cargado en la tabla de mapeo manual) quedaba sin mapeo aunque tuviera todo lo necesario', () => {
  catalog.createProduct({
    name: 'Colageno Marino', price: 28900, active: true,
    dropanasProductId: 30111, dropanasWarehouseId: 2,
  });

  const draft = automation.baseDraft('584227167341', soldSession());

  assert.ok(draft.mapping, 'BUG: un producto del catalogo con su id de DroPanas cargado deberia resolver mapeo solo');
  assert.equal(draft.mapping.productId, 30111);
  assert.equal(draft.mapping.warehouseId, 2);
  assert.deepEqual(draft.issues, []);
});

test('un producto del catalogo SIN dropanasProductId sigue exigiendo mapeo manual, como antes', () => {
  catalog.createProduct({ name: 'Vela Aromatica', price: 9900, active: true });

  const draft = automation.baseDraft('584227167342', soldSession({
    card: { nombre: 'Ana Diaz', cedula: '11223344', telefono: '04227167342', producto: 'Vela Aromatica' },
    currentOrder: { product: 'Vela Aromatica', quantity: 1, total: 9900, agency: 'TURMERO', accepted: true, closed: true },
  }));

  assert.equal(draft.mapping, null);
  assert.ok(draft.issues.some((issue) => issue.includes('mapeo')));
});

test('un mapeo manual para el mismo id de DroPanas sigue ganando sobre el del catalogo', () => {
  catalog.createProduct({
    name: 'Turkesterone', price: 39900, active: true,
    dropanasProductId: 20702, dropanasWarehouseId: 1,
  });
  automation.saveConfig({
    uploadEnabled: false,
    mappings: [
      { id: 'turkesterone-manual', label: 'Turkesterone Promo', aliases: ['turkesterone'], productId: 20702, warehouseId: 1, prices: { 1: 35000 }, enabled: true },
    ],
  });

  const draft = automation.baseDraft('584227167343', soldSession({
    card: { nombre: 'Luis Rojas', cedula: '55667788', telefono: '04227167343', producto: 'Turkesterone' },
    currentOrder: { product: 'Turkesterone', quantity: 1, total: 35000, agency: 'TURMERO', accepted: true, closed: true },
  }));

  assert.equal(draft.mapping.id, 'turkesterone-manual');
  assert.equal(draft.mapping.prices[1], 35000);
});

test('un producto pausado del catalogo no participa del mapeo automatico', () => {
  catalog.createProduct({
    name: 'Producto Descontinuado', price: 15000, active: false,
    dropanasProductId: 40222, dropanasWarehouseId: 1,
  });

  const draft = automation.baseDraft('584227167344', soldSession({
    card: { nombre: 'Pedro Gomez', cedula: '99887766', telefono: '04227167344', producto: 'Producto Descontinuado' },
    currentOrder: { product: 'Producto Descontinuado', quantity: 1, total: 15000, agency: 'TURMERO', accepted: true, closed: true },
  }));

  assert.equal(draft.mapping, null);
});

test('los mapeos del catalogo no ensucian la tabla editable del panel (settings().mappings)', () => {
  const before = automation.settings().mappings.length;
  catalog.createProduct({ name: 'Otro Producto Nuevo', price: 5000, active: true, dropanasProductId: 50333, dropanasWarehouseId: 1 });
  const after = automation.settings().mappings.length;
  assert.equal(after, before, 'los productos del catalogo deben resolverse aparte (matchableMappings), no aparecer solos en la tabla manual');
});

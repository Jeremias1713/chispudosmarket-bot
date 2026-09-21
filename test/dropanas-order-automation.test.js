'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-order-automation');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const automation = require('../src/dropanasOrderAutomation');

after(() => cleanup(dataDir));

function soldSession(overrides = {}) {
  return {
    name: 'Jorge Luis Carbajal', stage: 'vendido', orderClosed: true,
    soldAt: '2026-09-20T12:00:00.000Z',
    card: { nombre: 'Jorge Luis Carbajal', cedula: '26448320', telefono: '04227167341', producto: 'Shilajit Viking' },
    currentOrder: { product: 'Shilajit Viking', quantity: 2, total: 51900, agency: 'TURMERO', accepted: true, closed: true },
    ...overrides,
  };
}

test('arma un borrador completo usando el mapeo editable y divide nombre/apellido', () => {
  const draft = automation.baseDraft('584227167341', soldSession());
  assert.equal(draft.mapping.productId, 20343);
  assert.equal(draft.mapping.warehouseId, 1);
  assert.equal(draft.quantity, 2);
  assert.equal(draft.total, 51900);
  assert.deepEqual(draft.identity, { nombre: 'Jorge Luis', apellido: 'Carbajal' });
  assert.deepEqual(draft.issues, []);
});

test('bloquea un pedido incompleto en vez de inventar datos', () => {
  const draft = automation.baseDraft('584120000000', soldSession({
    stage: 'negociando',
    orderClosed: false,
    card: { nombre: 'Jorge', producto: 'Producto desconocido' },
    currentOrder: { product: 'Producto desconocido' },
  }));
  assert.ok(draft.issues.some((issue) => issue.includes('confirmada')));
  assert.ok(draft.issues.some((issue) => issue.includes('nombre y apellido')));
  assert.ok(draft.issues.some((issue) => issue.includes('mapeo')));
  assert.ok(draft.issues.some((issue) => issue.includes('oficina')));
});

test('solo acepta una coincidencia única de oficina oficial', () => {
  const offices = [
    { id: 646, nombre: 'Barcelona', direccion: 'Sector Nueva Barcelona' },
    { id: 647, nombre: 'Puerto La Cruz', direccion: 'Av. Stadium' },
  ];
  assert.equal(automation.resolveOffice('Barcelona', offices).id, 646);
  assert.equal(automation.resolveOffice('Mandaleno Samora', offices), null);
});

test('rechaza configuraciones sin IDs ni precios', () => {
  const result = automation.validateConfig({ mappings: [{ label: 'Nuevo', aliases: ['nuevo'], prices: {} }] });
  assert.ok(result.errors.some((error) => error.includes('ID de producto')));
  assert.ok(result.errors.some((error) => error.includes('precio')));
});

test('recupera cantidad y agencia desde confirmaciones explícitas del historial estable', () => {
  const draft = automation.baseDraft('584140859404', {
    stage: 'vendido',
    soldAt: '2026-09-20T12:00:00.000Z',
    card: {
      nombre: 'Robinson Navarro',
      cedula: '13169676',
      telefono: '04140859404',
      producto: 'Turkesterone',
    },
    history: [
      { role: 'assistant', content: '¿Cuántos frascos te gustaría llevar?' },
      { role: 'user', content: 'Solo una para probar' },
      { role: 'assistant', content: 'Perfecto, vamos a reservar tu pedido para la agencia de Nueva Barcelona.' },
    ],
  });

  assert.equal(draft.quantity, 1);
  assert.equal(draft.agency, 'Nueva Barcelona');
  assert.equal(draft.total, 39900);
  assert.deepEqual(draft.issues, []);
});

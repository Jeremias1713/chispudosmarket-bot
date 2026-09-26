'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-order-automation');
require('node:fs').copyFileSync(require('node:path').join(__dirname, '..', 'data', 'agencies.csv'), require('node:path').join(dataDir, 'agencies.csv'));
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

test('el catálogo local reconoce una oficina aunque la API no entregue sus IDs', () => {
  const matches = require('../src/agencies').searchByText('Tealca de Guacara', 10);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, 'GUACARA');
  assert.deepEqual(require('../src/agencies').searchByText('Tealca', 10), []);
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

test('arma un solo pedido con varios productos y precios independientes', () => {
  const draft = automation.baseDraft('584140859404', soldSession({
    currentOrder: null,
    card: {
      nombre: 'Robinson Navarro', cedula: '13169676', telefono: '04140859404',
      agencia: 'Nueva Barcelona', producto: 'Pedido mixto',
      productos: [
        { nombre: 'Shilajit Viking', cantidad: 1 },
        { nombre: 'Shilajit de resina', cantidad: 2 },
        { nombre: 'Turkesterone', cantidad: 1 },
      ],
    },
  }));

  assert.deepEqual(draft.items.map((item) => item.mapping.productId), [20343, 20448, 20702]);
  assert.deepEqual(draft.items.map((item) => item.total), [36900, 51900, 39900]);
  assert.equal(draft.total, 128700);
  assert.deepEqual(draft.issues, []);

  draft.official = { office: { id: 646, state_id: 2, city_id: 10, nombre: 'Barcelona', direccion: 'Nueva Barcelona' } };
  const payload = automation.buildPayload(draft, 'CHISPUDOS-TEST');
  assert.deepEqual(payload.productos, [
    { producto_id: 20343, cantidad: 1, precio_venta_ves: 36900 },
    { producto_id: 20448, cantidad: 2, precio_venta_ves: 25950 },
    { producto_id: 20702, cantidad: 1, precio_venta_ves: 39900 },
  ]);
  assert.equal(payload.bodega_origen_id, 1);
  assert.equal(payload.requiere_aprobacion, true);
});

test('un borrador base no inventa advertencias antes de consultar DroPanas', () => {
  const draft = automation.baseDraft('584227167341', soldSession());
  assert.equal(draft.warnings, undefined);
  assert.deepEqual(draft.issues, []);
});

test('omite oficina_id cuando DroPanas debe asignar la oficina al despachar', () => {
  const draft = automation.baseDraft('584227167341', soldSession());
  draft.official = {
    office: { id: null, state_id: 2, city_id: 10, nombre: 'Barcelona', direccion: 'Nueva Barcelona', assignedByDropanas: true },
  };
  const payload = automation.buildPayload(draft, 'CHISPUDOS-SIN-OFICINA');
  assert.equal(payload.direccion.state_id, 2);
  assert.equal(payload.direccion.city_id, 10);
  assert.equal(Object.hasOwn(payload, 'oficina_id'), false);
  assert.equal(payload.tipo_entrega, 'oficina');
});

test('incluye Shilajit Resina 20448 en la configuración inicial', () => {
  const resin = automation.defaultMappings().find((row) => row.productId === 20448);
  assert.ok(resin);
  assert.deepEqual(resin.prices, { 1: 36900, 2: 51900 });
});

test('la idempotencia es estable entre procesos y cambia para otra venta', () => {
  const firstReference = automation.externalReference(automation.baseDraft('584227167341', soldSession()));
  const sameReference = automation.externalReference(automation.baseDraft('584227167341', soldSession()));
  const otherReference = automation.externalReference(automation.baseDraft('584227167341', soldSession({ soldAt: '2026-09-20T13:00:00.000Z' })));

  assert.equal(firstReference, sameReference);
  assert.equal(automation.deterministicIdempotencyKey(firstReference), automation.deterministicIdempotencyKey(sameReference));
  assert.notEqual(automation.deterministicIdempotencyKey(firstReference), automation.deterministicIdempotencyKey(otherReference));
  assert.match(automation.deterministicIdempotencyKey(firstReference), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('no crea una referencia inestable si falta la fecha de cierre', () => {
  const draft = automation.baseDraft('584227167341', soldSession({ soldAt: null }));
  assert.ok(draft.issues.some((issue) => issue.includes('fecha válida')));
  assert.throws(() => automation.externalReference(draft), /fecha válida/);
});

'use strict';
// Caso real (Jose Luis, 12/10): Jere cambio el precio en Productos ("Shilajit
// gomitas masticables" 38.900, descuento fijo 9.000), pero la oferta y la subida
// a DroPanas salian con la tabla vieja de "Subir pedidos" (36.900) y con el 10%
// general, porque "Resina de Shilajit" no se reconocia como ese producto.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('precios-productos');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { updateSettings, getSettings } = require('../src/settings');
const { updateSession, getSession } = require('../src/state');
const catalog = require('../src/catalog');
const orders = require('../src/dropanasOrderAutomation');
const prepay = require('../src/prepayShipping');

after(() => cleanup(dataDir));

orders.saveConfig({
  uploadEnabled: true, autoCreateEnabled: false,
  mappings: [
    { id: 'shilajit', label: 'Shilajit Viking', aliases: ['shilajit', 'shilajit viking'], productId: 20343, warehouseId: 1, prices: { 1: 36900, 2: 51900 }, enabled: true },
    { id: 'shilajit-resina', label: 'Shilajit Resina', aliases: ['shilajit resina', 'shilajit de resina', 'resina shilajit'], productId: 20448, warehouseId: 1, prices: { 1: 36900, 2: 51900 }, enabled: true },
    { id: 'turkesterone', label: 'Turkesterone', aliases: ['turkesterone'], productId: 20702, warehouseId: 1, prices: { 1: 39900 }, enabled: true },
  ],
});
catalog.createProduct({ name: 'Shilajit gomitas masticables', price: 38900, prepayDiscountType: 'amount', prepayDiscountValue: 9000 });
catalog.createProduct({ name: 'Turkesterone', price: 39900 });
updateSettings({ prepayEnabled: true, prepayActivatedAt: null, prepayDiscountPercent: 10, prepayShippingAmount: '4000', prepayPaymentInfo: 'Banco X 0414' });

const PHONE = '584244726834';
function seed(producto) {
  updateSession(PHONE, {
    name: 'Jose', stage: 'vendido', orderClosed: true, soldAt: new Date().toISOString(), prepay: undefined,
    history: [{ role: 'user', content: 'listo', at: new Date().toISOString() }],
    card: { nombre: 'Jose Luis Bastidas', cedula: '21670118', telefono: '04244726834', ciudad: 'Tinaquillo', producto, productos: [{ nombre: producto.replace(/^\d+ frascos? de /, ''), cantidad: Number(producto.match(/^\d+/)?.[0] || 1) }] },
  });
}

test('"Resina de Shilajit" toma el precio y el descuento de Productos', () => {
  assert.equal(catalog.productForOrderItem('1 frasco de Resina de Shilajit', { id: 'shilajit-resina', label: 'Shilajit Resina', aliases: ['resina shilajit'] }).name, 'Shilajit gomitas masticables');
  seed('1 frasco de Resina de Shilajit');
  const draft = orders.baseDraft(PHONE, getSession(PHONE));
  assert.equal(draft.items[0].total, 38900);
  assert.equal(draft.items[0].priceSource, 'productos');
});

test('la oferta dice el descuento de Productos y el envio con "Bs"', async () => {
  seed('1 frasco de Resina de Shilajit');
  let sent = null;
  const deps = { sendButtons: async (to, text) => { sent = text; return {}; }, sendText: async () => {}, notifyAdmin: async () => {}, maybeCreate: () => {}, sessions: () => [] };
  assert.equal(await prepay.offerAfterClose(PHONE, deps, getSettings()), true);
  assert.match(sent, /\(4\.000 Bs\)/);
  assert.match(sent, /9\.000 Bs del producto \(al retirar pagas 29\.900 Bs en vez de 38\.900 Bs\)/);
});

test('cantidad sin precio en Productos: usa la tabla vieja y lo avisa', () => {
  seed('2 frascos de Shilajit Viking');
  const draft = orders.baseDraft(PHONE, getSession(PHONE));
  assert.equal(draft.items[0].total, 51900);
  assert.equal(draft.items[0].priceSource, 'subir_pedidos');
  assert.ok(draft.attemptNotes.some((n) => /tabla vieja/.test(n)));
});

test('dos productos posibles: no adivina', () => {
  catalog.createProduct({ name: 'Shilajit Viking Premium', price: 50000 });
  assert.equal(catalog.productForOrderItem('Resina de Shilajit', { id: 'x', label: 'Shilajit Resina', aliases: [] }), null);
});

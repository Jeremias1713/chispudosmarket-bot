'use strict';
// Descuento por pagar el envio por adelantado: oferta con botones al cerrar,
// datos de pago movil, captura, confirmacion de Jere y descuento en DroPanas.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('prepay-shipping');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { updateSettings, getSettings } = require('../src/settings');
const { getSession, updateSession } = require('../src/state');
const prepay = require('../src/prepayShipping');
const orders = require('../src/dropanasOrderAutomation');

after(() => cleanup(dataDir));

const PHONE = '584120000901';
const NOW = new Date();

updateSettings({
  prepayEnabled: true, prepayActivatedAt: '2026-01-01T00:00:00.000Z', prepayDiscountPercent: 10,
  prepayShippingAmount: '450 Bs', prepayPaymentInfo: 'Banco X\n0414-0000000\nV-12345678',
});

function seed(extra = {}) {
  updateSession(PHONE, {
    name: 'Maria', stage: 'vendido', orderClosed: true, soldAt: new Date(NOW.getTime() - 60000).toISOString(),
    history: [{ role: 'user', content: 'listo', at: new Date().toISOString() }],
    card: { nombre: 'Maria Perez', producto: 'Shilajit', monto: 50000 },
    prepay: undefined, paused: false, attention: undefined,
    ...extra,
  });
}

function deps() {
  const calls = { buttons: [], texts: [], pushes: [], created: [] };
  return {
    calls,
    sendButtons: async (to, text, buttons) => { calls.buttons.push({ to, text, buttons }); },
    sendText: async (to, text) => { calls.texts.push(text); },
    notifyAdmin: async (t, b) => { calls.pushes.push(b); },
    maybeCreate: (phone) => { calls.created.push(phone); },
    sessions: () => [{ ...getSession(PHONE), phone: PHONE }],
  };
}

test('al cerrar la venta ofrece el descuento con botones y la subida a DroPanas espera', async () => {
  seed();
  const d = deps();
  assert.equal(await prepay.offerAfterClose(PHONE, d), true);
  assert.deepEqual(d.calls.buttons[0].buttons.map((b) => b.id), ['pp_yes', 'pp_no']);
  assert.match(d.calls.buttons[0].text, /450 Bs.*5\.000 Bs del producto.*45\.000 Bs en vez de 50\.000 Bs/);
  assert.equal(getSession(PHONE).prepay.status, 'offered');
  assert.equal(prepay.gate(getSession(PHONE)).ok, false);
  // Una sola oferta por venta.
  assert.equal(await prepay.offerAfterClose(PHONE, d), false);
});

test('sin monto del envio o sin datos de pago no se ofrece nada', async () => {
  seed();
  const d = deps();
  assert.equal(await prepay.offerAfterClose(PHONE, d, { ...getSettings(), prepayPaymentInfo: '' }), false);
  assert.equal(d.calls.buttons.length, 0);
});

test('"Pago al retirar": sigue contra entrega y se sube el pedido', async () => {
  seed();
  const d = deps();
  await prepay.offerAfterClose(PHONE, d);
  assert.equal(await prepay.handleReply(PHONE, 'pp_no', d), true);
  assert.equal(getSession(PHONE).prepay.status, 'declined');
  assert.deepEqual(d.calls.created, [PHONE]);
  assert.equal(prepay.gate(getSession(PHONE)).ok, true);
});

test('"Sí": manda los datos de pago, recibe la captura, Jere confirma y se aplica el descuento', async () => {
  seed();
  const d = deps();
  await prepay.offerAfterClose(PHONE, d);
  await prepay.handleReply(PHONE, 'pp_yes', d);
  assert.equal(getSession(PHONE).prepay.status, 'awaiting_payment');
  assert.match(d.calls.texts[0], /0414-0000000/);
  assert.equal(await prepay.handleReceipt(PHONE, { mediaUrl: 'https://x/cap.jpg' }, d), true);
  assert.equal(getSession(PHONE).prepay.status, 'receipt_sent');
  assert.equal(d.calls.pushes.length, 1);
  assert.equal(prepay.pending().length, 1);
  assert.equal(prepay.gate(getSession(PHONE)).ok, false);
  const r = await prepay.decide(PHONE, true, d);
  assert.equal(r.ok, true);
  assert.equal(getSession(PHONE).prepay.status, 'paid');
  assert.match(d.calls.texts.at(-1), /45\.000 Bs en vez de 50\.000 Bs/);
  assert.deepEqual(d.calls.created, [PHONE]);
  assert.equal(prepay.discountPercentFor(getSession(PHONE)), 10);
});

test('el pedido a DroPanas sube con el precio del producto con descuento y la nota', () => {
  const draft = {
    official: { office: { id: 7, state_id: 1, city_id: 2, nombre: 'Sabana Grande', direccion: 'Av' } },
    identity: { nombre: 'Maria', apellido: 'Perez' }, customerPhone: '04140000000', cedula: '123',
    items: [{ mapping: { productId: 9, warehouseId: 1 }, quantity: 2, total: 100000 }],
    prepayDiscountPercent: 10,
  };
  const payload = orders.buildPayload(draft, 'REF');
  assert.equal(payload.productos[0].precio_venta_ves, 45000);
  assert.match(payload.nota_cliente, /ENVIO PAGADO POR ADELANTADO/);
  const normal = orders.buildPayload({ ...draft, prepayDiscountPercent: 0 }, 'REF');
  assert.equal(normal.productos[0].precio_venta_ves, 50000);
});

test('oferta sin respuesta: a las 2 horas sigue contra entrega', async () => {
  seed();
  const d = deps();
  await prepay.offerAfterClose(PHONE, d);
  await prepay.tick(new Date(Date.now() + 121 * 60000), d);
  assert.equal(getSession(PHONE).prepay.status, 'expired');
  assert.deepEqual(d.calls.created, [PHONE]);
});

test('eligio pagar y no mando la captura: a las 12 horas sigue contra entrega y avisa', async () => {
  seed();
  const d = deps();
  await prepay.offerAfterClose(PHONE, d);
  await prepay.handleReply(PHONE, 'pp_yes', d);
  await prepay.tick(new Date(Date.now() + 13 * 3600000), d);
  assert.equal(getSession(PHONE).prepay.status, 'expired');
  assert.equal(d.calls.pushes.length, 1);
});

test('Jere rechaza el pago: queda contra entrega con el precio completo', async () => {
  seed();
  const d = deps();
  await prepay.offerAfterClose(PHONE, d);
  await prepay.handleReply(PHONE, 'pp_yes', d);
  await prepay.decide(PHONE, false, d);
  assert.equal(getSession(PHONE).prepay.status, 'rejected');
  assert.equal(prepay.discountPercentFor(getSession(PHONE)), 0);
  assert.match(d.calls.texts.at(-1), /pago completo al retirar/);
});

test('un chat con reclamo abierto no recibe la oferta', async () => {
  seed({ attention: { open: true }, paused: true });
  const d = deps();
  assert.equal(await prepay.offerAfterClose(PHONE, d), false);
});

// --- Descuento propio de cada producto (pestaña Productos) ---
const catalog = require('../src/catalog');

function seedProduct(producto, monto, extra = {}) {
  seed({ card: { nombre: 'Maria Perez', producto, monto } });
  return catalog.createProduct({ name: producto, price: monto, ...extra });
}

test('producto con monto fijo en Bs: se ofrece y se sube ese monto, no el % general', async () => {
  seedProduct('Colageno Marino', 40000, { prepayDiscountType: 'amount', prepayDiscountValue: 3000 });
  const d = deps();
  assert.equal(await prepay.offerAfterClose(PHONE, d), true);
  assert.match(d.calls.buttons[0].text, /3\.000 Bs del producto.*37\.000 Bs en vez de 40\.000 Bs/);
  assert.equal(getSession(PHONE).prepay.discountBs, 3000);
  await prepay.handleReply(PHONE, 'pp_yes', d);
  await prepay.decide(PHONE, true, d);
  assert.match(d.calls.texts.at(-1), /3\.000 Bs de descuento: al retirar pagas 37\.000 Bs/);
  const items = [{ productName: 'Colageno Marino', total: 40000, quantity: 1 }];
  assert.deepEqual(prepay.discountLinesFor(getSession(PHONE), items), [3000]);
  const payload = orders.buildPayload({
    official: { office: { id: 7, state_id: 1, city_id: 2, nombre: 'X', direccion: 'Av' } },
    identity: { nombre: 'Maria', apellido: 'Perez' }, customerPhone: '04140000000', cedula: '123',
    items: [{ mapping: { productId: 9, warehouseId: 1 }, quantity: 2, total: 40000 }],
    prepayItemDiscounts: [3000], prepayDiscountBs: 3000,
  }, 'REF');
  assert.equal(payload.productos[0].precio_venta_ves, 18500);
  assert.match(payload.nota_cliente, /3000 Bs de descuento/);
});

test('producto con % propio usa ese % y no el general', async () => {
  seedProduct('Magnesio Plus', 20000, { prepayDiscountType: 'percent', prepayDiscountValue: 25 });
  const d = deps();
  await prepay.offerAfterClose(PHONE, d);
  assert.equal(getSession(PHONE).prepay.discountBs, 5000);
});

test('producto marcado "sin descuento": no se ofrece nada y el pedido sigue normal', async () => {
  seedProduct('Te Detox', 15000, { prepayDiscountType: 'none' });
  const d = deps();
  assert.equal(await prepay.offerAfterClose(PHONE, d), false);
  assert.equal(d.calls.buttons.length, 0);
  assert.equal(prepay.gate(getSession(PHONE)).ok, true);
});

test('el monto fijo nunca deja el producto en negativo', () => {
  assert.equal(prepay.computeDiscount({ card: { producto: 'nada' } }, getSettings()).discountBs, 0);
  const rule = prepay.ruleFor({ prepayDiscountType: 'amount', prepayDiscountValue: 99999 });
  assert.deepEqual(rule, { type: 'amount', value: 99999 });
});

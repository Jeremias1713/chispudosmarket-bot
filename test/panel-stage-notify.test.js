// Hallazgo 4 del reporte: marcar manualmente un pedido como "esperando_retiro"
// (llego a la agencia) tiene que disparar el aviso de LLEGADA, nunca el de
// DESPACHO ("ya esta en camino") -- son mensajes contradictorios si se
// mezclan. Tambien confirma que el retiro en tienda propia (tienda_maracaibo)
// sigue funcionando y no dispara ningun aviso de guia/agencia (no aplica).
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('panel-stage-notify');
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const shipping = require('../src/shipping');
const panelRouter = require('../src/web/panel');

after(() => cleanup(dataDir));

function findHandler(method, path) {
  const layer = panelRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no se encontro ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

let originalShippingNotify, originalArrivalNotify;
let shippingCalls, arrivalCalls;
beforeEach(() => {
  originalShippingNotify = shipping.maybeNotifyShipping;
  originalArrivalNotify = shipping.maybeNotifyArrival;
  shippingCalls = [];
  arrivalCalls = [];
  shipping.maybeNotifyShipping = async (phone) => { shippingCalls.push(phone); return { sent: true }; };
  shipping.maybeNotifyArrival = async (phone) => { arrivalCalls.push(phone); return { sent: true }; };
});
afterEach(() => {
  shipping.maybeNotifyShipping = originalShippingNotify;
  shipping.maybeNotifyArrival = originalArrivalNotify;
});

function sesionBase(overrides) {
  return {
    step: 'IDLE', cart: [], history: [], name: 'Carlos', stage: 'vendido', stageLocked: false,
    paused: false, pausedReason: null, card: { nombre: 'Carlos', producto: 'Shilajit', guia: 'GU-900' },
    adCode: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

async function esperarMicrotareas() {
  // maybeNotifyShipping/maybeNotifyArrival se llaman "fire-and-forget"
  // (sin await) desde el handler: se espera un tick para que el mock
  // (async, resuelve al toque) ya haya corrido antes de revisar los arrays.
  await new Promise((resolve) => setImmediate(resolve));
}

test('marcar "esperando_retiro" (llegada) dispara maybeNotifyArrival, NUNCA maybeNotifyShipping', async () => {
  const phone = '584120000200';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionBase() }));

  const handler = findHandler('post', '/api/conversations/:phone/stage');
  await handler({ params: { phone }, body: { stage: 'esperando_retiro' } }, fakeRes());
  await esperarMicrotareas();

  assert.deepEqual(arrivalCalls, [phone], 'BUG H-aviso-llegada si esto no se llamo: marcar la llegada debe avisar la llegada');
  assert.deepEqual(shippingCalls, [], 'BUG H-aviso-llegada si esto se llamo: marcar la llegada NO debe mandar el aviso de "ya esta en camino"');
});

test('marcar "en_camino" (despacho) dispara maybeNotifyShipping, NUNCA maybeNotifyArrival', async () => {
  const phone = '584120000201';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionBase() }));

  const handler = findHandler('post', '/api/conversations/:phone/stage');
  await handler({ params: { phone }, body: { stage: 'en_camino' } }, fakeRes());
  await esperarMicrotareas();

  assert.deepEqual(shippingCalls, [phone]);
  assert.deepEqual(arrivalCalls, []);
});

test('marcar "entregado" no dispara ningun aviso de guia (ni despacho ni llegada)', async () => {
  const phone = '584120000202';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionBase({ stage: 'esperando_retiro' }) }));

  const handler = findHandler('post', '/api/conversations/:phone/stage');
  await handler({ params: { phone }, body: { stage: 'entregado' } }, fakeRes());
  await esperarMicrotareas();

  assert.deepEqual(shippingCalls, []);
  assert.deepEqual(arrivalCalls, []);
});

test('el retiro en tienda propia (tienda_maracaibo) sigue funcionando y no dispara avisos de guia/agencia', async () => {
  const phone = '584120000203';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ stage: 'vendido', card: { nombre: 'Carlos', producto: 'Shilajit', ciudad: 'Maracaibo' } }),
  }));

  const handler = findHandler('post', '/api/conversations/:phone/stage');
  const res = fakeRes();
  await handler({ params: { phone }, body: { stage: 'tienda_maracaibo' } }, res);
  await esperarMicrotareas();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stage, 'tienda_maracaibo');
  const { getSession } = require('../src/state');
  assert.equal(getSession(phone).stage, 'tienda_maracaibo');
  assert.deepEqual(shippingCalls, [], 'tienda propia no usa guia de envio, no deberia disparar el aviso de despacho');
  assert.deepEqual(arrivalCalls, [], 'tienda propia no usa agencia Tealca, no deberia disparar el aviso de llegada a agencia');
});

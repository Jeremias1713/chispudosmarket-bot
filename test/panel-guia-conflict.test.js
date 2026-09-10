// FASE 3 (H08, solucion intermedia): POST /api/conversations/:phone/guia
// responde 409 (sin guardar nada) cuando la guia nueva parece ser de OTRA
// compra del mismo cliente, en vez de pisar en silencio el pedido anterior.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('panel-guia-conflict');
const { test, after } = require('node:test');
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

test('H08 - guardar una guia distinta de un pedido ya avisado responde 409 y NO guarda nada', async () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': {
      step: 'IDLE', cart: [], history: [], name: 'Carlos', stage: 'en_camino', stageLocked: false,
      stageReason: null, paused: false, pausedReason: null,
      card: { nombre: 'Carlos', guia: 'GU-001', producto: 'Shilajit', monto: 38900 },
      shippingNotifiedAt: '2026-08-01T00:00:00.000Z',
      adCode: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    },
  }));

  const original = shipping.maybeNotifyShipping;
  let seLlamoAlAviso = false;
  shipping.maybeNotifyShipping = async () => { seLlamoAlAviso = true; return { sent: true }; };

  const handler = findHandler('post', '/api/conversations/:phone/guia');
  const req = { params: { phone: '584120000001' }, body: { guia: 'GU-002' } };
  const res = fakeRes();
  await handler(req, res);

  shipping.maybeNotifyShipping = original;

  assert.equal(res.statusCode, 409, 'BUG H08 si esto no es 409: se sobrescribio el pedido anterior en silencio');
  assert.equal(res.body.pedidoAnterior.guia, 'GU-001');
  assert.equal(seLlamoAlAviso, false, 'no debe intentar avisar nada de un guardado que se rechazo');
});

test('H08 - con confirmNewOrder=true, guarda igual la guia nueva (el operador confirmo que es otro pedido)', async () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000002': {
      step: 'IDLE', cart: [], history: [], name: 'Carlos', stage: 'en_camino', stageLocked: false,
      stageReason: null, paused: false, pausedReason: null,
      card: { nombre: 'Carlos', guia: 'GU-001', producto: 'Shilajit', monto: 38900 },
      shippingNotifiedAt: '2026-08-01T00:00:00.000Z',
      adCode: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    },
  }));

  const original = shipping.maybeNotifyShipping;
  shipping.maybeNotifyShipping = async () => ({ sent: false, reason: 'sin_plantilla' });

  const handler = findHandler('post', '/api/conversations/:phone/guia');
  const req = { params: { phone: '584120000002' }, body: { guia: 'GU-002', confirmNewOrder: 'true' } };
  const res = fakeRes();
  await handler(req, res);

  shipping.maybeNotifyShipping = original;

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.card.guia, 'GU-002');
});

test('sin conflicto (primera guia del pedido), guarda normal con 200', async () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000003': {
      step: 'IDLE', cart: [], history: [], name: 'Carlos', stage: 'vendido', stageLocked: false,
      stageReason: null, paused: false, pausedReason: null,
      card: { nombre: 'Carlos' },
      adCode: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    },
  }));

  const original = shipping.maybeNotifyShipping;
  shipping.maybeNotifyShipping = async () => ({ sent: false, reason: 'sin_plantilla' });

  const handler = findHandler('post', '/api/conversations/:phone/guia');
  const req = { params: { phone: '584120000003' }, body: { guia: 'GU-001' } };
  const res = fakeRes();
  await handler(req, res);

  shipping.maybeNotifyShipping = original;

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.card.guia, 'GU-001');
});

// Hallazgo 1 del reporte: registrar una guia valida debe poder avanzar de
// "vendido"/"esperando_guia" a "en_camino" AUNQUE la etapa se haya fijado a
// mano desde el panel (stageLocked), tanto cargando la guia una por una
// (POST /api/conversations/:phone/guia) como confirmando el lote de
// Dropanas (POST /api/dropanas/confirm) -- mismo resultado en los dos
// caminos, sin retroceder pedidos que ya estan en esperando_retiro/entregado.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('panel-guia-advance');
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const shipping = require('../src/shipping');
const panelRouter = require('../src/web/panel');
const { getSession } = require('../src/state');

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

let originalShippingNotify;
let originalArrivalNotify;
let shippingCalls;
let arrivalCalls;
beforeEach(() => {
  originalShippingNotify = shipping.maybeNotifyShipping;
  originalArrivalNotify = shipping.maybeNotifyArrival;
  shippingCalls = [];
  arrivalCalls = [];
  shipping.maybeNotifyShipping = async (phone, session) => { shippingCalls.push(phone); return { sent: true }; };
  shipping.maybeNotifyArrival = async (phone, session) => { arrivalCalls.push(phone); return { sent: true }; };
});
afterEach(() => {
  shipping.maybeNotifyShipping = originalShippingNotify;
  shipping.maybeNotifyArrival = originalArrivalNotify;
});

function sesionBase(overrides) {
  return {
    step: 'IDLE', cart: [], history: [], name: 'Carlos', paused: false, pausedReason: null,
    card: { nombre: 'Carlos', producto: 'Shilajit' },
    adCode: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

test('carga individual: "esperando_guia" fijado a mano (stageLocked) + guia valida -> avanza a en_camino', async () => {
  const phone = '584120000100';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ stage: 'esperando_guia', stageLocked: true, stageReason: 'Fijada desde el panel' }),
  }));

  const handler = findHandler('post', '/api/conversations/:phone/guia');
  const req = { params: { phone }, body: { guia: 'GU-500' } };
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const updated = getSession(phone);
  assert.equal(updated.stage, 'en_camino', 'BUG H-stageLocked si esto no avanzo: el candado manual no deberia bloquear el despacho');
  assert.equal(updated.card.guia, 'GU-500');
  assert.deepEqual(shippingCalls, [phone]);
});

test('carga por lote (dropanas/confirm): mismo resultado que la carga individual', async () => {
  const phone = '584120000101';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ stage: 'esperando_guia', stageLocked: true, stageReason: 'Fijada desde el panel' }),
  }));

  const handler = findHandler('post', '/api/dropanas/confirm');
  const req = { body: { items: [{ phone, guia: 'GU-501' }] } };
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results[0].ok, true);
  const updated = getSession(phone);
  assert.equal(updated.stage, 'en_camino', 'BUG si esto no avanzo: el lote debe comportarse igual que la carga individual');
  assert.equal(updated.card.guia, 'GU-501');
});

test('vendido (sin candado) + guia valida -> tambien avanza a en_camino (caso normal, sin cambios)', async () => {
  const phone = '584120000102';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ stage: 'vendido', stageLocked: false }),
  }));

  const handler = findHandler('post', '/api/conversations/:phone/guia');
  const req = { params: { phone }, body: { guia: 'GU-502' } };
  const res = fakeRes();
  await handler(req, res);

  assert.equal(getSession(phone).stage, 'en_camino');
});

test('cargar la guia del MISMO pedido no retrocede un pedido ya en esperando_retiro', async () => {
  const phone = '584120000103';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({
      stage: 'esperando_retiro', stageLocked: true,
      card: { nombre: 'Carlos', producto: 'Shilajit', guia: 'GU-503' },
      shippingNotifiedAt: '2026-08-01T00:00:00.000Z',
      arrivalNotifiedAt: '2026-08-02T00:00:00.000Z',
    }),
  }));

  // Corrige un dato (agencia), sin cambiar el numero de guia: sigue siendo
  // el MISMO pedido, no hay confirmNewOrder.
  const handler = findHandler('post', '/api/conversations/:phone/guia');
  const req = { params: { phone }, body: { guia: 'GU-503', agencia: 'Tealca Norte' } };
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  const updated = getSession(phone);
  assert.equal(updated.stage, 'esperando_retiro', 'BUG si esto retrocedio: cargar la guia del mismo pedido no debe "desretirar" el pedido');
  assert.equal(updated.card.agencia, 'Tealca Norte');
});

test('cargar la guia del MISMO pedido no retrocede un pedido ya entregado', async () => {
  const phone = '584120000104';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({
      stage: 'entregado', stageLocked: false,
      card: { nombre: 'Carlos', producto: 'Shilajit', guia: 'GU-504' },
      shippingNotifiedAt: '2026-08-01T00:00:00.000Z',
    }),
  }));

  const handler = findHandler('post', '/api/conversations/:phone/guia');
  const req = { params: { phone }, body: { guia: 'GU-504' } };
  const res = fakeRes();
  await handler(req, res);

  assert.equal(getSession(phone).stage, 'entregado', 'BUG si esto retrocedio: un pedido entregado no puede volver a en_camino');
});

test('repetir la carga de la misma guia (end-to-end, sin mockear shipping) no duplica el aviso real', async () => {
  const metaTemplates = require('../src/metaTemplates');
  const whatsapp = require('../src/whatsapp');
  const { updateSettings } = require('../src/settings');

  // Este test SI usa el shipping.js real (no el mock de beforeEach): lo
  // restauramos aca puntualmente para probar la deduplicacion end-to-end a
  // traves del endpoint del panel.
  shipping.maybeNotifyShipping = originalShippingNotify;

  metaTemplates._setCacheForTests([{
    name: 'guia_del_pedido', language: 'es', status: 'APPROVED',
    components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hola {{1}}, {{2}} ({{3}}) via {{4}}, pagas {{5}}.' }],
  }]);
  updateSettings({ shippingTemplateName: 'guia_del_pedido' });
  const originalSendTemplate = whatsapp.sendTemplate;
  let vecesEnviado = 0;
  whatsapp.sendTemplate = async () => { vecesEnviado++; return { wamid: 'wamid.REAL-1' }; };

  const phone = '584120000105';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ stage: 'vendido', stageLocked: false, card: { nombre: 'Carlos', producto: 'Shilajit', guiaImageUrl: 'https://cdn.example.com/g.jpg' } }),
  }));

  const handler = findHandler('post', '/api/conversations/:phone/guia');
  const res1 = fakeRes();
  await handler({ params: { phone }, body: { guia: 'GU-505' } }, res1);
  assert.equal(res1.body.notice.sent, true);
  assert.equal(vecesEnviado, 1);

  // Recargar la MISMA guia (por ejemplo el operador aprieta guardar dos
  // veces sin querer): el aviso real ya se mando, no se puede repetir.
  const res2 = fakeRes();
  await handler({ params: { phone }, body: { guia: 'GU-505' } }, res2);
  assert.equal(res2.body.notice.sent, false);
  assert.equal(res2.body.notice.reason, 'ya_avisado');
  assert.equal(vecesEnviado, 1, 'BUG si esto es 2: se duplico el aviso real al cliente');

  whatsapp.sendTemplate = originalSendTemplate;
  metaTemplates._setCacheForTests([]);
});

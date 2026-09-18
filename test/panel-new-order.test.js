// Hallazgo 5 del reporte: al confirmar que una guia nueva es de OTRA compra
// del mismo cliente (confirmNewOrder=true, ver orderGuard.js), no hay que
// arrastrar en silencio los datos/marcas TECNICOS del pedido anterior (foto,
// agencia, monto, avisos ya mandados): la guia de la compra NUEVA tiene que
// poder avisarse de verdad, y no reusar shippingNotifiedAt del pedido viejo.
// Los datos PERSONALES del cliente y el historial de mensajes se conservan.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('panel-new-order');
const { test, after } = require('node:test');
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

const SESION_PEDIDO_VIEJO = {
  step: 'IDLE', cart: [], history: [{ role: 'user', content: 'hola', at: '2026-07-01T00:00:00.000Z' }],
  name: 'Carlos', stage: 'entregado', stageLocked: false,
  card: {
    nombre: 'Carlos', ciudad: 'Caracas', telefono: '04120000000', cedula: 'V12345678', notas: 'cliente frecuente',
    producto: 'Shilajit', guia: 'GU-OLD-1', agencia: 'Tealca Viejo', monto: 30000, guiaImageUrl: 'https://cdn.example.com/vieja.jpg',
  },
  shippingNotifiedAt: '2026-07-02T00:00:00.000Z',
  arrivalNotifiedAt: '2026-07-03T00:00:00.000Z',
  soldAt: '2026-07-01T12:00:00.000Z',
  orderClosed: true,
  adCode: null, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-03T00:00:00.000Z',
};

test('confirmNewOrder=true reinicia los datos/marcas TECNICOS del pedido anterior (individual)', async () => {
  const phone = '584120000300';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: SESION_PEDIDO_VIEJO }));

  const original = shipping.maybeNotifyShipping;
  shipping.maybeNotifyShipping = async () => ({ sent: true });

  const handler = findHandler('post', '/api/conversations/:phone/guia');
  const req = { params: { phone }, body: { guia: 'GU-NEW-1', confirmNewOrder: 'true' } };
  const res = fakeRes();
  await handler(req, res);

  shipping.maybeNotifyShipping = original;

  assert.equal(res.statusCode, 200);
  const updated = getSession(phone);
  // Datos TECNICOS del pedido viejo: reiniciados.
  assert.equal(updated.card.guia, 'GU-NEW-1');
  assert.equal(updated.card.guiaImageUrl, null, 'no debe heredar la foto de la guia del pedido anterior');
  assert.equal(updated.card.agencia, null, 'no debe heredar la agencia del pedido anterior');
  assert.equal(updated.card.monto, null, 'no debe heredar el monto del pedido anterior');
  assert.equal(updated.shippingNotifiedAt, null, 'BUG H-nuevo-pedido si esto sigue con la fecha vieja: el aviso de la guia nueva quedaria bloqueado');
  assert.equal(updated.arrivalNotifiedAt, null);
  assert.equal(updated.orderClosed, false);
  assert.notEqual(updated.soldAt, SESION_PEDIDO_VIEJO.soldAt, 'la fecha de venta tiene que ser la de HOY, no la del pedido viejo');
  // Avanza a en_camino aunque el pedido anterior estaba "entregado".
  assert.equal(updated.stage, 'en_camino');

  // Datos PERSONALES: se conservan.
  assert.equal(updated.card.nombre, 'Carlos');
  assert.equal(updated.card.ciudad, 'Caracas');
  assert.equal(updated.card.telefono, '04120000000');
  assert.equal(updated.card.cedula, 'V12345678');
  assert.equal(updated.card.notas, 'cliente frecuente');
  // Historial: se conserva integro.
  assert.equal(updated.history.length, 1);
  assert.equal(updated.history[0].content, 'hola');
});

test('confirmNewOrder=true tambien reinicia las marcas en la confirmacion por lote', async () => {
  const phone = '584120000301';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: SESION_PEDIDO_VIEJO }));

  const original = shipping.maybeNotifyShipping;
  shipping.maybeNotifyShipping = async () => ({ sent: true });

  const handler = findHandler('post', '/api/dropanas/confirm');
  const req = { body: { items: [{ phone, guia: 'GU-NEW-2', confirmNewOrder: true }] } };
  const res = fakeRes();
  await handler(req, res);

  shipping.maybeNotifyShipping = original;

  assert.equal(res.body.results[0].ok, true);
  const updated = getSession(phone);
  assert.equal(updated.card.guia, 'GU-NEW-2');
  assert.equal(updated.shippingNotifiedAt, null);
  assert.equal(updated.stage, 'en_camino');
  // Personales conservados tambien en el camino de lote.
  assert.equal(updated.card.nombre, 'Carlos');
  assert.equal(updated.card.telefono, '04120000000');
});

test('una nueva compra confirmada SI puede notificar su propia guia (no queda bloqueada por "ya_avisado" del pedido anterior)', async () => {
  const metaTemplates = require('../src/metaTemplates');
  const whatsapp = require('../src/whatsapp');
  const { updateSettings } = require('../src/settings');

  metaTemplates._setCacheForTests([{
    name: 'guia_del_pedido', language: 'es', status: 'APPROVED',
    components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hola {{1}}, {{2}} ({{3}}) via {{4}}, pagas {{5}}.' }],
  }]);
  updateSettings({ shippingTemplateName: 'guia_del_pedido' });
  const originalSendTemplate = whatsapp.sendTemplate;
  let vecesEnviado = 0;
  whatsapp.sendTemplate = async () => { vecesEnviado++; return { wamid: 'wamid.NUEVO-1' }; };

  const phone = '584120000302';
  // El pedido viejo ya tenia guiaImageUrl (de la compra anterior); esta vez
  // el operador manda una foto NUEVA junto con la guia nueva.
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: SESION_PEDIDO_VIEJO }));

  const handler = findHandler('post', '/api/conversations/:phone/guia');
  const req = { params: { phone }, body: { guia: 'GU-NEW-3', confirmNewOrder: 'true' } };
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.body.notice.sent, true, 'BUG H-nuevo-pedido si esto es false: el aviso de la guia nueva no se pudo mandar');
  assert.equal(vecesEnviado, 1);

  whatsapp.sendTemplate = originalSendTemplate;
  metaTemplates._setCacheForTests([]);
});

test('sin confirmNewOrder (misma guia, mismo pedido) NO se reinician los datos tecnicos', async () => {
  const phone = '584120000303';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: { ...SESION_PEDIDO_VIEJO, stage: 'esperando_retiro', card: { ...SESION_PEDIDO_VIEJO.card, guia: 'GU-SAME' } },
  }));

  const original = shipping.maybeNotifyShipping;
  shipping.maybeNotifyShipping = async () => ({ sent: true });

  const handler = findHandler('post', '/api/conversations/:phone/guia');
  // Corrige la agencia, misma guia, sin confirmNewOrder: es el MISMO pedido.
  const req = { params: { phone }, body: { guia: 'GU-SAME', agencia: 'Tealca Corregida' } };
  const res = fakeRes();
  await handler(req, res);

  shipping.maybeNotifyShipping = original;

  const updated = getSession(phone);
  assert.equal(updated.card.agencia, 'Tealca Corregida');
  assert.equal(updated.card.monto, 30000, 'sin confirmNewOrder, el monto del mismo pedido no se pisa');
  assert.equal(updated.shippingNotifiedAt, SESION_PEDIDO_VIEJO.shippingNotifiedAt, 'sin confirmNewOrder, la marca de aviso del mismo pedido se conserva');
  assert.equal(updated.stage, 'esperando_retiro', 'sin confirmNewOrder no se fuerza el avance de un pedido ya mas adelante');
});

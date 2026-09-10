// FASE 2 (H06/H17): endpoints nuevos del panel para plantillas --
// previsualizar sin mandar nada, y "probar en mi numero" generico para
// cualquier plantilla aprobada. Se invocan los handlers reales de la ruta
// directamente (mismo patron que panel-settings-and-login.test.js), sin
// levantar un servidor HTTP ni tocar la red: se monkeypatchea
// whatsapp.sendTemplate para las pruebas de envio.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const metaTemplates = require('../src/metaTemplates');
const whatsapp = require('../src/whatsapp');
const panelRouter = require('../src/web/panel');

const PLANTILLA = {
  name: 'guia_del_pedido',
  language: 'es',
  components: [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Hola {{1}}, tu pedido de {{2}} salio con guia {{3}}.' },
    { type: 'FOOTER', text: 'Chispudos Market' },
  ],
};

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

before(() => metaTemplates._setCacheForTests([PLANTILLA]));
after(() => metaTemplates._setCacheForTests([]));

test('H06/H17 - POST /api/templates/:name/preview arma el contenido sin mandar nada', async () => {
  let sePreguntoAWhatsapp = false;
  const original = whatsapp.sendTemplate;
  whatsapp.sendTemplate = async () => { sePreguntoAWhatsapp = true; };

  const handler = findHandler('post', '/api/templates/:name/preview');
  const req = { params: { name: 'guia_del_pedido' }, body: { values: ['Juan', 'Shilajit', 'ABC1'], languageCode: 'es' } };
  const res = fakeRes();
  await handler(req, res);

  whatsapp.sendTemplate = original;
  assert.equal(sePreguntoAWhatsapp, false);
  assert.equal(res.body.snapshot.bodyText, 'Hola Juan, tu pedido de Shilajit salio con guia ABC1.');
});

test('H06/H17 - POST /api/templates/:name/preview con una plantilla que no existe responde 404 (no inventa contenido)', async () => {
  const handler = findHandler('post', '/api/templates/:name/preview');
  const req = { params: { name: 'no_existe_esta_plantilla' }, body: { values: [] } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 404);
});

test('H17 - POST /api/templates/:name/test-send manda de verdad (via whatsapp.sendTemplate) al numero indicado y devuelve el mismo snapshot', async () => {
  const original = whatsapp.sendTemplate;
  let telefonoUsado = null;
  whatsapp.sendTemplate = async (to) => { telefonoUsado = to; return { wamid: 'wamid.TEST-SEND-1' }; };

  const handler = findHandler('post', '/api/templates/:name/test-send');
  const req = { params: { name: 'guia_del_pedido' }, body: { phone: '591 7000-0000', values: ['Juan', 'Shilajit', 'ABC1'] } };
  const res = fakeRes();
  await handler(req, res);

  whatsapp.sendTemplate = original;
  assert.equal(res.body.ok, true);
  assert.equal(res.body.wamid, 'wamid.TEST-SEND-1');
  assert.equal(telefonoUsado, '59170000000', 'el telefono de prueba se limpia de espacios/guiones antes de mandar');
  assert.equal(res.body.snapshot.bodyText, 'Hola Juan, tu pedido de Shilajit salio con guia ABC1.');
});

test('H17 - POST /api/templates/:name/test-send sin numero responde 400', async () => {
  const handler = findHandler('post', '/api/templates/:name/test-send');
  const req = { params: { name: 'guia_del_pedido' }, body: { values: [] } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

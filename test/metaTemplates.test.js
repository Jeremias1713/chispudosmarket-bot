// FASE 2 (H06/H17): metaTemplates.js trae las plantillas aprobadas de Meta
// CON su contenido completo (antes /api/templates en panel.js descartaba
// `components`, dejando solo name/language/category).
'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const metaTemplates = require('../src/metaTemplates');

afterEach(() => metaTemplates._setCacheForTests([]));

test('H06 - sin WHATSAPP_BUSINESS_ACCOUNT_ID/WHATSAPP_TOKEN, fetchApprovedTemplates no intenta llamar a Meta', async () => {
  const antes = { id: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID, token: process.env.WHATSAPP_TOKEN };
  delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  delete process.env.WHATSAPP_TOKEN;
  try {
    const resultado = await metaTemplates.fetchApprovedTemplates();
    assert.deepEqual(resultado, { available: false, templates: [] });
  } finally {
    if (antes.id != null) process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = antes.id;
    if (antes.token != null) process.env.WHATSAPP_TOKEN = antes.token;
  }
});

test('H06 - findApprovedTemplate encuentra por nombre e idioma exacto', async () => {
  metaTemplates._setCacheForTests([
    { name: 'guia_del_pedido', language: 'es', components: [{ type: 'BODY', text: 'v1' }] },
    { name: 'guia_del_pedido', language: 'es_MX', components: [{ type: 'BODY', text: 'v2' }] },
  ]);
  const t = await metaTemplates.findApprovedTemplate('guia_del_pedido', 'es_MX');
  assert.equal(t.components[0].text, 'v2');
});

test('H06 - findApprovedTemplate sin idioma exacto devuelve la primera coincidencia por nombre', async () => {
  metaTemplates._setCacheForTests([{ name: 'recordatorio', language: 'es', components: [] }]);
  const t = await metaTemplates.findApprovedTemplate('recordatorio', 'en');
  assert.ok(t, 'BUG a evitar: no encontrar la plantilla por diferencia de idioma cuando solo hay una version');
});

test('H06 - un nombre que no existe devuelve null (no inventa una plantilla)', async () => {
  metaTemplates._setCacheForTests([{ name: 'otra', language: 'es', components: [] }]);
  const t = await metaTemplates.findApprovedTemplate('no_existe', 'es');
  assert.equal(t, null);
});

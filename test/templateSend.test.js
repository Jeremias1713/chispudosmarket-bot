// FASE 2/5 (H06 + H17 + H35): templateSend.js es el UNICO lugar que arma el
// snapshot de una plantilla y la manda -- este test confirma que preview y
// envio real usan literalmente la misma funcion de armado
// (buildTemplateContent), y que si Meta no tiene la plantilla (o no hay
// credenciales) el snapshot queda en null en vez de inventarse.
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const metaTemplates = require('../src/metaTemplates');
const whatsapp = require('../src/whatsapp');
const { previewTemplateContent, sendTemplateWithSnapshot } = require('../src/templateSend');

const PLANTILLA_APROBADA = {
  name: 'guia_del_pedido',
  language: 'es',
  status: 'APPROVED',
  components: [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Hola {{1}}, tu pedido de {{2}} ya salio con guia {{3}}.' },
    { type: 'FOOTER', text: 'Chispudos Market' },
  ],
};

let sendTemplateOriginal;
beforeEach(() => {
  metaTemplates._setCacheForTests([PLANTILLA_APROBADA]);
  sendTemplateOriginal = whatsapp.sendTemplate;
});
afterEach(() => {
  whatsapp.sendTemplate = sendTemplateOriginal;
  metaTemplates._setCacheForTests([]);
});

test('H06/H17 - previewTemplateContent arma el snapshot desde la plantilla aprobada, sin mandar nada', async () => {
  let sePreguntoAWhatsapp = false;
  whatsapp.sendTemplate = async () => { sePreguntoAWhatsapp = true; };

  const snapshot = await previewTemplateContent({
    templateName: 'guia_del_pedido',
    languageCode: 'es',
    values: ['Juan', 'Shilajit', 'ABC123'],
    headerImageUrl: 'https://cdn.example.com/foto.jpg',
  });

  assert.equal(snapshot.bodyText, 'Hola Juan, tu pedido de Shilajit ya salio con guia ABC123.');
  assert.equal(snapshot.footerText, 'Chispudos Market');
  assert.equal(snapshot.headerImageUrl, 'https://cdn.example.com/foto.jpg');
  assert.equal(sePreguntoAWhatsapp, false, 'previewTemplateContent no debe mandar ningun mensaje');
});

test('H06/H35 - sendTemplateWithSnapshot manda con whatsapp.sendTemplate y devuelve el mismo snapshot que el preview, mas el wamid', async () => {
  whatsapp.sendTemplate = async () => ({ wamid: 'wamid.FAKE-123' });

  const preview = await previewTemplateContent({
    templateName: 'guia_del_pedido',
    languageCode: 'es',
    values: ['Juan', 'Shilajit', 'ABC123'],
  });
  const { wamid, snapshot } = await sendTemplateWithSnapshot({
    to: '59171234567',
    templateName: 'guia_del_pedido',
    languageCode: 'es',
    values: ['Juan', 'Shilajit', 'ABC123'],
  });

  assert.equal(wamid, 'wamid.FAKE-123');
  assert.deepEqual(snapshot, preview, 'BUG a evitar: preview y envio real no deben poder dar contenidos distintos con los mismos datos');
});

test('H06/H17 - si la plantilla no esta aprobada (o no se encuentra), el snapshot es null, no se inventa', async () => {
  metaTemplates._setCacheForTests([]); // ninguna plantilla aprobada disponible
  const snapshot = await previewTemplateContent({ templateName: 'no_existe', languageCode: 'es', values: [] });
  assert.equal(snapshot, null);
});

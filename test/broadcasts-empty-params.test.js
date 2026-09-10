// FASE 3d: el envio masivo generico (broadcasts.js / boton "Mandar envío
// masivo" del panel) era el UNICO lugar que todavia no tenia el respaldo de
// "variable vacia -> se manda como '-'" que ya tenian shipping.js,
// seguimiento.js, personalizedBroadcast.js y
// POST /api/conversations/:phone/send-template. Si el operador dejaba el
// campo de variables vacio (o alguna en blanco entre comas) al mandar un
// envio masivo, Meta mandaba la plantilla entera SIN reemplazar NINGUNA
// variable a TODOS los destinatarios del filtro elegido: el cliente veia
// literalmente "Hola {{1}}, tu paquete de {{2}}...". Esto paso de verdad con
// varios clientes reales.
'use strict';
const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('broadcasts-empty-params');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const metaTemplates = require('../src/metaTemplates');
const whatsapp = require('../src/whatsapp');
const broadcasts = require('../src/broadcasts');
const { getSession } = require('../src/state');

after(() => cleanup(dataDir));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('FASE 3d - startRun con params vacios (array []) NUNCA manda variables en blanco a Meta', async () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '59173333334': { history: [], stage: 'esperando_guia' },
  }));

  metaTemplates._setCacheForTests([{
    name: 'guia_del_pedido',
    language: 'es',
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Hola {{1}}, tu paquete de {{2}} salio con guia {{3}} a {{4}}, paga {{5}}.' },
    ],
  }]);

  let paramsRecibidosPorWhatsapp = null;
  const sendTemplateOriginal = whatsapp.sendTemplate;
  whatsapp.sendTemplate = async (_to, _name, _lang, params) => {
    paramsRecibidosPorWhatsapp = params;
    return { wamid: 'wamid.BROADCAST-EMPTY-1' };
  };

  try {
    const run = await broadcasts.startRun({
      templateName: 'guia_del_pedido',
      languageCode: 'es',
      params: [], // <- exactamente lo que manda el frontend si se deja el campo vacio
      target: { scope: 'all' },
    });

    for (let i = 0; i < 20 && broadcasts.listRuns().find((r) => r.id === run.id)?.status !== 'done'; i++) {
      await sleep(20);
    }

    // BUG si algun elemento queda vacio/undefined: eso es lo que hace que
    // Meta mande TODOS los placeholders sin reemplazar.
    assert.ok(paramsRecibidosPorWhatsapp.every((p) => p && p.trim() !== ''), 'BUG: se le mando a Meta un parametro vacio, dispara el bug de placeholders crudos');

    const session = getSession('59173333334');
    const msg = session.history[session.history.length - 1];
    assert.ok(
      !msg.template.snapshot.bodyText.includes('{{'),
      'BUG si el snapshot todavia tiene placeholders crudos tipo {{1}}: ' + msg.template.snapshot.bodyText
    );
  } finally {
    whatsapp.sendTemplate = sendTemplateOriginal;
    metaTemplates._setCacheForTests([]);
  }
});

test('FASE 3d - startRun con algunas variables vacias entre comas no corre las demas de lugar', async () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '59173333335': { history: [], stage: 'nuevo' },
  }));

  metaTemplates._setCacheForTests([{
    name: 'promo_verano',
    language: 'es',
    components: [{ type: 'BODY', text: 'Hola {{1}}, tu descuento es {{2}}.' }],
  }]);

  const sendTemplateOriginal = whatsapp.sendTemplate;
  whatsapp.sendTemplate = async () => ({ wamid: 'wamid.BROADCAST-EMPTY-2' });

  try {
    // El operador dejo la segunda variable vacia a proposito (no sabe el %).
    const run = await broadcasts.startRun({
      templateName: 'promo_verano',
      languageCode: 'es',
      params: ['Juan', ''],
      target: { scope: 'all' },
    });

    for (let i = 0; i < 20 && broadcasts.listRuns().find((r) => r.id === run.id)?.status !== 'done'; i++) {
      await sleep(20);
    }

    const session = getSession('59173333335');
    const msg = session.history[session.history.length - 1];
    assert.equal(msg.template.snapshot.bodyText, 'Hola Juan, tu descuento es -.', 'el campo vacio se manda como "-", nunca en blanco ni corriendo el resto');
  } finally {
    whatsapp.sendTemplate = sendTemplateOriginal;
    metaTemplates._setCacheForTests([]);
  }
});

test('FASE 3d - startRun pasa headerImageUrl hasta whatsapp.sendTemplate (antes se perdia siempre)', async () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '59173333336': { history: [], stage: 'esperando_guia' },
  }));

  metaTemplates._setCacheForTests([{
    name: 'guia_del_pedido',
    language: 'es',
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Hola {{1}}.' },
    ],
  }]);

  let headerRecibido = null;
  const sendTemplateOriginal = whatsapp.sendTemplate;
  whatsapp.sendTemplate = async (_to, _name, _lang, _params, headerImageUrl) => {
    headerRecibido = headerImageUrl;
    return { wamid: 'wamid.BROADCAST-IMG-1' };
  };

  try {
    const run = await broadcasts.startRun({
      templateName: 'guia_del_pedido',
      languageCode: 'es',
      params: ['Juan'],
      target: { scope: 'all' },
      headerImageUrl: 'https://ejemplo.com/guia.jpg',
    });

    for (let i = 0; i < 20 && broadcasts.listRuns().find((r) => r.id === run.id)?.status !== 'done'; i++) {
      await sleep(20);
    }

    assert.equal(headerRecibido, 'https://ejemplo.com/guia.jpg', 'BUG si esto es null: el envio masivo sigue sin poder mandar la imagen de encabezado');
  } finally {
    whatsapp.sendTemplate = sendTemplateOriginal;
    metaTemplates._setCacheForTests([]);
  }
});

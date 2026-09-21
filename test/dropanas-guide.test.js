'use strict';

const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-guide');
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const guide = require('../src/dropanasGuide');
const auto = require('../src/dropanasAuto');

after(() => cleanup(dataDir));

function onePagePdf(text) {
  const stream = `BT /F1 18 Tf 30 100 Td (${text}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { output += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

const sandboxConfig = {
  enabled: true,
  readOnlyAck: true,
  token: 'test_sk_fake_for_tests',
  tokenMode: 'sandbox',
  baseUrl: 'https://app.dropanas.com/api/v1',
  guideEnabled: true,
  guideTimeoutMs: 1000,
};

test('rechaza un PDF que no contiene la guia esperada', async () => {
  await assert.rejects(
    guide.renderVerifiedPdf(onePagePdf('GUIA 11111111'), '99999999'),
    /no contiene el número de guía esperado/
  );
});

test('extrae nombre y teléfono de una etiqueta oficial', () => {
  assert.deepEqual(
    guide.extractLabelMetadata('NOMBRE  JUAN BRANGER\nTELEFONO\n+58 4244587770\nENTREGA  CIUDAD VALENCIA'),
    { phone: '584244587770', client: 'JUAN BRANGER' }
  );
});

test('descarga, verifica y convierte la etiqueta PDF en PNG', async () => {
  const fakeClient = {
    get: async (url, options) => ({
      data: onePagePdf('GUIA 84804888'),
      headers: {
        'content-type': 'application/pdf',
        'x-dropanas-mode': 'sandbox',
        'x-guia-transportadora': 'dropanas',
        'x-guia-origen': 'dropanas',
      },
      config: { url },
      requestOptions: options,
    }),
  };
  const result = await guide.capture({
    orderId: '34622', expectedTracking: '84804888', config: sandboxConfig, client: fakeClient,
  });
  const fullPath = path.join(guide.OUTPUT_DIR, path.basename(result.filename));
  const image = fs.readFileSync(fullPath);
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  assert.ok(image.length > 1000);
  assert.equal(result.mode, 'sandbox');
  assert.equal(result.origin, 'dropanas');
});

test('en live espera la etiqueta oficial y no envía la guía de respaldo', async () => {
  const client = { get: async () => ({
    data: onePagePdf('GUIA 84804888'),
    headers: {
      'content-type': 'application/pdf',
      'x-dropanas-mode': 'live',
      'x-guia-transportadora': 'dropanas',
      'x-guia-origen': 'dropanas',
    },
  }) };
  await assert.rejects(
    guide.capture({
      orderId: '34622',
      expectedTracking: '84804888',
      expectedCarrier: 'tealca',
      config: { ...sandboxConfig, token: 'live_sk_fake', tokenMode: 'live' },
      client,
    }),
    /oficial de la transportadora todavía no está disponible/
  );
});

test('el envio totalmente automatico queda apagado por defecto', async () => {
  delete process.env.DROPANAS_AUTO_SEND_ENABLED;
  assert.deepEqual(await auto.processChanges([]), { enabled: false, results: [], acknowledged: [] });
});

test('el automatico rechaza coincidencias por nombre aunque parezcan exactas', async () => {
  let captured = false;
  const result = await auto.processChanges(
    [{ key: 'k1', order: { dropanasId: '10', guia: 'ABC10', carrier: 'tealca' } }],
    {
      env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
      matchRows: (rows) => rows.map((row) => ({ ...row, matchType: 'exacto', phone: '584120000000' })),
      capture: async () => { captured = true; },
    }
  );
  assert.equal(result.results[0].reason, 'requiere_revision');
  assert.equal(captured, false);
});

test('el automatico descarga y envia solo con telefono unico exacto', async () => {
  let stored = null;
  const result = await auto.processChanges(
    [{ key: 'k2', order: { dropanasId: '11', guia: 'ABC11', carrier: 'tealca', tipoEntrega: 'oficina' } }],
    {
      env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
      matchRows: (rows) => rows.map((row) => ({
        ...row, matchType: 'exacto', matchEvidence: 'telefono', phone: '584120000001',
        shippingStage: 'esperando_guia', sendEligible: true,
      })),
      getSession: () => ({ stage: 'vendido', stageLocked: false, card: {} }),
      detectOrderConflict: () => null,
      capture: async () => ({ filename: 'guias/etiqueta.png' }),
      mediaUrl: (filename) => `https://bot.example/media/${filename}`,
      updateSession: (_phone, patch) => { stored = patch; return { ...patch, phone: '584120000001' }; },
      maybeNotifyShipping: async () => ({ sent: true }),
    }
  );
  assert.equal(result.results[0].sent, true);
  assert.deepEqual(result.acknowledged, ['k2']);
  assert.equal(stored.card.guiaImageUrl, 'https://bot.example/media/guias/etiqueta.png');
  assert.equal(stored.stage, 'en_camino');
});

test('el automático no envía si el cliente ya no está esperando guía', async () => {
  let captured = false;
  const result = await auto.processChanges(
    [{ key: 'k3', order: { dropanasId: '12', guia: 'ABC12', carrier: 'tealca' } }],
    {
      env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
      matchRows: (rows) => rows.map((row) => ({
        ...row, matchType: 'exacto', matchEvidence: 'telefono', phone: '584120000002',
        shippingStage: 'en_camino', sendEligible: false,
      })),
      capture: async () => { captured = true; },
    }
  );
  assert.equal(result.results[0].reason, 'estado_no_esperando_guia');
  assert.equal(captured, false);
});

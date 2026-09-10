// FASE 2/5 (H06/H35): un broadcast masivo ahora guarda en el historial de
// cada cliente el contenido real de la plantilla (snapshot), el origen
// ('broadcast') y el wamid -- antes solo quedaba el string
// "[plantilla masiva] nombre" sin nada estructurado (ver H29/H31 previos,
// que ya habian arreglado que quedara ALGO guardado, pero no esto).
'use strict';
const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('broadcasts-template-snapshot');

const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');

const metaTemplates = require('../src/metaTemplates');
const whatsapp = require('../src/whatsapp');
const broadcasts = require('../src/broadcasts');
const { getSession } = require('../src/state');

after(() => cleanup(dataDir));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('H06/H35 - startRun guarda snapshot + origin "broadcast" + wamid en el historial de cada destinatario', async () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '59173333333': { history: [], stage: 'nuevo' },
  }));

  metaTemplates._setCacheForTests([{
    name: 'promo_verano',
    language: 'es',
    components: [{ type: 'BODY', text: 'Hola {{1}}, aprovecha {{2}}% de descuento.' }],
  }]);
  const sendTemplateOriginal = whatsapp.sendTemplate;
  whatsapp.sendTemplate = async () => ({ wamid: 'wamid.BROADCAST-1' });

  try {
    const run = await broadcasts.startRun({
      templateName: 'promo_verano',
      languageCode: 'es',
      params: ['Juan', '20'],
      target: { scope: 'all' },
    });

    // startRun corre el envio en el fondo (no bloquea la respuesta HTTP real);
    // en el test se espera un toque a que termine de procesar el unico
    // destinatario antes de revisar el resultado.
    for (let i = 0; i < 20 && broadcasts.listRuns().find((r) => r.id === run.id)?.status !== 'done'; i++) {
      await sleep(20);
    }

    const session = getSession('59173333333');
    const msg = session.history[session.history.length - 1];
    assert.equal(msg.template.origin, 'broadcast');
    assert.equal(msg.template.wamid, 'wamid.BROADCAST-1');
    assert.equal(msg.template.snapshot.bodyText, 'Hola Juan, aprovecha 20% de descuento.');

    const runGuardado = broadcasts.listRuns().find((r) => r.id === run.id);
    assert.equal(runGuardado.results[0].wamid, 'wamid.BROADCAST-1');
  } finally {
    whatsapp.sendTemplate = sendTemplateOriginal;
    metaTemplates._setCacheForTests([]);
  }
});

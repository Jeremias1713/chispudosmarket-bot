// FASE 3d: sendPersonalized (envio masivo personalizado por Excel) mandaba
// row[campo] || '' cuando una celda venia vacia -- mismo bug que
// broadcasts.js: a Meta le alcanza con UN solo parametro vacio para mandar
// la plantilla entera sin reemplazar ninguna variable. Ahora una celda
// vacia se manda como "-".
'use strict';
const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('personalizedBroadcast-empty-fields');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const metaTemplates = require('../src/metaTemplates');
const whatsapp = require('../src/whatsapp');
const personalizedBroadcast = require('../src/personalizedBroadcast');
const { getSession } = require('../src/state');

after(() => cleanup(dataDir));

test('FASE 3d - sendPersonalized con una celda vacia manda "-" en vez de "" (no dispara el bug de placeholders crudos)', async () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '59171112222': { history: [], stage: 'nuevo' },
  }));

  metaTemplates._setCacheForTests([{
    name: 'aviso_deuda',
    language: 'es',
    components: [{ type: 'BODY', text: 'Hola {{1}} {{2}}, debes {{3}}.' }],
  }]);

  let paramsRecibidos = null;
  const original = whatsapp.sendTemplate;
  whatsapp.sendTemplate = async (_to, _name, _lang, params) => {
    paramsRecibidos = params;
    return { wamid: 'wamid.PB-1' };
  };

  try {
    const rows = [
      { fila: 2, telefono: '59171112222', nombre: 'Juan', apellido: '', monto: '100', valido: true },
    ];
    const results = await personalizedBroadcast.sendPersonalized({
      templateName: 'aviso_deuda',
      languageCode: 'es',
      order: ['nombre', 'apellido', 'monto'],
      rows,
    });

    assert.equal(results[0].ok, true);
    assert.ok(paramsRecibidos.every((p) => p && p.trim() !== ''), 'BUG: se le mando a Meta un parametro vacio');
    assert.deepEqual(paramsRecibidos, ['Juan', '-', '100']);

    const session = getSession('59171112222');
    const msg = session.history[session.history.length - 1];
    assert.equal(msg.template.snapshot.bodyText, 'Hola Juan -, debes 100.');
  } finally {
    whatsapp.sendTemplate = original;
    metaTemplates._setCacheForTests([]);
  }
});

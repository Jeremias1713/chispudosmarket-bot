// FASE 2/5 (H06 + H35): confirma que appendMessage (state.js) ya soporta
// guardar un snapshot estructurado de plantilla en `extra` sin romper nada
// -- esta es la base sobre la que H06/H17/H35 van a apoyarse para dejar de
// guardar solo el string "[plantilla] nombre" (ver panel.js, broadcasts.js,
// seguimiento.js, shipping.js, personalizedBroadcast.js) y guardar en su
// lugar el contenido ya armado, el origen del envio, y (mas adelante) el
// wamid + status real.
//
// A diferencia de templateContent.test.js y messageStatus.test.js, este
// test SI deberia pasar hoy: no depende de codigo nuevo, solo documenta el
// contrato de datos que los cambios de H06/H17/H35 van a usar.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('state-template-snapshot');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { appendMessage, getSession } = require('../src/state');

after(() => cleanup(dataDir));

test('H06/H35 - appendMessage puede guardar un snapshot de plantilla estructurado (origen, contenido, wamid, status) sin perder el content de fallback', () => {
  const phone = '59170000001';
  appendMessage(phone, 'human', '[plantilla] guia_envio', {
    template: {
      name: 'guia_envio',
      origin: 'bot',
      snapshot: { bodyText: 'Hola Juan, tu guia es ABC123.', footerText: null, buttons: null },
      params: ['Juan', 'ABC123'],
      wamid: null,
      status: 'sent',
    },
  });
  const session = getSession(phone);
  const msg = session.history[session.history.length - 1];
  assert.equal(msg.content, '[plantilla] guia_envio');
  assert.equal(msg.template.origin, 'bot');
  assert.equal(msg.template.snapshot.bodyText, 'Hola Juan, tu guia es ABC123.');
  assert.equal(msg.template.status, 'sent');
});

test('H06/H35 - un mensaje historico sin template estructurado se puede distinguir (no se le debe inventar snapshot)', () => {
  const phone = '59170000002';
  appendMessage(phone, 'human', '[plantilla] guia_envio'); // como quedan guardados hoy, sin extra
  const session = getSession(phone);
  const msg = session.history[session.history.length - 1];
  assert.equal(msg.template, undefined, 'sin datos estructurados: el panel debe avisar que no puede reconstruir el contenido exacto, no inventarlo');
});

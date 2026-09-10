// FASE 3c: GET /api/conversations/:phone descartaba el campo `template` de
// cada mensaje al armar la respuesta, aunque appendMessage (state.js) SI lo
// guarda bien en el history con el snapshot completo (nombre, origen,
// parametros, contenido real, wamid, estado). El resultado: el panel
// mostraba SIEMPRE "no se puede reconstruir el contenido de este envio"
// para una plantilla, aunque el dato estuviera guardado perfectamente.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('panel-conversation-template');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const panelRouter = require('../src/web/panel');

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

test('FASE 3c - GET /api/conversations/:phone incluye el snapshot de la plantilla enviada, no lo descarta', async () => {
  const templateInfo = {
    name: 'guia_del_pedido',
    origin: 'bot',
    params: ['Juan', 'Shilajit', 'ABC1'],
    snapshot: { bodyText: 'Hola Juan, tu pedido de Shilajit salio con guia ABC1.' },
    wamid: 'wamid.ABC123',
    status: 'sent',
  };

  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': {
      step: 'IDLE', cart: [], name: 'Juan', stage: 'en_camino', stageLocked: false,
      stageReason: null, paused: false, pausedReason: null,
      card: { nombre: 'Juan', guia: 'ABC1', producto: 'Shilajit', monto: 38900 },
      history: [
        { role: 'human', content: '[plantilla] guia_del_pedido', at: '2026-09-01T10:00:00.000Z', template: templateInfo },
      ],
      adCode: null, createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
    },
  }));

  const handler = findHandler('get', '/api/conversations/:phone');
  const req = { params: { phone: '584120000001' } };
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.messages.length, 1);
  assert.deepEqual(
    res.body.messages[0].template,
    templateInfo,
    'BUG si esto es null: el endpoint esta descartando el snapshot de la plantilla que si esta guardado en el history'
  );
});

test('FASE 3c - un mensaje comun (sin plantilla) sigue devolviendo template: null, no rompe nada', async () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000002': {
      step: 'IDLE', cart: [], name: 'Ana', stage: 'nuevo', stageLocked: false,
      stageReason: null, paused: false, pausedReason: null,
      card: { nombre: null, guia: null, producto: null, monto: null },
      history: [
        { role: 'human', content: 'Hola, quiero info', at: '2026-09-01T10:00:00.000Z' },
      ],
      adCode: null, createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
    },
  }));

  const handler = findHandler('get', '/api/conversations/:phone');
  const req = { params: { phone: '584120000002' } };
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.body.messages[0].template, null);
});

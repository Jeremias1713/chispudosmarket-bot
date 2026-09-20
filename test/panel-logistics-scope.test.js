'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('panel-logistics-scope');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const panelRouter = require('../src/web/panel');

after(() => cleanup(dataDir));

function findHandler(method, path) {
  const layer = panelRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no se encontro ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}

function fakeRes() {
  const res = { body: null };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('scope=sold devuelve solo etapas de pedidos cerrados para el seguimiento operativo', async () => {
  const session = (name, stage) => ({
    name, stage, history: [], card: { producto: 'Producto' },
    createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
  });
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': session('Nuevo', 'nuevo'),
    '584120000002': session('Vendido', 'vendido'),
    '584120000003': session('Sin guia', 'esperando_guia'),
    '584120000004': session('En camino', 'en_camino'),
    '584120000005': session('Retiro', 'esperando_retiro'),
    '584120000006': session('Entregado', 'entregado'),
    '584120000007': session('Perdido', 'perdido'),
  }));

  const req = { query: { scope: 'sold' } };
  const res = fakeRes();
  await findHandler('get', '/api/conversations')(req, res);

  assert.deepEqual(
    res.body.map((item) => item.stage).sort(),
    ['en_camino', 'entregado', 'esperando_guia', 'esperando_retiro', 'vendido'].sort()
  );
  assert.ok(res.body.every((item) => !['nuevo', 'perdido'].includes(item.stage)));
});

// FASE 3h: borrado manual y permanente de conversaciones viejas (panel >
// Configuracion > "Limpieza de conversaciones"). Nace de un pedido real:
// un negocio con miles de conversaciones "nuevo"/"perdido" que nunca
// avanzaron y solo ensucian el listado. Como es un borrado PERMANENTE (sin
// boton de "restaurar" en el panel), estas pruebas se enfocan sobre todo en
// los pisos de seguridad: nunca se puede borrar una etapa de venta cerrada
// (SOLD_STAGES) aunque se pida a proposito, y el borrado real exige mandar
// la palabra exacta BORRAR en el body (no alcanza con elegir la etapa).
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, readJson, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('cleanup-conversaciones');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const state = require('../src/state');
const panelRouter = require('../src/web/panel');

after(() => cleanup(dataDir));

function findHandler(method, path) {
  const layer = panelRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no se encontro ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}

function fakeRes() {
  const res = { body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function session(name, stage) {
  return {
    name, stage, history: [], card: { producto: 'Producto' },
    createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
  };
}

function seedSessions() {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': session('Nuevo 1', 'nuevo'),
    '584120000002': session('Nuevo 2', 'nuevo'),
    '584120000003': session('Perdido 1', 'perdido'),
    '584120000004': session('Vendido', 'vendido'),
    '584120000005': session('En camino', 'en_camino'),
  }));
}

test('state.deleteSessions borra solo los telefonos pedidos y deja el resto intacto', () => {
  seedSessions();
  const deleted = state.deleteSessions(['584120000001', '584120000003', '584120000999']);
  assert.equal(deleted, 2, 'el telefono inexistente (999) no debe contar');
  const restantes = state.listSessions().map((s) => s.phone).sort();
  assert.deepEqual(restantes, ['584120000002', '584120000004', '584120000005']);
});

test('GET cleanup-preview cuenta las conversaciones de las etapas pedidas, sin borrar nada', () => {
  seedSessions();
  const req = { query: { stages: 'nuevo,perdido' } };
  const res = fakeRes();
  findHandler('get', '/api/conversations/cleanup-preview')(req, res);

  assert.equal(res.body.count, 3);
  assert.deepEqual(res.body.stages.sort(), ['nuevo', 'perdido']);
  assert.equal(state.listSessions().length, 5, 'el preview no debe borrar nada');
});

test('BUG evitado - pedir borrar una etapa de venta cerrada (vendido) no la incluye ni con "confirm" correcto', () => {
  seedSessions();
  const req = { query: { stages: 'nuevo,vendido,en_camino' } };
  const res = fakeRes();
  findHandler('get', '/api/conversations/cleanup-preview')(req, res);

  assert.deepEqual(res.body.stages, ['nuevo'], 'vendido/en_camino son SOLD_STAGES: nunca deben quedar habilitadas para borrar');
  assert.equal(res.body.count, 2);
});

test('DELETE cleanup exige la palabra BORRAR exacta antes de borrar algo', async () => {
  seedSessions();
  const req = { query: {}, body: { stages: ['nuevo', 'perdido'], confirm: 'si quiero' } };
  const res = fakeRes();
  await findHandler('delete', '/api/conversations/cleanup')(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(state.listSessions().length, 5, 'sin la confirmacion exacta no debe borrar nada');
});

test('DELETE cleanup con BORRAR borra las conversaciones de las etapas pedidas y respeta el piso de SOLD_STAGES', async () => {
  seedSessions();
  const req = { query: {}, body: { stages: ['nuevo', 'perdido', 'vendido'], confirm: 'BORRAR' } };
  const res = fakeRes();
  await findHandler('delete', '/api/conversations/cleanup')(req, res);

  assert.equal(res.body.ok, true);
  assert.equal(res.body.deleted, 3);
  assert.deepEqual(res.body.stages.sort(), ['nuevo', 'perdido']);

  const restantes = state.listSessions().map((s) => s.stage).sort();
  assert.deepEqual(restantes, ['en_camino', 'vendido'], 'vendido debe seguir existiendo: nunca se borra una venta cerrada');

  const backups = readJson(dataDir, 'sessions.json');
  assert.equal(Object.keys(backups).length, 2, 'el archivo real debe reflejar el borrado');
});

test('DELETE cleanup sin ninguna etapa valida no borra nada y avisa el error', async () => {
  seedSessions();
  const req = { query: {}, body: { stages: ['vendido', 'en_camino'], confirm: 'BORRAR' } };
  const res = fakeRes();
  await findHandler('delete', '/api/conversations/cleanup')(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(state.listSessions().length, 5);
});

// Panel liviano para el celular: listado paginado + refresco incremental,
// pipeline agrupado en el servidor y "sin cambios" para la charla abierta.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeJson, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('panel-feed');
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const panelRouter = require('../src/web/panel');
const state = require('../src/state');

after(() => cleanup(dataDir));

function findHandler(path) {
  const layer = panelRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
  if (!layer) throw new Error(`no se encontro GET ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function call(path, query = {}, params = {}) {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  findHandler(path)({ query, params }, res);
  return res.body;
}

const HOUR = 60 * 60 * 1000;
function iso(msAgo) { return new Date(Date.now() - msAgo - 30 * 60 * 1000).toISOString(); }

function seed(count) {
  const sessions = {};
  for (let i = 0; i < count; i++) {
    const phone = `58414000${String(i).padStart(4, '0')}`;
    const at = iso(i * HOUR);
    sessions[phone] = {
      name: `Cliente ${i}`,
      stage: i % 2 ? 'interesado' : 'nuevo',
      card: {},
      history: [{ role: 'user', content: 'x'.repeat(500) + ` ${i}`, at }],
      createdAt: at,
      updatedAt: at,
    };
  }
  writeJson(dataDir, 'sessions.json', sessions);
}

beforeEach(() => seed(100));

test('feed: primera pagina ordenada, recortada y con total', () => {
  const body = call('/api/conversations/feed', { limit: '10' });
  assert.equal(body.items.length, 10);
  assert.equal(body.total, 100);
  assert.equal(body.hasMore, true);
  assert.equal(body.items[0].name, 'Cliente 0');
  assert.ok(body.items[0].lastMessage.length <= 140, 'el ultimo mensaje viaja recortado');
  assert.equal(body.items[0].history, undefined, 'el historial no viaja en el listado');
  assert.ok(body.cursor);
});

test('feed: offset trae la pagina siguiente sin repetir', () => {
  const first = call('/api/conversations/feed', { limit: '10' });
  const second = call('/api/conversations/feed', { limit: '10', offset: '10' });
  const phones = new Set(first.items.map((c) => c.phone));
  assert.ok(second.items.every((c) => !phones.has(c.phone)));
  assert.equal(second.items[0].name, 'Cliente 10');
});

test('feed: since devuelve solo lo que cambio despues del cursor', () => {
  const first = call('/api/conversations/feed', { limit: '10' });
  const later = new Date(Date.parse(first.cursor) + 10000).toISOString();
  assert.equal(call('/api/conversations/feed', { since: later }).items.length, 0);
  state.appendMessage('584140000050', 'user', 'hola de nuevo');
  const delta = call('/api/conversations/feed', { since: first.cursor });
  assert.equal(delta.delta, true);
  // El cursor tiene 5s de margen hacia atras a proposito (un duplicado no
  // molesta; perderse un cambio si): puede repetir lo recien sembrado, pero
  // nunca trae conversaciones viejas que no cambiaron.
  const changed = delta.items.find((c) => c.phone === '584140000050');
  assert.equal(changed.lastMessage, 'hola de nuevo');
  assert.ok(delta.items.length <= 2);
  assert.ok(delta.items.every((c) => ['584140000050', '584140000000'].includes(c.phone)));
});

test('feed: busqueda filtra en el servidor', () => {
  const body = call('/api/conversations/feed', { search: 'Cliente 42' });
  assert.equal(body.total, 1);
  assert.equal(body.items[0].phone, '584140000042');
});

test('pipeline: agrupa por etapa con total y pagina por columna', () => {
  const body = call('/api/pipeline', { perStage: '5' });
  const nuevo = body.stages.find((s) => s.id === 'nuevo');
  const interesado = body.stages.find((s) => s.id === 'interesado');
  assert.equal(nuevo.count, 50);
  assert.equal(interesado.count, 50);
  assert.equal(nuevo.items.length, 5);
  const more = call('/api/pipeline', { stage: 'nuevo', offset: '5', perStage: '5' });
  assert.equal(more.total, 50);
  assert.equal(more.items[0].phone, nuevo.items.length ? '584140000010' : null);
});

test('pipeline: ventana de 24h usa la misma regla que tenia el panel', () => {
  const body = call('/api/pipeline', { window: '24h', perStage: '200' });
  const total = body.stages.reduce((n, s) => n + s.count, 0);
  assert.equal(total, 24); // i = 0..23 horas (la de 24h justas ya quedo afuera)
});

test('detalle: devuelve version y contesta "unchanged" si no cambio nada', () => {
  const first = call('/api/conversations/:phone', {}, { phone: '584140000003' });
  assert.ok(first.version);
  assert.equal(first.messages.length, 1);
  const again = call('/api/conversations/:phone', { v: first.version }, { phone: '584140000003' });
  assert.deepEqual(again, { unchanged: true, version: first.version });
  state.appendMessage('584140000003', 'assistant', 'respuesta');
  const changed = call('/api/conversations/:phone', { v: first.version }, { phone: '584140000003' });
  assert.equal(changed.unchanged, undefined);
  assert.equal(changed.messages.length, 2);
});

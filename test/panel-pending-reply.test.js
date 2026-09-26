// Numerito de "mensajes del cliente sin responder": nace de un pedido real
// del dueno del negocio (a veces contesta a mano y se le olvida). Se cuenta
// desde el final del historial mientras el rol sea 'user'; cualquier
// respuesta ('assistant' del bot o 'human' manual/plantilla) lo apaga.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeJson, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('panel-pending-reply');
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const panelRouter = require('../src/web/panel');

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

function msg(role, content) {
  return { role, content, at: new Date().toISOString() };
}

beforeEach(() => {
  writeJson(dataDir, 'sessions.json', {
    // Cliente escribio dos veces seguidas y nadie contesto todavia.
    '584140000001': {
      name: 'Sin contestar x2',
      stage: 'esperando_retiro',
      paused: true,
      card: {},
      history: [msg('assistant', 'hola'), msg('user', 'llego mi pedido?'), msg('user', 'hola?')],
    },
    // Ya se le contesto a mano: el ultimo mensaje es 'human'.
    '584140000002': {
      name: 'Ya contestada a mano',
      stage: 'esperando_retiro',
      paused: true,
      card: {},
      history: [msg('user', 'llego mi pedido?'), msg('human', 'si, ya puedes pasar a buscarlo')],
    },
    // La contesto el bot: el ultimo mensaje es 'assistant'.
    '584140000003': {
      name: 'Contestada por el bot',
      stage: 'interesado',
      card: {},
      history: [msg('user', 'cuanto cuesta?'), msg('assistant', '900 bs')],
    },
    // Sin historial todavia.
    '584140000004': {
      name: 'Sin mensajes',
      stage: 'nuevo',
      card: {},
      history: [],
    },
  });
});

test('/api/conversations: pendingReplyCount cuenta los mensajes seguidos del cliente sin contestar', () => {
  const list = call('/api/conversations');
  const byPhone = Object.fromEntries(list.map((c) => [c.phone, c]));
  assert.equal(byPhone['584140000001'].pendingReplyCount, 2);
  assert.equal(byPhone['584140000002'].pendingReplyCount, 0);
  assert.equal(byPhone['584140000003'].pendingReplyCount, 0);
  assert.equal(byPhone['584140000004'].pendingReplyCount, 0);
});

test('/api/conversations/feed: viaja pendingReplyCount por fila y pendingTotal general', () => {
  const body = call('/api/conversations/feed', { limit: '10' });
  const byPhone = Object.fromEntries(body.items.map((c) => [c.phone, c]));
  assert.equal(byPhone['584140000001'].pendingReplyCount, 2);
  assert.equal(byPhone['584140000002'].pendingReplyCount, 0);
  // Solo una de las 4 conversaciones sembradas tiene algo pendiente.
  assert.equal(body.pendingTotal, 1);
});

test('/api/conversations/feed: pendingTotal no se filtra por la busqueda (es global)', () => {
  const body = call('/api/conversations/feed', { limit: '10', search: 'Ya contestada' });
  assert.equal(body.items.length, 1);
  assert.equal(body.pendingTotal, 1, 'sigue contando la conversacion pendiente aunque no coincida con la busqueda');
});

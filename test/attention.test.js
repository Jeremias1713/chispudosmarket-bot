// Necesita atencion: si el cliente se queja el bot se apaga en ese chat, le
// avisa a Jere y aparece en la lista del panel. Servicios externos simulados.
'use strict';
process.env.SPLIT_GAP_MIN_MS = '20';
process.env.SPLIT_GAP_MAX_MS = '30';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('attention');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const whatsapp = require('../src/whatsapp');
const ai = require('../src/ai');
const classifierMod = require('../src/classifier');
const { updateSettings } = require('../src/settings');
const { getSession } = require('../src/state');

updateSettings({ replyDelayMs: 5 });

const enviados = [];
whatsapp.sendText = async (to, text) => { enviados.push({ to, text }); return { messages: [{ id: 'wamid.TEST' }] }; };
whatsapp.sendImageByLink = async () => ({});
whatsapp.sendAudioByLink = async () => ({});

let classificationToReturn = null;
classifierMod.classifyConversation = async () => classificationToReturn;
let aiCalls = 0;
ai.getAssistantReply = async () => { aiCalls += 1; return { text: 'Respuesta de la IA', images: [] }; };

const push = require('../src/push');
const pushes = [];
push.notifyAdmin = async (title, body) => { pushes.push({ title, body }); };
push.notifySale = () => {};

const flow = require('../src/flow');
const attention = require('../src/attention');
const { canSendAutomatic } = require('../src/outboundGuard');

after(() => cleanup(dataDir));

const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

function sesion(overrides) {
  return {
    step: 'IDLE', cart: [], history: [{ role: 'user', content: 'hola', at: new Date().toISOString() }],
    name: 'Carlos', stage: 'en_camino', orderClosed: true, stageLocked: false, paused: false,
    card: { nombre: 'Carlos Ruiz', producto: 'Shilajit', guia: 'GU-1' },
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

test('detecta reclamos despues de la venta y no confunde dudas de un interesado', () => {
  const vendido = { stage: 'esperando_retiro', orderClosed: true };
  const lead = { stage: 'interesado' };
  assert.equal(attention.detectComplaint('Me llegó roto el frasco', vendido).reason, 'llego_mal');
  assert.equal(attention.detectComplaint('me cobraron doble en la agencia', vendido).reason, 'cobro_doble');
  assert.equal(attention.detectComplaint('pagué dos veces', vendido).reason, 'cobro_doble');
  assert.equal(attention.detectComplaint('ya llevo un mes y no me funciona', vendido).reason, 'no_funciona');
  assert.equal(attention.detectComplaint('me mandaron otro producto', vendido).reason, 'llego_mal');
  assert.equal(attention.detectComplaint('quiero que me devuelvan el dinero', vendido).reason, 'reembolso');
  assert.equal(attention.detectComplaint('quiero hablar con una persona', lead).reason, 'pide_humano');
  assert.equal(attention.detectComplaint('y si no me funciona?', vendido), null);
  assert.equal(attention.detectComplaint('no funciona para la prostata?', lead), null);
  assert.equal(attention.detectComplaint('esto es una estafa?', lead), null);
  assert.equal(attention.detectComplaint('gracias, ya lo retiré', vendido), null);
  assert.equal(attention.detectComplaint('quiero 2 frascos', vendido), null);
});

test('un chat sin pedido pasa a necesita_atencion; uno con pedido conserva su etapa', () => {
  const sin = attention.openPatch({ stage: 'negociando' }, { reason: 'pide_humano', text: 'x' });
  assert.equal(sin.stage, 'necesita_atencion');
  assert.equal(sin.paused, true);
  const con = attention.openPatch({ stage: 'en_camino', orderClosed: true }, { reason: 'llego_mal', text: 'x' });
  assert.equal(con.stage, undefined);
  assert.equal(con.paused, true);
  assert.equal(con.attention.previousStage, 'en_camino');
});

test('reclamo de un cliente con pedido: pausa el bot, avisa a Jere, contesta una vez y la IA no contesta', async () => {
  const phone = '584120000801';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesion() }));
  enviados.length = 0; pushes.length = 0; aiCalls = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'Hola, me llegó el frasco roto y abierto' } }, 'Carlos');
  await wait();
  const s = getSession(phone);
  assert.equal(s.paused, true);
  assert.equal(s.attention.open, true);
  assert.equal(s.attention.reason, 'llego_mal');
  assert.equal(s.stage, 'en_camino', 'la etapa logistica no se toca');
  assert.equal(aiCalls, 0);
  assert.equal(enviados.filter((m) => m.to === phone).length, 1);
  assert.match(enviados[0].text, /persona del equipo/);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].body, /Carlos Ruiz.*llegó mal/);

  // El cliente sigue escribiendo: el bot ya no contesta nada.
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'hola??' } }, 'Carlos');
  await wait();
  assert.equal(enviados.filter((m) => m.to === phone).length, 1);
  assert.equal(aiCalls, 0);

  // Aparece en la lista del panel.
  const rows = attention.list([getSession(phone)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastFromClient, true);
});

test('la IA tambien abre la atencion aunque el chat ya tenga una venta', async () => {
  const phone = '584120000802';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesion({ stage: 'esperando_retiro' }) }));
  pushes.length = 0;
  classificationToReturn = { stage: 'necesita_atencion', razon: 'El cliente esta molesto porque nadie le responde', card: {} };
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'llevo 3 dias esperando y nadie me dice nada' } }, 'Carlos');
  await wait(400);
  classificationToReturn = null;
  const s = getSession(phone);
  assert.equal(s.attention.open, true);
  assert.equal(s.attention.source, 'ia');
  assert.equal(s.paused, true);
  assert.equal(s.stage, 'esperando_retiro');
  assert.equal(pushes.length, 1);
});

test('Resuelto reactiva el bot y devuelve la etapa anterior; la IA no lo reabre enseguida', async () => {
  const phone = '584120000803';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesion({ stage: 'negociando', orderClosed: false }) }));
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'quiero hablar con una persona por favor' } }, 'Carlos');
  await wait();
  let s = getSession(phone);
  assert.equal(s.stage, 'necesita_atencion');
  const { updateSession } = require('../src/state');
  updateSession(phone, attention.resolvePatch(s));
  s = getSession(phone);
  assert.equal(s.paused, false);
  assert.equal(s.attention.open, false);
  assert.equal(s.stage, 'negociando');

  classificationToReturn = { stage: 'necesita_atencion', razon: 'pidio una persona', card: {} };
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'ok gracias, cuanto cuesta?' } }, 'Carlos');
  await wait(400);
  classificationToReturn = null;
  s = getSession(phone);
  assert.equal(s.attention.open, false);
  assert.equal(s.paused, false);
  assert.equal(s.stage, 'negociando');
});

test('con un reclamo abierto no sale marketing ni recordatorios; los avisos de envio si', () => {
  const s = { attention: { open: true } };
  assert.equal(canSendAutomatic(s, 'remarketing').ok, false);
  assert.equal(canSendAutomatic(s, 'pickup_reminder').ok, false);
  assert.equal(canSendAutomatic(s, 'last_notice').ok, false);
  assert.equal(canSendAutomatic(s, 'arrival').ok, true);
});

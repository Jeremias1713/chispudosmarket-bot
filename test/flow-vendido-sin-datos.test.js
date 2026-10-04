// Prueba de integracion de flow.js (handleIncomingMessage -> processReply)
// con los servicios externos SIMULADOS (nunca llama a OpenAI real ni a la
// API de WhatsApp real): confirma que, de punta a punta, un mensaje informal
// del cliente no le hace perder al bot un avance logistico ya confirmado
// (Hallazgo 2/3), y que un cambio de estado ocurrido MIENTRAS se generaba la
// respuesta no termina mandando un mensaje que contradiga el estado vigente
// al momento de mandar (Hallazgo 3).
//
// IMPORTANTE sobre el orden de los require: whatsapp.js, ai.js y
// classifier.js exponen las funciones que usa flow.js DESESTRUCTURADAS (una
// sola vez, al cargarse flow.js). Por eso ese mock tiene que quedar puesto
// ANTES de la primera vez que se hace require('../src/flow') en este
// archivo -- si no, flow.js ya se quedo con la referencia a la funcion real.
'use strict';
process.env.SPLIT_GAP_MIN_MS = '20';
process.env.SPLIT_GAP_MAX_MS = '30';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('flow-vendido-sin-datos');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const whatsapp = require('../src/whatsapp');
const ai = require('../src/ai');
const classifierMod = require('../src/classifier');
const { updateSettings } = require('../src/settings');
const { getSession, updateSession } = require('../src/state');

// Respuesta corta (5ms) para no hacer el test lento; audioReplyEnabled queda
// en true por defecto, pero maybeSendAudio corta solo si no hay PUBLIC_URL
// (no seteado en el entorno de test), asi que nunca intenta llamar a TTS.
updateSettings({ replyDelayMs: 5 });

const textosEnviados = [];
whatsapp.sendText = async (to, text) => { textosEnviados.push({ to, text }); return { messages: [{ id: 'wamid.TEST' }] }; };
whatsapp.sendImageByLink = async () => ({});
whatsapp.sendAudioByLink = async () => ({});
whatsapp.downloadMedia = async () => { throw new Error('no deberia llamarse en estos tests'); };

// classifyConversation mockeado: cada test setea que devolver via esta
// variable, para poder simular la reclasificacion "equivocada" que dispara
// el bug reportado (un mensaje informal hace que el clasificador proponga
// retroceder la etapa).
let classificationToReturn = null;
classifierMod.classifyConversation = async () => classificationToReturn;

// getAssistantReply mockeado: cada test setea que responder. Puede ser una
// funcion (para simular un cambio de estado MIENTRAS se genera la
// respuesta, escribiendo directo en la sesion antes de devolver el texto).
let replyToReturn = { text: 'Todo bien!', images: [] };
ai.getAssistantReply = async (...args) => {
  const r = typeof replyToReturn === 'function' ? await replyToReturn(...args) : replyToReturn;
  return r;
};

const flow = require('../src/flow');
const push = require('../src/push');
push.notifySale = () => {}; // evita el aviso push real (usa WHATSAPP_WINDOW/entorno)

after(() => cleanup(dataDir));

function esperarProcesamiento(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 150));
}

function sesionBase(overrides) {
  return {
    step: 'IDLE', cart: [], history: [{ role: 'user', content: 'hola', at: '2026-08-01T00:00:00.000Z' }],
    name: 'Carlos', stage: 'esperando_retiro', stageLocked: false, stageReason: null,
    paused: false, pausedReason: null,
    card: { nombre: 'Carlos', producto: 'Shilajit', guia: 'GU-700' },
    shippingNotifiedAt: '2026-08-01T00:00:00.000Z',
    arrivalNotifiedAt: '2026-08-01T01:00:00.000Z',
    adCode: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}


function sesionLead(overrides) {
  return sesionBase({ stage: 'interesado', card: { producto: 'Turkesterone', ciudad: 'San Felix' }, shippingNotifiedAt: null, arrivalNotifiedAt: null, ...overrides });
}
const PAGO = 'El pago se realiza contra entrega en la agencia Tealca. En cuanto tengamos la guia te la pasamos.';

test('un mensaje que explica el pago/guia sin tener los datos NO marca la venta y se piden los datos', async () => {
  const phone = '584120000501';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionLead({ history: [
    { role: 'assistant', content: 'Te queda bien esta agencia?', at: '2026-08-01T00:00:00.000Z' },
  ] }) }));
  classificationToReturn = null;
  replyToReturn = { text: PAGO, images: [] };
  textosEnviados.length = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'ok, como hay que pagar?' } }, 'Ana');
  await esperarProcesamiento(600);
  const s = getSession(phone);
  assert.notEqual(s.stage, 'vendido', 'BUG: sin nombre/cedula/telefono no puede quedar vendido');
  assert.notEqual(s.orderClosed, true);
  const enviados = textosEnviados.filter((m) => m.to === phone).map((m) => m.text).join('\n');
  assert.match(enviados, /C[eé]dula/i, 'tiene que haber pedido los datos');
  assert.equal(s.orderDataRequested, true);
});

test('el clasificador no puede marcar vendido si faltan datos', async () => {
  const phone = '584120000502';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionLead() }));
  replyToReturn = { text: 'Claro, te cuento mas.', images: [] };
  classificationToReturn = { stage: 'vendido', razon: 'El cliente ha confirmado que quiere el producto', card: {} };
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'si lo quiero' } }, 'Ana');
  await esperarProcesamiento();
  assert.notEqual(getSession(phone).stage, 'vendido');
});

test('el clasificador SI marca vendido cuando ya estan los tres datos', async () => {
  const phone = '584120000503';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionLead({ card: { producto: 'Turkesterone', nombre: 'Ana Perez', cedula: '12345678', telefono: '04141234567' } }) }));
  replyToReturn = { text: 'Listo!', images: [] };
  classificationToReturn = { stage: 'vendido', razon: 'confirmo', card: {} };
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'gracias' } }, 'Ana');
  await esperarProcesamiento();
  assert.equal(getSession(phone).stage, 'vendido');
});

test('si el cliente acepta la agencia y el modelo no pide los datos, el bot los pide', async () => {
  const phone = '584120000504';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionLead({ history: [
    { role: 'assistant', content: 'Aqui tienes la agencia mas cercana. Te queda bien esta agencia para retirar tu pedido?', at: '2026-08-01T00:00:00.000Z' },
  ] }) }));
  classificationToReturn = null;
  replyToReturn = { text: 'Perfecto, quedamos asi.', images: [] };
  textosEnviados.length = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'si me queda bien' } }, 'Ana');
  await esperarProcesamiento(600);
  const enviados = textosEnviados.filter((m) => m.to === phone).map((m) => m.text).join('\n');
  assert.match(enviados, /C[eé]dula/i);
});

test('si el modelo ya pidio los datos en prosa no se duplica el pedido', async () => {
  const phone = '584120000505';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionLead({ history: [
    { role: 'assistant', content: 'Te queda bien esta agencia?', at: '2026-08-01T00:00:00.000Z' },
  ] }) }));
  classificationToReturn = null;
  replyToReturn = { text: 'Perfecto. Me envias tu nombre y apellido, cedula y telefono para completar tu pedido?', images: [] };
  textosEnviados.length = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'si' } }, 'Ana');
  await esperarProcesamiento(600);
  const n = textosEnviados.filter((m) => m.to === phone && /C[eé]dula/i.test(m.text)).length;
  assert.equal(n, 1);
  assert.equal(getSession(phone).orderDataRequested, true);
});

test('una persona pregunta "confirmas el envio y retiro?" y el cliente dice "si perfecto": queda vendido', async () => {
  const phone = '584120000511';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionLead({
    stage: 'negociando',
    card: { producto: 'Combo mixto', nombre: 'Alfonso Rojas', cedula: '21387871', telefono: '04143835162', ciudad: 'Puerto La Cruz' },
    history: [
      { role: 'assistant', content: 'Gracias, Alfonso, ya tengo tus datos.', at: '2026-08-01T00:00:00.000Z' },
      { role: 'human', content: 'Amigo confirmas que te lo enviemos y que lo retiraras en la agencia de tealca?', at: '2026-08-01T00:10:00.000Z' },
    ],
  }) }));
  classificationToReturn = { stage: 'negociando', razon: 'sigue', card: {} };
  replyToReturn = { text: 'Perfecto, quedo atento a cualquier cosa.', images: [] };
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'Si perfecto' } }, 'Alfonso');
  await esperarProcesamiento(600);
  const s = getSession(phone);
  assert.equal(s.orderClosed, true);
  assert.ok(s.soldAt, 'tiene que guardar la fecha de venta');
  assert.equal(s.stage, 'vendido');
});

test('el mismo "si perfecto" NO cierra si faltan datos o si no se pregunto por el envio', async () => {
  const phone = '584120000512';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionLead({
    stage: 'negociando', card: { producto: 'Combo mixto', nombre: 'Alfonso Rojas' },
    history: [{ role: 'human', content: 'Confirmas que lo retiras en la agencia de tealca?', at: '2026-08-01T00:10:00.000Z' }],
  }) }));
  classificationToReturn = null;
  replyToReturn = { text: 'Perfecto.', images: [] };
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'Si perfecto' } }, 'Alfonso');
  await esperarProcesamiento(600);
  assert.notEqual(getSession(phone).orderClosed, true, 'sin cedula/telefono no se cierra');
  const phone2 = '584120000513';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: getSession(phone), [phone2]: sesionLead({
    stage: 'negociando', card: { producto: 'Combo mixto', nombre: 'Ana Perez', cedula: '12345678', telefono: '04141234567' },
    history: [{ role: 'human', content: 'Te gusta el producto?', at: '2026-08-01T00:10:00.000Z' }],
  }) }));
  await flow.handleIncomingMessage(phone2, { type: 'text', text: { body: 'Si perfecto' } }, 'Ana');
  await esperarProcesamiento(600);
  assert.notEqual(getSession(phone2).orderClosed, true, 'sin pregunta de confirmacion de envio no se cierra');
});

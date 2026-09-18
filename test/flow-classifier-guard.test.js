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
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('flow-classifier-guard');
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

test('un "gracias" no degrada un estado logistico confirmado (el clasificador propone retroceder y se ignora)', async () => {
  const phone = '584120000400';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionBase() }));

  replyToReturn = { text: 'De nada, cualquier cosa me escribis!', images: [] };
  // El clasificador (equivocado, por leer mal un "gracias" suelto) propone
  // retroceder de esperando_retiro a vendido.
  classificationToReturn = { stage: 'vendido', razon: 'cliente agradecio', card: {} };

  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'gracias!' } }, 'Carlos');
  await esperarProcesamiento();

  const session = getSession(phone);
  assert.equal(session.stage, 'esperando_retiro', 'BUG si esto cambio: un "gracias" no debe poder retroceder un pedido ya esperando_retiro');
});

test('el clasificador SI puede avanzar la etapa (esperando_retiro -> entregado) cuando corresponde', async () => {
  const phone = '584120000401';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionBase() }));

  replyToReturn = { text: 'Que bueno que ya te llego!', images: [] };
  classificationToReturn = { stage: 'entregado', razon: 'cliente confirmo que ya lo recibio', card: {} };

  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'ya me llego, gracias' } }, 'Carlos');
  await esperarProcesamiento();

  const session = getSession(phone);
  assert.equal(session.stage, 'entregado', 'el clasificador SI debe poder avanzar (nunca retroceder) la etapa');
});

test('un cambio de estado ocurrido MIENTRAS se generaba la respuesta no termina mandando un mensaje contradictorio', async () => {
  const phone = '584120000402';
  // Arranca en "vendido" (todavia sin guia): el prompt para la IA se arma
  // con esa etapa, y en un mundo real el modelo podria (correctamente, para
  // ESA etapa) decir algo como "todavia hay que esperar a que llegue".
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ stage: 'vendido', card: { nombre: 'Carlos', producto: 'Shilajit' }, shippingNotifiedAt: null, arrivalNotifiedAt: null }),
  }));
  classificationToReturn = null; // no hace falta reclasificar para este caso

  // Mientras "se genera" la respuesta (dentro del mock de getAssistantReply,
  // como si fuera la llamada real a OpenAI en curso), alguien en el panel
  // marca que el pedido YA LLEGO -- un cambio de estado concurrente real.
  replyToReturn = async () => {
    updateSession(phone, { stage: 'esperando_retiro', stageLocked: true, stageReason: 'Fijada desde el panel' });
    return { text: 'Debes esperar a que llegue para retirarlo.', images: [] };
  };

  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'ya puedo pasar a buscarlo?' } }, 'Carlos');
  await esperarProcesamiento();

  const enviado = textosEnviados.filter((m) => m.to === phone).pop();
  assert.ok(enviado, 'el bot tiene que haber mandado algun mensaje');
  assert.equal(
    enviado.text,
    flow.ALREADY_ARRIVED_CORRECTION,
    'BUG si esto no se corrigio: se mando un mensaje que contradice el estado vigente (ya esperando_retiro) al momento de mandar'
  );
});

test('sin ningun cambio de estado concurrente, una respuesta normal se manda tal cual (no se pisa de mas)', async () => {
  const phone = '584120000403';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ stage: 'vendido', shippingNotifiedAt: null, arrivalNotifiedAt: null }),
  }));
  classificationToReturn = null;
  replyToReturn = { text: 'Todavia se esta preparando tu pedido, en cuanto tengamos la guia te aviso.', images: [] };

  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'ya llego?' } }, 'Carlos');
  await esperarProcesamiento();

  const enviado = textosEnviados.filter((m) => m.to === phone).pop();
  assert.equal(enviado.text, 'Todavia se esta preparando tu pedido, en cuanto tengamos la guia te aviso.');
});

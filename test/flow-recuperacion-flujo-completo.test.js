// Prueba de integracion de punta a punta pedida explicitamente en la
// recuperacion a la version anterior a la regresion (86d5731 + el cambio
// comercial de "solo agencia, incluso Caracas"): combo con precio
// promocional, agencia confirmada, datos personales, consulta de plazo,
// cierre y etapa vendido -- verificando que no se piden datos repetidos y
// que una pregunta general no se convierte en una venta cerrada.
//
// Igual que test/flow-classifier-guard.test.js: whatsapp.js, ai.js y
// classifier.js se mockean ANTES de requerir flow.js (que las toma
// desestructuradas al cargarse). classifyConversation y getAssistantReply se
// controlan turno por turno para simular una conversacion real sin llamar a
// OpenAI ni a WhatsApp de verdad.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('flow-recuperacion-flujo-completo');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const whatsapp = require('../src/whatsapp');
const ai = require('../src/ai');
const classifierMod = require('../src/classifier');
const { updateSettings } = require('../src/settings');
const { getSession } = require('../src/state');

updateSettings({ replyDelayMs: 5, splitGapMinMs: 5, splitGapMaxMs: 8 });

const textosEnviados = [];
whatsapp.sendText = async (to, text) => { textosEnviados.push({ to, text }); return { messages: [{ id: 'wamid.TEST' }] }; };
whatsapp.sendImageByLink = async () => ({});
whatsapp.sendAudioByLink = async () => ({});
whatsapp.downloadMedia = async () => { throw new Error('no deberia llamarse en estos tests'); };

let classificationToReturn = null;
classifierMod.classifyConversation = async () => classificationToReturn;

let replyToReturn = { text: 'Todo bien!', images: [] };
ai.getAssistantReply = async (...args) => {
  const r = typeof replyToReturn === 'function' ? await replyToReturn(...args) : replyToReturn;
  return r;
};

const flow = require('../src/flow');
const push = require('../src/push');
push.notifySale = () => {};

after(() => cleanup(dataDir));

function esperarProcesamiento(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 150));
}

async function turno(phone, texto, { reply, classification }) {
  replyToReturn = reply;
  classificationToReturn = classification;
  textosEnviados.length = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: texto } }, 'Cliente Test');
  await esperarProcesamiento();
  return textosEnviados.map((e) => e.text).join(' ');
}

test('flujo completo: combo promocional -> agencia -> datos -> plazo -> cierre -> vendido, sin repetir datos ni falsos cierres', async () => {
  const phone = '584120009900';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({}));

  // Turno 1: el cliente pregunta por el combo con precio promocional.
  let enviado = await turno(phone, 'Hola, cuanto sale el combo de 2 frascos de Shilajit?', {
    reply: { text: 'El combo de 2 frascos de Shilajit tiene precio promocional de 800Bs (en vez de 900Bs). En que ciudad estas para ver como te lo hacemos llegar?', images: [] },
    classification: { stage: 'nuevo', razon: 'pregunto precio de combo', card: { producto: 'Shilajit x2 (combo)' } },
  });
  assert.match(enviado, /800\s*bs/i);
  assert.doesNotMatch(enviado, /domicilio/i, 'BUG: no deberia mencionar domicilio como opcion');

  // Turno 2: dice la ciudad (Caracas) -- ya NO se le debe ofrecer domicilio,
  // se le debe buscar agencia directamente (simulamos que el bot ya llamo a
  // buscar_agencias_por_zona y presenta la lista).
  enviado = await turno(phone, 'Estoy en Caracas', {
    reply: { text: 'Perfecto, en Caracas tenemos estas agencias Tealca:\n1. Tealca Chacao, Av Francisco de Miranda\n2. Tealca Catia, Av Sucre\n¿Cual te queda mejor?', images: [] },
    classification: { stage: 'nuevo', razon: 'dio la ciudad', card: { ciudad: 'Caracas' } },
  });
  assert.doesNotMatch(enviado, /te lo llevamos a tu direccion|domicilio/i, 'BUG: se ofrecio domicilio en Caracas');
  assert.match(enviado, /agencia/i);

  // Turno 3: confirma la agencia.
  enviado = await turno(phone, 'La de Chacao esta bien', {
    reply: { text: 'Dale, Tealca Chacao entonces. Para procesar tu pedido envianos:\n👤 Nombre y apellido:\n🆔 Cédula:\n📞 Teléfono:\n🚚 Enviaremos tu pedido GRATIS por Tealca a la oficina más cercana', images: [] },
    classification: { stage: 'nuevo', razon: 'confirmo agencia', card: { agencia: 'Tealca Chacao' } },
  });
  assert.match(enviado, /nombre y apellido/i);
  let session = getSession(phone);
  assert.equal(session.orderDataRequested, true, 'debe quedar marcado que ya se pidieron los datos, para no repetirlos');

  // Turno 4: da sus datos personales.
  enviado = await turno(phone, 'Maria Perez, cedula 12345678, telefono 04121234567', {
    reply: { text: 'Genial Maria, ya tengo tus datos. Cualquier otra cosa me avisas.', images: [] },
    classification: { stage: 'nuevo', razon: 'dio datos personales', card: { nombre: 'Maria Perez', cedula: '12345678', telefono: '04121234567' } },
  });
  session = getSession(phone);
  assert.equal(session.card.nombre, 'Maria Perez');
  assert.equal(session.card.cedula, '12345678');

  // Turno 5: pregunta general de plazo -- NO debe cerrar el pedido ni
  // repetir el pedido de datos (ya los tiene).
  enviado = await turno(phone, 'En cuanto tiempo llega una vez que lo mando?', {
    reply: { text: 'Normalmente entre 24 y 48 horas llega a la agencia una vez que se despacha, y ahi te avisamos.', images: [] },
    classification: { stage: 'nuevo', razon: 'pregunta de plazo, no es un cierre', card: {} },
  });
  assert.doesNotMatch(enviado, /nombre y apellido|cedula|tel[eé]fono:/i, 'BUG: volvio a pedir datos ya dados');
  session = getSession(phone);
  assert.notEqual(session.stage, 'vendido', 'BUG: una pregunta general de plazo no debe cerrar el pedido');
  assert.notEqual(session.orderClosed, true, 'BUG: una pregunta general de plazo no debe marcar orderClosed');

  // Turno 6: cierre real.
  enviado = await turno(phone, 'Dale, cierralo asi', {
    reply: {
      text: 'Listo Maria, tu pedido queda asi: 2 frascos de Shilajit, retiras en Tealca Chacao. El pago es contra entrega, ahi mismo cuando retires. En cuanto tengamos la guia de Tealca te la pasamos y te avisamos apenas llegue a la agencia.',
      images: [],
    },
    classification: { stage: 'vendido', razon: 'cliente confirmo el cierre', card: {} },
  });
  session = getSession(phone);
  assert.equal(session.orderClosed, true, 'el cierre real SI debe marcar orderClosed');
  const { SOLD_STAGES } = require('../src/flow');
  assert.ok(SOLD_STAGES.includes(session.stage), `la etapa final (${session.stage}) debe ser una etapa de venta cerrada`);
  assert.equal(session.card.nombre, 'Maria Perez', 'los datos previos no se deben perder al cerrar');
  assert.equal(session.card.agencia, 'Tealca Chacao', 'los datos previos no se deben perder al cerrar');

  // Turno 7: un saludo/agradecimiento post-cierre no debe reabrir el pedido
  // ni volver a pedir datos.
  enviado = await turno(phone, 'gracias!', {
    reply: { text: 'De nada Maria, cualquier cosa me avisas!', images: [] },
    classification: { stage: 'vendido', razon: 'agradecimiento post-cierre', card: {} },
  });
  assert.doesNotMatch(enviado, /nombre y apellido|cedula/i);
  session = getSession(phone);
  assert.equal(session.orderClosed, true);
});

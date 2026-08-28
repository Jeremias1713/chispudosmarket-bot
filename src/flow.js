// Logica de conversacion: el bot es un chatbot con IA (OpenAI). Este archivo
// decide que hacer con cada mensaje entrante: comandos globales, ubicacion
// (que se resuelve solo, sin IA, para que sea instantaneo y gratis), y todo
// lo demas se lo pasamos al modelo (ver ./ai.js) que responde como asesor de
// ventas y decide el texto.
const { sendText } = require('./whatsapp');
const { getSession, updateSession, resetSession, appendMessage } = require('./state');
const { nearestByCoords, searchByText, formatAgency } = require('./agencies');
const { getAssistantReply, splitReply } = require('./ai');
const { classifyConversation } = require('./classifier');

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'nuestro negocio';
const SPLIT_GAP_MIN_MS = parseInt(process.env.SPLIT_GAP_MIN_MS || '1500', 10);
const SPLIT_GAP_MAX_MS = parseInt(process.env.SPLIT_GAP_MAX_MS || '3500', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomGap() {
  return SPLIT_GAP_MIN_MS + Math.random() * (SPLIT_GAP_MAX_MS - SPLIT_GAP_MIN_MS);
}

async function sendSplit(to, text) {
  const parts = splitReply(text);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(randomGap());
    await sendText(to, parts[i]);
  }
  return parts;
}

async function sendGreeting(to) {
  const text = `Hola! Bienvenido a ${BUSINESS_NAME}. Contame, en que te puedo ayudar hoy?`;
  await sendText(to, text);
  appendMessage(to, 'assistant', text);
}

// profileName: el nombre de perfil que WhatsApp manda junto al mensaje
// (value.contacts[0].profile.name en el webhook). Se guarda en la sesion
// para que el panel pueda mostrar un nombre en vez de solo el numero.
async function handleIncomingMessage(from, message, profileName) {
  const session = getSession(from);
  const type = message.type;

  if (profileName && profileName !== session.name) {
    updateSession(from, { name: profileName });
  }

  const rawText =
    type === 'text'
      ? message.text.body.trim()
      : type === 'interactive' && message.interactive?.button_reply
        ? message.interactive.button_reply.title
        : type === 'interactive' && message.interactive?.list_reply
          ? message.interactive.list_reply.title
          : '';
  const lower = rawText.toLowerCase();

  // El mensaje entrante se guarda SIEMPRE, aunque el bot este pausado: el
  // panel tiene que ver la conversacion completa para que alguien pueda
  // tomarla a mano.
  if (rawText) appendMessage(from, 'user', rawText);
  else if (type === 'location') appendMessage(from, 'user', '[Comparti su ubicacion GPS]');
  else appendMessage(from, 'user', `[${type || 'mensaje'}]`);

  // Con el bot pausado desde el panel, un humano esta atendiendo esta
  // conversacion a mano: no se le contesta solo.
  if (session.paused) return;

  if (['menu', 'inicio', 'reiniciar', 'start'].includes(lower)) {
    resetSession(from);
    return sendGreeting(from);
  }

  if (type === 'location') {
    const { latitude, longitude } = message.location;
    const nearby = nearestByCoords(latitude, longitude, 3);
    const reply = !nearby.length
      ? 'Aun no tenemos agencias cargadas cerca de tu ubicacion.'
      : 'Estas son las agencias mas cercanas a tu ubicacion:\n\n' +
        nearby.map(formatAgency).join('\n\n');
    await sendText(from, reply);
    appendMessage(from, 'assistant', reply);
    return;
  }

  if (!rawText) {
    const reply = 'Por ahora solo puedo leer mensajes de texto o ubicacion. Me lo escribis, porfa?';
    await sendText(from, reply);
    appendMessage(from, 'assistant', reply);
    return;
  }

  const wordCount = rawText.split(/\s+/).filter(Boolean).length;
  const cityMatches = wordCount <= 4 ? searchByText(rawText, 3) : [];
  if (cityMatches.length > 0) {
    const reply =
      'Estas son las agencias que encontre:\n\n' +
      cityMatches.map((a) => formatAgency(a)).join('\n\n');
    await sendText(from, reply);
    appendMessage(from, 'assistant', reply);
    updateSession(from, { lastAssistantText: reply });
    return;
  }

  try {
    // El historial para la IA no incluye el mensaje que se acaba de guardar
    // (appendMessage ya lo persistio arriba): se relee la sesion para
    // mandarle a la IA exactamente lo mismo que ve el panel.
    const history = [...(getSession(from).history || [])].map((m) => ({ role: m.role, content: m.content }));
    const reply = await getAssistantReply(history.slice(0, -1), rawText);

    appendMessage(from, 'assistant', reply);
    updateSession(from, { lastAssistantText: reply });

    await sendSplit(from, reply);

    // Clasificacion de etapa + ficha del cliente. Corre despues de mandar la
    // respuesta para no sumarle latencia al mensaje del cliente. Si falla,
    // no rompe nada: simplemente la etapa/ficha no se actualiza este turno.
    // Si la etapa esta fijada a mano desde el panel, no se toca.
    const current = getSession(from);
    if (!current.stageLocked) {
      const classification = await classifyConversation(current.history.map((m) => ({ role: m.role, content: m.content })));
      if (classification) {
        updateSession(from, { stage: classification.stage, stageReason: classification.razon || null, card: classification.card });
      }
    }
  } catch (err) {
    console.error('Error llamando a la IA (diagnostico):', {
      message: err.message,
      name: err.name,
      status: err.status,
      code: err.code,
      cause: err.cause ? String(err.cause) : undefined,
      causeCode: err.cause && err.cause.code,
      stack: err.stack,
    });
    const reply = 'Disculpa, tuve un problema para responderte. Me repetis eso en un momento?';
    await sendText(from, reply);
    appendMessage(from, 'assistant', reply);
  }
}

module.exports = { handleIncomingMessage, sendSplit, sendGreeting };

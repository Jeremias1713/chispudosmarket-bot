// Logica de conversacion: el bot es un chatbot con IA (OpenAI). Este archivo
// decide que hacer con cada mensaje entrante: comandos globales, ubicacion
// (que se resuelve solo, sin IA, para que sea instantaneo y gratis), el
// gatillo de un producto (mensaje inicial fijo, sin pasar por la IA), y todo
// lo demas se lo pasamos al modelo (ver ./ai.js) que responde como asesor de
// ventas y decide el texto.
//
// Espera antes de contestar: el mensaje del cliente se guarda al toque
// (appendMessage), pero la respuesta se demora unos segundos (ver
// scheduleReply). Si el cliente manda varios mensajes seguidos ("hola" /
// "cuanto sale" / "el aceite" en tres mensajes), cada uno reinicia la
// espera: el bot recien contesta una vez, cuando el cliente se queda
// callado ese rato, usando todo lo que dijo mientras tanto (ya quedo
// guardado en el historial).
const { sendText, sendImageByLink, sendAudioByLink } = require('./whatsapp');
const { getSession, updateSession, resetSession, appendMessage } = require('./state');
const { nearestByCoords, formatAgency } = require('./agencies');
const { getAssistantReply, splitReply, enforceMessageLimits } = require('./ai');
const { classifyConversation } = require('./classifier');
const { matchTrigger } = require('./catalog');
const { getImage } = require('./library');
const { getSettings } = require('./settings');
const { generateSpeech, deleteSpeech } = require('./tts');

const SPLIT_GAP_MIN_MS = parseInt(process.env.SPLIT_GAP_MIN_MS || '1500', 10);
const SPLIT_GAP_MAX_MS = parseInt(process.env.SPLIT_GAP_MAX_MS || '3500', 10);
const DEFAULT_REPLY_DELAY_MS = 8000;
const DEFAULT_MAX_WORDS_HARD_CAP = 90;
const DEFAULT_MAX_MESSAGE_PARTS = 5;
// Render define RENDER_EXTERNAL_URL solo automaticamente; PUBLIC_URL es el
// override manual por si se corre en otro lado.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomGap() {
  return SPLIT_GAP_MIN_MS + Math.random() * (SPLIT_GAP_MAX_MS - SPLIT_GAP_MIN_MS);
}

function mediaUrl(filename) {
  // Sin PUBLIC_URL configurado no se puede armar un link publico: se manda
  // solo texto (WhatsApp no acepta una foto o un audio sin URL alcanzable
  // desde afuera).
  if (!PUBLIC_URL) return null;
  return `${PUBLIC_URL}/media/${filename}`;
}

// Manda el texto ya partido en mensajes cortos. El objetivo de palabras
// (maxWordsPerMessage) es solo una guia que se le da al modelo en el prompt;
// aca abajo solo se aplica el TOPE DURO (maxWordsHardCap) como red de
// seguridad, para no cortar a la mitad una explicacion de producto, del
// formulario o de una agencia que el modelo decidio extender a proposito.
// Igual respeta el maximo de mensajes por respuesta (configurables desde el
// panel, Configuracion). Devuelve las partes mandadas.
async function sendSplit(to, text) {
  const settings = getSettings();
  const maxWordsHardCap = settings.maxWordsHardCap || DEFAULT_MAX_WORDS_HARD_CAP;
  const maxParts = settings.maxMessageParts || DEFAULT_MAX_MESSAGE_PARTS;
  const parts = enforceMessageLimits(splitReply(text), maxWordsHardCap, maxParts);

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(randomGap());
    await sendText(to, parts[i]);
  }
  return parts;
}

// Ademas del texto, manda una nota de voz con la misma respuesta (si esta
// prendido en Configuracion y el servidor tiene una URL publica). Cualquier
// error aca se atrapa y se ignora: el audio es un extra, el bot ya contesto
// por texto de todas formas.
async function maybeSendAudio(to, text) {
  const settings = getSettings();
  if (!settings.audioReplyEnabled) return;
  if (!PUBLIC_URL) return; // sin URL publica no hay como mandar el archivo

  const clean = String(text || '').trim();
  if (!clean) return;

  let speech;
  try {
    speech = await generateSpeech(clean);
    const link = mediaUrl(speech.filename);
    if (!link) return; // sin PUBLIC_URL no hay como mandarlo
    await sendAudioByLink(to, link);
  } catch (err) {
    console.warn('No se pudo mandar la nota de voz, sigo solo con texto:', err.message);
  } finally {
    if (speech) deleteSpeech(speech.filepath);
  }
}

// Guarda el mensaje en el historial, lo manda partido en texto y, si
// corresponde, tambien como nota de voz. Uso general para casi toda
// respuesta del bot (saludo, ubicacion, gatillo de producto sin foto,
// respuesta de la IA).
async function sendReply(to, text) {
  appendMessage(to, 'assistant', text);
  const parts = await sendSplit(to, text);
  await maybeSendAudio(to, text);
  return parts;
}

// Manda un mensaje con foto si hay una imagen de biblioteca valida y URL
// publica disponible; si no, cae a texto solo. Uso compartido por el saludo
// inicial y por el mensaje inicial de un producto (ambos con la misma logica
// de "intentar mandar la foto, si falla seguir solo con texto").
async function sendTextOrImage(to, text, imageId) {
  if (imageId) {
    const img = getImage(imageId);
    const url = img && mediaUrl(img.filename);
    if (url) {
      try {
        await sendImageByLink(to, url, text);
        appendMessage(to, 'assistant', `[imagen] ${text}`);
        await maybeSendAudio(to, text);
        return;
      } catch (err) {
        console.error('No se pudo mandar la foto, sigo solo con texto:', err.message);
      }
    }
  }
  await sendReply(to, text);
}

async function sendGreeting(to) {
  const settings = getSettings();
  const businessName = settings.businessName || process.env.BUSINESS_NAME || 'nuestro negocio';
  const text = (settings.welcomeMessage && settings.welcomeMessage.trim())
    || `Hola! Bienvenido a ${businessName}. Contame, en que te puedo ayudar hoy?`;
  await sendTextOrImage(to, text, settings.welcomeImageId);
}

// Contexto del ultimo mensaje de cada conversacion en lo que va de la espera
// (ver scheduleReply): se pisa con cada mensaje nuevo del cliente, asi que
// cuando se cumple la espera se contesta usando el mas reciente (los
// anteriores ya quedaron guardados en el historial por appendMessage).
const pendingContext = new Map(); // phone -> { type, rawText, lower, location }
const pendingTimers = new Map(); // phone -> timeout handle

function scheduleReply(from) {
  const settings = getSettings();
  const delayMs = settings.replyDelayMs != null ? Number(settings.replyDelayMs) : DEFAULT_REPLY_DELAY_MS;

  const existing = pendingTimers.get(from);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingTimers.delete(from);
    processReply(from).catch((err) => console.error('Error procesando respuesta demorada:', err));
  }, delayMs);

  pendingTimers.set(from, timer);
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

  // El mensaje entrante se guarda SIEMPRE, aunque el bot este apagado o
  // pausado en esta conversacion: el panel tiene que ver la conversacion
  // completa para que alguien pueda tomarla a mano.
  if (rawText) appendMessage(from, 'user', rawText);
  else if (type === 'location') appendMessage(from, 'user', '[Comparti su ubicacion GPS]');
  else appendMessage(from, 'user', `[${type || 'mensaje'}]`);

  // Switch maestro (Configuracion, apaga TODO el bot) o pausa de esta
  // conversacion puntual (panel, boton "Bot activo" del chat): en cualquiera
  // de los dos casos un humano esta atendiendo, asi que no se contesta solo.
  if (!getSettings().botEnabled) return;
  if (session.paused) return;

  pendingContext.set(from, {
    type,
    rawText,
    lower,
    location: type === 'location' ? message.location : null,
  });

  scheduleReply(from);
}

// Se ejecuta cuando el cliente se quedo callado el tiempo configurado
// (Configuracion, por defecto 8 segundos) despues de su ultimo mensaje.
async function processReply(from) {
  const ctx = pendingContext.get(from);
  pendingContext.delete(from);
  if (!ctx) return;

  // Se revisa de nuevo por si algo cambio mientras se esperaba (un humano
  // tomo la conversacion desde el panel, o se apago el bot).
  const session = getSession(from);
  if (!getSettings().botEnabled) return;
  if (session.paused) return;

  const { type, rawText, lower, location } = ctx;

  if (['menu', 'inicio', 'reiniciar', 'start'].includes(lower)) {
    resetSession(from);
    return sendGreeting(from);
  }

  if (type === 'location' && location) {
    const { latitude, longitude } = location;
    const nearby = nearestByCoords(latitude, longitude, 3);
    const reply = !nearby.length
      ? 'Aun no tenemos agencias cargadas cerca de tu ubicacion.'
      : 'Estas son las agencias mas cercanas a tu ubicacion:\n\n' +
        nearby.map(formatAgency).join('\n\n');
    await sendReply(from, reply);
    return;
  }

  if (!rawText) {
    const reply = 'Por ahora solo puedo leer mensajes de texto o ubicacion. Me lo escribis, porfa?';
    await sendReply(from, reply);
    return;
  }

  // Gatillo de producto: solo la primera vez que se detecta en la
  // conversacion (no cada vez que menciona la palabra de nuevo), y solo si
  // el producto tiene mensaje inicial cargado. Sale tal cual, sin pasar por
  // la IA: es la presentacion que el negocio escribio a mano.
  if (!session.linkedProductId) {
    const product = matchTrigger(rawText);
    if (product && product.intro && product.intro.trim()) {
      updateSession(from, { linkedProductId: product.id });
      const intro = product.intro.trim();
      await sendTextOrImage(from, intro, product.introImageId);
      return;
    }
  }

  try {
    // El historial para la IA incluye todo lo que el cliente mando mientras
    // se esperaba (ya quedo persistido por appendMessage en cada mensaje):
    // se relee la sesion y se usa el ultimo turno como userText, el resto
    // como historial, exactamente lo mismo que ve el panel.
    const fullHistory = [...(getSession(from).history || [])].map((m) => ({ role: m.role, content: m.content }));
    const history = fullHistory.slice(0, -1);
    const userText = fullHistory.length ? fullHistory[fullHistory.length - 1].content : rawText;
    const reply = await getAssistantReply(history, userText);

    await sendReply(from, reply);
    updateSession(from, { lastAssistantText: reply });

    // Clasificacion de etapa + ficha del cliente. Corre despues de mandar la
    // respuesta para no sumarle latencia. Si falla, no rompe nada: la
    // etapa/ficha simplemente no se actualiza este turno. Si la etapa esta
    // fijada a mano desde el panel, no se toca.
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

module.exports = { handleIncomingMessage, sendSplit, sendGreeting, mediaUrl };

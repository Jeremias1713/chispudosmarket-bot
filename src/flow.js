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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendText, sendImageByLink, sendAudioByLink, downloadMedia } = require('./whatsapp');
const { transcribeAudio } = require('./stt');
const { describeImage } = require('./vision');
const { getSession, updateSession, resetSession, appendMessage } = require('./state');
const { nearestByCoords, formatAgency, findKnownCityKey } = require('./agencies');
const {
  getAssistantReply,
  applySplitPolicy,
  isClosingMessage,
  looksLikeClosingSummaryText,
  evaluateOrderCompleteness,
  buildIncompleteOrderNotice,
  looksLikeEmptyDataRequest,
  mentionsDataFieldsAsRequest,
  stripDuplicateDataRequest,
  DATA_REQUEST_REMINDER,
  stripPostCloseQuestion,
  POST_CLOSE_REMINDER,
  buildDirectAgencyMessage,
  getDataRequestTemplate,
  looksLikeAgencyConfirmation,
  extractConfirmedAgencyLabel,
  guardAgainstUnauthorizedDelivery,
} = require('./ai');
const { classifyConversation } = require('./classifier');
const { matchTrigger, findProduct } = require('./catalog');
const { getImage, MEDIA_DIR } = require('./library');
const { getSettings } = require('./settings');
const { generateSpeech, deleteSpeech } = require('./tts');
const push = require('./push');
const { SOLD_STAGES, isAllowedAutoTransition } = require('./stageRules');
const { applyOrderMessage } = require('./orderMemory');

const SPLIT_GAP_MIN_MS = parseInt(process.env.SPLIT_GAP_MIN_MS || '6000', 10);
const SPLIT_GAP_MAX_MS = parseInt(process.env.SPLIT_GAP_MAX_MS || '9500', 10);
const DEFAULT_REPLY_DELAY_MS = 8000;
// Render define RENDER_EXTERNAL_URL solo automaticamente; PUBLIC_URL es el
// override manual por si se corre en otro lado.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
// SOLD_STAGES (que etapas cuentan como venta cerrada) e
// isAllowedAutoTransition (que reclasificaciones automaticas se pueden
// aplicar sin retroceder/pisar un avance logistico ya confirmado) ahora
// viven en stageRules.js, compartido con panel.js y shipping.js -- ver ese
// archivo para el detalle de cada regla. Se reexporta SOLD_STAGES aca abajo
// (module.exports) para no romper a quienes ya lo importan desde './flow'
// (server.js, remarketing.js, seguimiento.js, panel.js).

// Red de seguridad de codigo: esto paso de verdad una vez (ver
// buildDirectAgencyMessage en ai.js) — el modelo le prometio a un cliente
// "te busco la agencia mas cercana, dame un momentito" y nunca llamo a la
// herramienta ni mando la lista real, dejando al cliente esperando una
// respuesta que nunca llegaba. El prompt ya le pide explicitamente que
// nunca haga esto, pero es una instruccion probabilistica (no siempre se
// respeta), asi que esto detecta la promesa incumplida por el TEXTO que ya
// mando el bot y, si corresponde, manda la lista real como mensaje aparte
// en el mismo momento, en vez de dejar al cliente esperando.
// OJO: esta lista se amplio despues de DOS casos reales que no matcheaban
// ninguna de las frases que habia hasta ese momento:
// 1) "voy a buscar las agencias de Tealca mas cercanas... Un momento, por
//    favor" (cubria "te buscar", "dame un momento", etc, pero no "voy a
//    buscar" ni "un momento" sin "dame" adelante).
// 2) "Perfecto, entonces te busco la agencia Tealca mas cercana. Un
//    momento. 🔍" — este quedo sin mandar la agencia real NUNCA (el cliente
//    se quedo esperando sin que nada mas se le enviara), porque el regex
//    solo tenia "te buscar" (con R al final, infinitivo) y no "te busco"
//    (presente), y porque "un momento" a secas (sin "en" antes ni "por
//    favor" despues, como paso aca) tampoco matcheaba ninguna alternativa.
// Ahora "un momento" solo (en cualquier posicion) ya alcanza para
// dispararlo, y se agrego "te busco"/"buscando" en presente.
const PENDING_AGENCY_PROMISE_RE =
  /te buscar|te busco|buscando la agencia|voy a buscar|dame un moment|un momento|ya te (busco|paso|env[ií]o)|enseguida te|en breve|ahorita te/i;

function looksLikePendingAgencyPromise(text) {
  const t = String(text || '');
  if (!/agencia/i.test(t) || !PENDING_AGENCY_PROMISE_RE.test(t)) return false;
  // Si el mensaje YA trae una lista numerada (1. ... 2. ...), es porque la
  // herramienta si se llamo y la lista real ya se mando: no es una promesa
  // sin cumplir, es solo texto de acompañamiento. Solo cuenta como promesa
  // incumplida cuando NO hay ninguna lista numerada en el mensaje.
  return !/(^|\n)\s*\d+[.)]\s/.test(t);
}

// Mismo mecanismo que looksLikePendingAgencyPromise, para el otro caso real
// que se detecto: el bot le dice al cliente "te paso el formulario" (o "te
// mando el enlace/link para tus datos") para pedirle nombre/cedula/telefono,
// pero no existe ningun formulario ni enlace en el sistema — el pedido de
// datos SIEMPRE es el texto fijo de dataRequestTemplate (ver ai.js), escrito
// directo en el chat. Si el bot promete eso y no incluyo el texto real de
// pedido de datos en el mismo mensaje, se lo mandamos nosotros mismos (sin
// pasar por el modelo), igual que con la promesa de agencia.
const PENDING_FORM_PROMISE_RE =
  /formulario|el enlace|el link/i;

function looksLikePendingFormPromise(text) {
  const t = String(text || '');
  if (!PENDING_FORM_PROMISE_RE.test(t)) return false;
  // Si el mensaje YA trae el pedido de datos real (las etiquetas Nombre/
  // Cedula/Telefono vacias, ver looksLikeEmptyDataRequest), no es una
  // promesa sin cumplir: el dato real ya se mando en este mismo mensaje.
  return !looksLikeEmptyDataRequest(t);
}

// Caso real reportado por el negocio: con el pedido ya en la etapa
// "esperando_retiro" (YA LLEGO a la agencia, ver SHIPPING_STAGE_TEXT en
// ai.js), el modelo igual le contesto a un cliente que su pedido "todavia
// esta en camino" / "todavia no ha llegado". El prompt ya le dice al modelo
// la etapa real, pero como con las otras dos redes de seguridad de arriba,
// es una instruccion probabilistica que no siempre se respeta. Esto agrega
// el ultimo filtro posible: si la etapa real es esperando_retiro y la
// respuesta del bot de todos modos dice que todavia no llego, se DESCARTA
// esa respuesta entera y se manda la correccion fija en su lugar, para que
// nunca le llegue al cliente un mensaje que contradice el estado real del
// pedido (a esta altura, siempre es mentira: si esta en esperando_retiro es
// porque ya se le aviso que llego, ver maybeNotifyShipping en shipping.js y
// applyItems en seguimiento.js).
// FASE (correccion H-esperando_retiro): la lista original solo cubria un
// puñado de frases armadas a mano ("todavia no ha llegado", "esta en
// camino"...), y quedaron afuera casos reales reportados por el negocio como
// "recuerda que tu pedido tiene que llegar primero" o "debes esperar a que
// llegue para retirarlo" -- ninguna de esas dos tiene "todavia"/"aun" ni la
// palabra "camino"/"transito", asi que el regex viejo no las agarraba. Se
// generaliza a CUALQUIER frase que afirme que el pedido sigue en transito, o
// que el cliente tiene que ESPERAR A QUE LLEGUE para algo (retirarlo,
// recibirlo, etc), venga con la forma que venga.
const NOT_ARRIVED_CLAIM_RE =
  /(?:todav[ií]a|a[uú]n)\s*no\s*(?:ha\s*)?lleg|no\s*ha\s*llegado(?:\s*todav[ií]a)?|(?:sigue|todav[ií]a|esta|está)\s*en\s*(?:camino|tr[aá]nsito)|(?:tiene[s]?|ten[eé]s|hay)\s*que\s*llegar\s*primero|(?:(?:tiene[s]?|ten[eé]s|hay)\s*que|deb[eé]s)\s*esperar\s*(?:a\s*)?que\s*llegue|falta\s*(?:que|para que)\s*llegue|cuando\s*llegue\s*te\s*aviso|te\s*aviso\s*(?:cuando|apenas)\s*llegue/i;

// Si en la MISMA frase aparece una negacion clara de esa idea (por ejemplo
// "no tenes que esperar a que llegue: ya esta disponible", o "ya no hace
// falta que llegue"), NO es una contradiccion -- es al reves, le esta
// confirmando que ya llego. Sin este chequeo, una respuesta correcta como
// esa quedaria bloqueada y reemplazada por el texto fijo, mostrandole al
// cliente una respuesta peor que la que el modelo ya habia armado bien.
const ARRIVED_NEGATION_RE =
  /no\s*(?:tienes|ten[eé]s|hace falta|hay que|debes|deb[eé]s)\s*(?:que\s*)?esperar|ya\s*(?:no\s*)?(?:esta|está)\s*(?:disponible|list[oa](?:\s*para\s*retirar(?:lo|la)?)?)|ya\s*lleg[oó]|ya\s*pod[eé]s?\s*(?:pasar|retirarlo|retirarla)/i;

function looksLikeSaysNotArrivedYet(text) {
  const t = String(text || '');
  if (!NOT_ARRIVED_CLAIM_RE.test(t)) return false;
  return !ARRIVED_NEGATION_RE.test(t);
}

const ALREADY_ARRIVED_CORRECTION =
  '¡Tu pedido ya llegó a la agencia de destino y está listo para que lo retires! 📦 Recordá que Tealca atiende de lunes a viernes de 9am a 4pm.';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomGap(minMs, maxMs) {
  const min = minMs != null ? minMs : SPLIT_GAP_MIN_MS;
  const max = maxMs != null ? maxMs : SPLIT_GAP_MAX_MS;
  if (max <= min) return min;
  return min + Math.random() * (max - min);
}

function mediaUrl(filename) {
  // Sin PUBLIC_URL configurado no se puede armar un link publico: se manda
  // solo texto (WhatsApp no acepta una foto o un audio sin URL alcanzable
  // desde afuera).
  if (!PUBLIC_URL) return null;
  return `${PUBLIC_URL}/media/${filename}`;
}

// Extension de archivo segun el mime type que manda Meta para una nota de
// voz (ej. "audio/ogg; codecs=opus"). Si no lo reconoce, usa ogg (el formato
// mas comun en notas de voz de WhatsApp).
const INCOMING_AUDIO_EXT_BY_MIME = {
  ogg: 'ogg',
  opus: 'ogg',
  mpeg: 'mp3',
  mp3: 'mp3',
  mp4: 'm4a',
  aac: 'aac',
  amr: 'amr',
  wav: 'wav',
};

// Guarda en disco (junto a las fotos de la biblioteca, en data/media/) el
// audio original de una nota de voz que mando el cliente, y devuelve la URL
// publica para reproducirlo desde el panel. La transcripcion (Whisper) a
// veces sale mal por ruido, acento o un audio cortado, y el negocio necesita
// poder escuchar la nota de voz posta para confirmar que dijo el cliente, no
// solo confiar en el texto transcripto.
function saveIncomingAudio(buffer, mimeType) {
  if (!PUBLIC_URL) return null; // sin URL publica no hay como reproducirlo despues
  const subtype = String(mimeType || '').split(';')[0].split('/')[1] || '';
  const ext = INCOMING_AUDIO_EXT_BY_MIME[subtype.trim().toLowerCase()] || 'ogg';
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const filename = `audio-in-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
  return mediaUrl(filename);
}

// Mismo mecanismo que saveIncomingAudio, pero para fotos y videos que manda
// el cliente. El negocio no tenia forma de verlos: quedaban como "[image]" o
// "[video]" en el historial, sin poder abrirlos. Se guardan igual que el
// audio (junto a la biblioteca, en data/media/) y quedan disponibles para el
// panel via el campo attachment del mensaje.
const INCOMING_IMAGE_EXT_BY_MIME = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' };
const INCOMING_VIDEO_EXT_BY_MIME = { mp4: 'mp4', '3gpp': '3gp', '3gp': '3gp' };

function saveIncomingMedia(buffer, mimeType, kind) {
  if (!PUBLIC_URL) return null; // sin URL publica no hay como mostrarlo despues
  const subtype = String(mimeType || '').split(';')[0].split('/')[1] || '';
  const table = kind === 'video' ? INCOMING_VIDEO_EXT_BY_MIME : INCOMING_IMAGE_EXT_BY_MIME;
  const ext = table[subtype.trim().toLowerCase()] || (kind === 'video' ? 'mp4' : 'jpg');
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const filename = `${kind}-in-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
  return mediaUrl(filename);
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
  const parts = applySplitPolicy(text, settings);
  const gapMin = settings.splitGapMinMs ?? SPLIT_GAP_MIN_MS;
  const gapMax = settings.splitGapMaxMs ?? SPLIT_GAP_MAX_MS;

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(randomGap(gapMin, gapMax));
    await sendText(to, parts[i]);
    // Cada parte queda como su propio mensaje en el historial (y por lo
    // tanto en el panel), igual que le llega al cliente por WhatsApp. Antes
    // sendReply guardaba el texto completo de un solo saque ANTES de
    // partirlo: el panel mostraba una sola burbuja gigante aunque el
    // cliente en realidad haya recibido 2, 3 o 4 mensajes separados.
    appendMessage(to, 'assistant', parts[i]);
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
// respuesta del bot (saludo por defecto sin mensaje propio, ubicacion,
// respuesta de la IA): texto que el bot arma solo, donde partirlo en varios
// mensajes cortos ayuda a que no se sienta como un bloque.
async function sendReply(to, text) {
  const parts = await sendSplit(to, text);
  await maybeSendAudio(to, text);
  return parts;
}

// Manda el texto TAL CUAL escribio el negocio en el panel, en un UNICO
// mensaje de WhatsApp, sin pasar por applySplitPolicy (nada de partirlo por
// los renglones en blanco que el negocio uso para separar visualmente cada
// seccion del mensaje). Uso para el mensaje inicial de un producto y el
// saludo de bienvenida cuando estan configurados a mano: son texto ya
// armado con su propio formato, no una respuesta libre de la IA, asi que no
// hay que tocarlos ni un poco.
async function sendRawReply(to, text) {
  await sendText(to, text);
  appendMessage(to, 'assistant', text);
  await maybeSendAudio(to, text);
}

// Manda un mensaje con una o varias fotos (de la biblioteca) mas el texto
// configurado a mano, si hay imagenes validas con URL publica; si no hay
// ninguna, o todas fallan, cae a texto solo (nunca se pierde el mensaje).
// Uso compartido por el saludo inicial y por el mensaje inicial de un
// producto: en los dos casos el texto es el que escribio el negocio en el
// panel, asi que se manda con sendRawReply (ver arriba), nunca partido.
async function sendTextOrImage(to, text, imageIds) {
  const ids = Array.isArray(imageIds) ? imageIds.filter(Boolean) : imageIds ? [imageIds] : [];
  const resolved = ids
    .map((id) => getImage(id))
    .filter(Boolean)
    .map((img) => ({ img, url: mediaUrl(img.filename) }))
    .filter((x) => x.url);

  if (!resolved.length) {
    await sendRawReply(to, text);
    return;
  }

  // WhatsApp no tiene forma de mandar varias fotos como un solo mensaje
  // "album" (eso no existe en su API para negocios, es un truco solo del
  // celular de una persona mandando a mano): cada foto siempre es un
  // mensaje aparte. Lo que si se puede controlar es el ORDEN: las fotos van
  // primero, todas al mismo tiempo (Promise.allSettled) para que lleguen
  // practicamente juntas, y SIN caption; el texto se manda aparte, DESPUES,
  // como un unico mensaje de WhatsApp (sendRawReply, sin partirlo). Antes el
  // texto iba pegado como caption de la primera foto, osea que era lo
  // PRIMERO que veia el cliente; el pedido es al reves, que las fotos
  // entren primero y el texto sea lo ultimo que lee, tal cual esta escrito.
  const results = await Promise.allSettled(resolved.map((r) => sendImageByLink(to, r.url)));
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      // Se guarda la URL como attachment (igual que las fotos que manda el
      // cliente) para que el panel la muestre de verdad en el chat, en vez
      // de solo el texto "[imagen]" sin nada para ver.
      appendMessage(to, 'assistant', '[imagen]', { attachment: { kind: 'image', url: resolved[i].url } });
    } else {
      console.error('No se pudo mandar una foto, sigo con las demas:', res.reason?.message);
    }
  });

  await sendRawReply(to, text);
}

// Manda, sin caption, las fotos que la IA decidio mostrar durante la charla
// (herramienta mostrar_foto en ai.js). Se llama antes de mandar la
// respuesta de texto normal.
async function sendConversationImages(to, images) {
  // Mismo motivo que en sendTextOrImage: pedirlas todas al mismo tiempo en
  // vez de una por una hace que le lleguen juntas al cliente, no en fila.
  const valid = (images || [])
    .map((img) => ({ img, url: mediaUrl(img.filename) }))
    .filter((x) => x.url);

  const results = await Promise.allSettled(valid.map((x) => sendImageByLink(to, x.url)));
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      // Mismo motivo que en sendTextOrImage: guardar el attachment para que
      // el panel pueda mostrar la imagen real, no solo su nombre en texto.
      appendMessage(to, 'assistant', `[imagen] ${valid[i].img.name}`, { attachment: { kind: 'image', url: valid[i].url } });
    } else {
      console.error('No se pudo mandar una foto durante la charla:', res.reason?.message);
    }
  });
}

async function sendGreeting(to) {
  const settings = getSettings();
  const businessName = settings.businessName || process.env.BUSINESS_NAME || 'nuestro negocio';
  const text = (settings.welcomeMessage && settings.welcomeMessage.trim())
    || `Hola! Bienvenido a ${businessName}. Contame, en que te puedo ayudar hoy?`;
  await sendTextOrImage(to, text, settings.welcomeImageIds);
}

// Contexto del ultimo mensaje de cada conversacion en lo que va de la espera
// (ver scheduleReply): se pisa con cada mensaje nuevo del cliente, asi que
// cuando se cumple la espera se contesta usando el mas reciente (los
// anteriores ya quedaron guardados en el historial por appendMessage).
const pendingContext = new Map(); // phone -> { type, rawText, lower, location }
const pendingTimers = new Map(); // phone -> timeout handle
// Todos los textos que el cliente mando mientras se esperaba (ver
// scheduleReply), en orden. A diferencia de pendingContext (que se pisa y
// solo guarda el ultimo mensaje), esto se va acumulando: hace falta para el
// gatillo de producto mas abajo, que si no revisaria SOLO el ultimo mensaje
// de la tanda y se perderia el gatillo cuando el cliente manda el nombre del
// producto en un mensaje y algo mas (ej. "Precio") en otro casi seguido,
// antes de que el bot llegue a contestar.
const pendingRawTexts = new Map(); // phone -> string[]
// Desde donde empieza el LOTE actual dentro de session.history (indice, no
// contenido): se fija en handleIncomingMessage con el largo del historial
// que habia ANTES de appendMessage del primer mensaje de este lote todavia
// no contestado. Ver processReply mas abajo: reemplaza a "tomar el ultimo
// elemento del historial como si siempre fuera del cliente" (bug real,
// punto 2 del pedido de correccion).
const pendingHistoryStart = new Map(); // phone -> number

// FASE (correccion regresion cierre secuencial, punto 1): antes, cada
// mensaje nuevo del cliente solo reiniciaba el TEMPORIZADOR (scheduleReply),
// pero nada impedia que, si processReply de la tanda anterior todavia
// segui corriendo (generando la respuesta con la IA, o mandandola de a
// partes con las pausas de sendSplit -- eso puede tardar bastante mas que
// el propio delay de espera), el temporizador de un mensaje nuevo disparara
// OTRO processReply para el MISMO numero en paralelo. Eso paso de verdad:
// dos respuestas concurrentes para la misma conversacion, leyendo/pisando
// el historial y la sesion al mismo tiempo, con resultados mezclados
// (ver el chat real reportado). Ahora se serializa el procesamiento POR
// NUMERO: mientras haya una respuesta activa para un numero, un temporizador
// que vence para ESE MISMO numero no dispara una segunda corrida en
// paralelo -- solo marca que hace falta reprocesar el lote acumulado (que
// se sigue actualizando igual, ver handleIncomingMessage) apenas la
// respuesta activa termine, sin esperar un delay nuevo completo. Numeros
// DISTINTOS nunca se bloquean entre si (cada uno tiene su propia entrada en
// estos dos Map). El bloqueo se libera SIEMPRE al terminar processReply,
// incluso si tira un error (.finally), para que una conversacion nunca
// quede "trabada" sin poder volver a contestar.
const activeProcessing = new Map(); // phone -> true mientras hay un processReply corriendo
const rerunQueued = new Map(); // phone -> true si hay que reprocesar apenas termine el actual

function runProcessReply(from) {
  if (activeProcessing.get(from)) {
    rerunQueued.set(from, true);
    return;
  }
  activeProcessing.set(from, true);
  processReply(from)
    .catch((err) => console.error('Error procesando respuesta demorada:', err))
    .finally(() => {
      activeProcessing.delete(from);
      if (rerunQueued.get(from)) {
        rerunQueued.delete(from);
        // Solo si sigue habiendo algo pendiente para este numero: pudo
        // haberse vaciado (por ejemplo, si se apago el bot mientras tanto y
        // processReply ya lo descarto sin dejar nada nuevo en pendingContext).
        if (pendingContext.has(from)) runProcessReply(from);
      }
    });
}

function scheduleReply(from) {
  const settings = getSettings();
  const delayMs = settings.replyDelayMs != null ? Number(settings.replyDelayMs) : DEFAULT_REPLY_DELAY_MS;

  const existing = pendingTimers.get(from);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingTimers.delete(from);
    runProcessReply(from);
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

  let rawText =
    type === 'text'
      ? message.text.body.trim()
      // Boton de una PLANTILLA aprobada (ej. "Ya voy a retirarlo" de la
      // plantilla de retiro): WhatsApp lo manda con este tipo distinto
      // ("button"), no "interactive" — ese es solo para los botones que arma
      // el propio bot (ver mas abajo). Sin este caso, tocar un boton de
      // plantilla quedaba con rawText vacio y el bot contestaba el generico
      // "no pude leer eso que mandaste", como si no hubiera entendido nada.
      : type === 'button' && message.button?.text
        ? message.button.text
        : type === 'interactive' && message.interactive?.button_reply
          ? message.interactive.button_reply.title
          : type === 'interactive' && message.interactive?.list_reply
            ? message.interactive.list_reply.title
          // Un sticker (la mayoria de los "gifs" que manda la gente por
          // WhatsApp en realidad viajan como sticker animado) no se puede
          // leer, pero en la practica casi siempre es la forma que tiene el
          // cliente de decir "dale/ok/si" sin escribirlo. Se le pasa a la IA
          // como un marcador fijo en vez de dejarlo vacio (eso lo mandaria al
          // "no te entiendo, escribimelo" de mas abajo): el system prompt de
          // ai.js sabe interpretar este marcador puntual.
          : type === 'sticker'
            ? '[sticker]'
            : '';

  // Nota de voz: se baja el audio de WhatsApp y se transcribe con Whisper.
  // Si algo falla (sin credito, audio raro, sin red) se sigue como si no se
  // hubiera podido escuchar, nunca se rompe la conversacion.
  let audioTranscript = '';
  let audioUrl = null;
  if (type === 'audio' && message.audio?.id) {
    try {
      const { buffer, mimeType } = await downloadMedia(message.audio.id);
      // El audio original se guarda aparte de la transcripcion (ver mas
      // abajo, appendMessage con el attachment): si esto falla, no importa,
      // seguimos igual con la transcripcion sola.
      try {
        audioUrl = saveIncomingAudio(buffer, mimeType);
      } catch (err) {
        console.warn('No se pudo guardar el audio original de la nota de voz:', err.message);
      }
      audioTranscript = await transcribeAudio(buffer, mimeType);
    } catch (err) {
      console.warn('No se pudo transcribir la nota de voz:', err.message);
    }
    if (audioTranscript) rawText = audioTranscript;
  }

  // Foto o video: se baja de WhatsApp y se guarda igual que el audio, para
  // que el negocio lo pueda ver desde el panel (antes quedaba como
  // "[image]"/"[video]" sin forma de abrirlo). Si el cliente le puso texto
  // (caption), ese texto pasa a ser el mensaje normal (rawText), como si lo
  // hubiera escrito aparte: el bot le puede contestar igual.
  let mediaUrlIn = null;
  let imageDescription = '';
  if ((type === 'image' && message.image?.id) || (type === 'video' && message.video?.id)) {
    let buffer = null;
    let mimeType = null;
    try {
      const mediaId = type === 'image' ? message.image.id : message.video.id;
      ({ buffer, mimeType } = await downloadMedia(mediaId));
      mediaUrlIn = saveIncomingMedia(buffer, mimeType, type);
    } catch (err) {
      console.warn(`No se pudo descargar el ${type} entrante:`, err.message);
    }
    // Se "lee" el contenido de la foto con vision (ver vision.js) para que
    // el bot sepa que muestra aunque el cliente no haya escrito nada (ej.
    // manda solo una captura de un pago, o una foto de su cedula, o del
    // producto). Solo fotos, no videos (el modelo no procesa video). Si
    // falla (sin credito, imagen rara, etc.) sigue igual, sin descripcion.
    if (type === 'image' && buffer) {
      try {
        imageDescription = await describeImage(buffer, mimeType);
      } catch (err) {
        console.warn('No se pudo leer el contenido de la imagen:', err.message);
      }
    }
    const caption = (type === 'image' ? message.image?.caption : message.video?.caption) || '';
    if (caption.trim()) rawText = caption.trim();
    if (type === 'image' && imageDescription) {
      rawText = rawText
        ? `${rawText}\n[Lo que se ve en la imagen que mando: ${imageDescription}]`
        : `[Mando una imagen sin texto. Lo que se ve: ${imageDescription}]`;
    }
  }

  const lower = rawText.toLowerCase();

  // Codigo de anuncio (ej. I1C1, I2C3): el negocio lo precarga en el texto
  // del link de cada anuncio para saber despues de que anuncio salio cada
  // venta y decidir cual escalar. Solo tiene sentido buscarlo en el PRIMER
  // mensaje de la conversacion (es lo que trae el link armado, no algo que
  // el cliente escriba despues por su cuenta). Si el cliente lo borro o lo
  // cambio antes de mandar el mensaje, no hay match y listo: no es un error,
  // simplemente esa conversacion queda sin codigo.
  if (session.history.length === 0 && !session.adCode && rawText) {
    const codeMatch = rawText.trim().match(/^([A-Za-z]\d[A-Za-z]\d)(?=\s|$)/);
    if (codeMatch) updateSession(from, { adCode: codeMatch[1].toUpperCase() });
  }

  // El mensaje entrante se guarda SIEMPRE, aunque el bot este apagado o
  // pausado en esta conversacion: el panel tiene que ver la conversacion
  // completa para que alguien pueda tomarla a mano.
  if (type === 'audio') {
    const attachment = audioUrl ? { kind: 'audio', url: audioUrl } : undefined;
    appendMessage(
      from,
      'user',
      audioTranscript ? `🎤 ${audioTranscript}` : '[Nota de voz, no se pudo transcribir]',
      attachment ? { attachment } : undefined
    );
  } else if (type === 'image' || type === 'video') {
    const attachment = mediaUrlIn ? { kind: type, url: mediaUrlIn } : undefined;
    const label = type === 'video' ? '[video]' : '[imagen]';
    appendMessage(from, 'user', rawText || label, attachment ? { attachment } : undefined);
  } else if (rawText) {
    appendMessage(from, 'user', rawText);
  } else if (type === 'location') {
    appendMessage(from, 'user', '[Comparti su ubicacion GPS]');
  } else {
    appendMessage(from, 'user', `[${type || 'mensaje'}]`);
  }

  // OJO: antes, cuando llegaba cualquier mensaje nuevo del cliente, se
  // borraban remarketingSentAt2h/5h para que el ciclo de 2h/5h pudiera
  // volver a dispararse si la conversacion se colgaba de nuevo mas
  // adelante. En la practica eso hacia que una conversacion larga, con el
  // cliente contestando de a ratos (un "ok", un sticker, una pregunta
  // suelta) a lo largo de varios dias, terminara recibiendo el recordatorio
  // de remarketing UNA Y OTRA VEZ, ciclo tras ciclo (se detecto con datos
  // reales: hasta 5 mensajes de remarketing en una misma conversacion),
  // algo que WhatsApp puede tomar como spam y terminar bloqueando el
  // numero del negocio. Ahora cada paso (2h y 5h) se manda COMO MUCHO UNA
  // VEZ en toda la vida de la conversacion: el flag ya no se resetea aca.
  // Si el cliente arranca una conversacion realmente nueva mas adelante
  // (escribe "menu"/"inicio"/"reiniciar", ver resetSession en state.js),
  // ahi si vuelve a tener su propio ciclo de remarketing de cero.

  // Switch maestro (Configuracion, apaga TODO el bot) o pausa de esta
  // conversacion puntual (panel, boton "Bot activo" del chat): en cualquiera
  // de los dos casos un humano esta atendiendo, asi que no se contesta solo.
  if (!getSettings().botEnabled) return;
  if (session.paused) return;

  // FASE (correccion regresion cierre secuencial, punto 2): se guarda aca el
  // largo del historial ANTES de este mensaje (y de cualquier otro de este
  // mismo lote) -- pero solo la PRIMERA vez que arranca un lote nuevo
  // (pendingContext todavia vacio para este numero). "session" es el
  // snapshot que se leyo al principio de esta funcion, antes de los
  // appendMessage de mas arriba, asi que session.history.length es
  // exactamente el limite real de "todo lo de ANTES de este lote". Ver
  // processReply mas abajo: de aca sale el userText/history reales, en vez
  // de asumir que el ultimo elemento del historial siempre es del cliente
  // (bug real: con respuestas fragmentadas, ese ultimo elemento podia ser
  // una burbuja del propio bot).
  if (!pendingContext.has(from)) {
    pendingHistoryStart.set(from, session.history.length);
  }

  pendingContext.set(from, {
    type,
    rawText,
    lower,
    location: type === 'location' ? message.location : null,
  });

  if (rawText) {
    const list = pendingRawTexts.get(from) || [];
    list.push(rawText);
    pendingRawTexts.set(from, list);
  }

  scheduleReply(from);
}

// Se ejecuta cuando el cliente se quedo callado el tiempo configurado
// (Configuracion, por defecto 8 segundos) despues de su ultimo mensaje.
async function processReply(from) {
  const ctx = pendingContext.get(from);
  pendingContext.delete(from);
  if (!ctx) return;

  const batchTexts = pendingRawTexts.get(from) || [];
  pendingRawTexts.delete(from);
  const historyStart = pendingHistoryStart.get(from) ?? 0;
  pendingHistoryStart.delete(from);

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

  // Un "reaction" es solo el emoji que el cliente le pone a un mensaje
  // anterior (like, corazon, etc.), no un mensaje en si. Antes esto caia en
  // el fallback de abajo y el bot contestaba "solo puedo leer mensajes de
  // texto o ubicacion", una respuesta sin sentido para una reaccion que
  // encima confundia al cliente y quedaba la charla dando vueltas en
  // redondo (el cliente respondia algo tipo "si" a eso, y el bot volvia a
  // preguntar lo mismo de antes). Una reaccion no necesita respuesta: se
  // ignora sin contestar nada.
  if (type === 'reaction') {
    return;
  }

  if (!rawText) {
    const reply = 'No pude leer bien eso que mandaste. Me lo podes escribir o mandar de nuevo, porfa?';
    await sendReply(from, reply);
    return;
  }

  // Gatillo de producto: solo la primera vez que se detecta en la
  // conversacion (no cada vez que menciona la palabra de nuevo), y solo si
  // el producto tiene mensaje inicial cargado. Sale tal cual, sin pasar por
  // la IA: es la presentacion que el negocio escribio a mano.
  if (!session.linkedProductId) {
    // OJO: se chequea contra TODOS los mensajes de esta tanda (batchTexts),
    // no solo el ultimo (rawText). Si el cliente manda "quiero info del
    // shilajit" y enseguida, antes de que el bot conteste, otro mensaje como
    // "precio", el gatillo tiene que seguir disparando con el primero.
    const product = matchTrigger(batchTexts.length ? batchTexts.join(' ') : rawText);
    if (product && product.intro && product.intro.trim()) {
      updateSession(from, { linkedProductId: product.id });
      const introRaw = product.intro.trim();
      // FASE (correccion cobertura -- verificacion de TODOS los caminos de
      // envio, no solo las respuestas de la IA): este mensaje inicial es
      // texto fijo que escribio el negocio a mano y sale SIN pasar por la
      // IA, pero si por error mencionara domicilio sin cobertura confirmada
      // (o antes de saber la ciudad de este cliente puntual), tiene que
      // corregirse igual que cualquier respuesta del modelo -- misma fuente
      // de verdad (guardAgainstUnauthorizedDelivery), no una version aparte.
      const intro = guardAgainstUnauthorizedDelivery(
        introRaw,
        session.card?.ciudad || null,
        batchTexts.length ? batchTexts.join(' ') : rawText
      );
      await sendTextOrImage(from, intro, product.introImageIds);
      return;
    }
  }

  try {
    // FASE (correccion regresion cierre secuencial, punto 2): antes se
    // asumia que el ULTIMO elemento del historial siempre era del cliente
    // (fullHistory.slice(-1)) -- bug real: con respuestas fragmentadas (o
    // dos processReply superpuestos, ver punto 1), ese ultimo elemento podia
    // ser una burbuja del propio bot, y userText terminaba siendo texto del
    // bot en vez de lo que escribio el cliente. Ahora "el lote actual" se
    // arma con lo que efectivamente llego en ESTE batch (batchTexts, ya
    // acumulado en orden por handleIncomingMessage) y "history" es todo lo
    // que habia ANTES de que arrancara ese lote (historyStart, el indice
    // guardado en handleIncomingMessage antes de appendMessage del primer
    // mensaje de este lote) -- nunca se infiere de la posicion del ultimo
    // elemento.
    const fullHistory = [...(getSession(from).history || [])].map((m) => ({ role: m.role, content: m.content }));
    const history = fullHistory.slice(0, historyStart);
    const userText = batchTexts.length ? batchTexts.join('\n') : rawText;
    const explicitNewOrder = /\b(otro|nuevo|segunda)\s+pedido\b|\bquiero\s+pedir\s+de\s+nuevo\b/i.test(userText);
    const startsFreshOrder = session.newOrderPending === true ||
      (explicitNewOrder && (session.orderClosed === true || SOLD_STAGES.includes(session.stage)));
    const productRecord = !explicitNewOrder && session.linkedProductId ? findProduct(session.linkedProductId) : null;
    const knownProduct = productRecord?.name || null;
    const memoryUpdate = applyOrderMessage({
      currentOrder: startsFreshOrder ? null : session.currentOrder,
      text: userText,
      precedingAssistantText: session.lastAssistantText,
      knownCustomer: session.card || {},
    });
    if (!memoryUpdate.order.product && (knownProduct || (!startsFreshOrder && session.card?.producto))) {
      memoryUpdate.order.product = knownProduct || session.card.product;
    }
    const cardAfterMemory = { ...(session.card || {}), ...memoryUpdate.identity };
    if (memoryUpdate.order.city) cardAfterMemory.ciudad = memoryUpdate.order.city;
    if (startsFreshOrder || (session.currentOrder?.city && memoryUpdate.order.city !== session.currentOrder.city)) {
      cardAfterMemory.agenciaConfirmadaEnChat = null;
    }
    const memoryPatch = { currentOrder: memoryUpdate.order, card: cardAfterMemory, newOrderPending: false };
    if (startsFreshOrder) {
      const previousOrders = [...(session.orderHistory || [])];
      if (session.orderClosed === true || SOLD_STAGES.includes(session.stage)) {
        previousOrders.push({
          closedAt: session.soldAt || session.updatedAt || null,
          stage: session.stage || null,
          order: session.currentOrder || null,
          card: {
            producto: session.card?.producto || null,
            guia: session.card?.guia || null,
            agencia: session.card?.agencia || session.card?.agenciaConfirmadaEnChat || null,
            monto: session.card?.monto ?? null,
          },
        });
      }
      memoryPatch.orderHistory = previousOrders;
      memoryPatch.orderClosed = false;
      memoryPatch.orderDataRequested = false;
      memoryPatch.soldAt = null;
      if (!session.stageLocked) {
        memoryPatch.stage = 'interesado';
        memoryPatch.stageReason = 'Pedido nuevo iniciado por el cliente';
      }
    }
    updateSession(from, memoryPatch);
    session.currentOrder = memoryUpdate.order;
    session.card = cardAfterMemory;
    if (startsFreshOrder) {
      session.orderClosed = false;
      session.orderDataRequested = false;
      session.soldAt = null;
      if (!session.stageLocked) session.stage = 'interesado';
    }
    const knownCity = memoryUpdate.order.city || (!startsFreshOrder ? session.card?.ciudad : null) || null;
    // OJO: antes esto se sacaba SOLO de session.stage (puesto por el
    // clasificador por IA, que corre aparte y despues de mandar la
    // respuesta). En la practica eso resulto poco confiable: hubo
    // conversaciones donde el pedido ya estaba cerrado (se mando el mensaje
    // de cierre) pero el clasificador nunca marco la etapa como "vendido",
    // asi que el bot seguia agregando la pregunta de venta de siempre. Por
    // eso se sumo un flag propio (session.orderClosed) que se prende mas
    // abajo, en el momento exacto en que el BOT genera el mensaje de cierre
    // (deteccion directa del texto, sin depender de otra IA aparte).
    // Pero ese flag SOLO se prende si el cierre lo detecto el bot mismo: un
    // pedido marcado "vendido" (o cualquier etapa de SOLD_STAGES) a mano
    // desde el panel -por ejemplo una venta cargada manualmente, o una
    // conversacion vieja de antes de este flag- nunca prende orderClosed, y
    // el bot seguia preguntando cosas como "avisame cuando estes listo para
    // hacer el pedido" a un cliente que ya habia comprado (bug real
    // reportado por el negocio). Por eso ahora se toman las DOS señales: el
    // flag de deteccion de texto, O la etapa real que ya tiene el pedido en
    // el panel.
    const orderClosed = startsFreshOrder ? false : (session.orderClosed === true || SOLD_STAGES.includes(session.stage));
    // Mismo criterio que orderClosed, pero para el bloque de "pedime tu
    // nombre, cedula y telefono": se detecto que a veces el modelo lo manda
    // dos veces en la misma conversacion (por ejemplo si el cliente contesta
    // con un sticker o un mensaje corto en vez de los datos, o simplemente se
    // confunde), a pesar de que el prompt le pide pedirlo una sola vez. Este
    // flag se prende mas abajo, en el momento exacto en que el BOT manda ese
    // bloque por primera vez (deteccion directa del texto), y se usa tanto
    // para avisarle al modelo (dentro del prompt) como para, si igual lo
    // repite, sacarle el bloque duplicado antes de mandarlo (ver mas abajo).
    const dataAlreadyRequested = session.orderDataRequested === true;
    // Etapa real del pedido (automatica del clasificador, o fijada a mano
    // desde el panel: ver setStage en state.js) para que el bot sepa QUE
    // puede decir sobre el envio (ver SHIPPING_STAGE_TEXT en ai.js). Bug real
    // que esto arregla: el bot le dijo a un cliente que su pedido ya habia
    // llegado, cuando en realidad se habia armado hacia apenas 2 horas y la
    // etapa en el panel ni siquiera era "entregado". El tiempo transcurrido
    // nunca alcanza para asumir eso; ahora la unica fuente es esta etapa.
    const shippingStage = session.stage || null;
    // Nombre/cedula/telefono ya confirmados por el cliente (ver ai.js): se
    // pasan aparte del historial, igual que knownCity, para que sigan
    // valiendo aunque esos mensajes ya hayan quedado afuera de la ventana de
    // historial reciente que ve el modelo, o aunque se reabra el pedido para
    // cambiar algo. Bug real que esto arregla: un cliente ya habia dado sus
    // tres datos, cambio la cantidad de su pedido varios mensajes despues, y
    // el bot se los volvio a pedir enteros como si nunca los hubiera tenido.
    const knownCustomer = {
      nombre: session.card?.nombre || null,
      cedula: session.card?.cedula || null,
      telefono: session.card?.telefono || null,
    };
    const { text: reply, images } = await getAssistantReply(history, userText, knownCity, knownProduct, orderClosed, dataAlreadyRequested, shippingStage, knownCustomer, memoryUpdate.order);

    // Red de seguridad de codigo, ademas del aviso en el prompt: si ya se
    // habia pedido nombre/cedula/telefono antes y el modelo igual intento
    // mandar ese bloque de nuevo, lo sacamos y mandamos solo un recordatorio
    // corto en su lugar (o el resto del mensaje, si tenia algo mas aparte del
    // bloque repetido).
    let finalReply = reply;
    const missingIdentity = [
      !knownCustomer.nombre && 'nombre y apellido',
      !knownCustomer.cedula && 'cedula',
      !knownCustomer.telefono && 'telefono',
    ].filter(Boolean);
    if (missingIdentity.length > 0 && missingIdentity.length < 3 && looksLikeEmptyDataRequest(reply)) {
      const withoutFullRequest = stripDuplicateDataRequest(reply, {
        nombre: knownCustomer.nombre || 'ya recibido',
        cedula: knownCustomer.cedula || '0000000',
        telefono: knownCustomer.telefono || '04120000000',
      });
      const requestOnlyMissing = `Solo me falta ${missingIdentity.join(' y ')} para completar tus datos.`;
      finalReply = withoutFullRequest ? `${withoutFullRequest}\n\n${requestOnlyMissing}` : requestOnlyMissing;
    }
    // Ver mentionsDataFieldsAsRequest en ai.js: ademas del formato de
    // plantilla (looksLikeEmptyDataRequest), esto tambien detecta cuando el
    // modelo repite el mismo pedido de datos pero en prosa propia, sin dos
    // puntos ni salto de linea (bug real: paso 5 horas despues de que el
    // cliente ya habia dado y confirmado sus datos, y el modelo se los pidio
    // de nuevo con otras palabras que no matcheaban el regex original).
    if (dataAlreadyRequested && (looksLikeEmptyDataRequest(finalReply) || mentionsDataFieldsAsRequest(finalReply, knownCustomer))) {
      const stripped = stripDuplicateDataRequest(finalReply, knownCustomer);
      finalReply = stripped === null ? DATA_REQUEST_REMINDER : stripped;
    }

    // Ver stripPostCloseQuestion en ai.js: con el pedido ya cerrado (turnos
    // POSTERIORES al mensaje de cierre, no el de cierre en si: por eso se usa
    // orderClosed, el flag de sesion de ANTES de este turno, no isNewClose de
    // mas abajo), el bot nunca tiene que volver a terminar su respuesta con
    // una pregunta de venta (ofrecer otra presentacion, preguntar si le
    // interesa algo, etc), aunque el prompt se lo pida explicitamente: eso ya
    // paso de verdad (cliente con pedido cerrado pregunto "que mas ofrecen" y
    // el bot, despues de contestar bien, igual cerro con "¿Te interesa
    // alguna de estas presentaciones?" como si siguiera vendiendo).
    if (orderClosed) {
      const strippedClose = stripPostCloseQuestion(finalReply);
      finalReply = strippedClose === null ? POST_CLOSE_REMINDER : strippedClose;
    }

    // FASE (correccion validacion-cierre v3, punto 5): la version anterior
    // usaba una ventana FIJA de los ultimos 6 mensajes del cliente para
    // decidir si un cierre era real. Eso tenia un problema real en las dos
    // direcciones: (a) en una conversacion mas larga, un dato real del
    // pedido actual (la cantidad, la ciudad) dicho hace mas de 6 mensajes se
    // "perdia" solo y el cierre valido no se reconocia (falso negativo
    // silencioso, que el negocio dijo explicitamente que no acepta como
    // solucion); y (b) si simplemente se agrandara la ventana a lo bruto, un
    // pedido NUEVO podria heredar la cantidad o la aceptacion de una compra
    // YA CERRADA anterior en la misma conversacion (reutilizar datos de una
    // compra vieja para "inflar" una nueva, el error contrario).
    //
    // La solucion: en vez de un numero fijo de mensajes, se busca el ULTIMO
    // mensaje del bot que funciona como resumen de cierre de una compra
    // anterior (ver looksLikeClosingSummaryText en ai.js) y se toma TODO lo
    // que el cliente escribio DESPUES de ese punto -- sin tope arbitrario de
    // mensajes, pero nunca cruzando para atras del cierre anterior. Si
    // todavia no hubo ningun cierre en esta conversacion, se toma desde el
    // principio (es la primera compra, no hay nada que excluir).
    // FASE (correccion regresion cierre secuencial, punto 5): la version
    // anterior buscaba el corte por ESTILO de texto (looksLikeClosingSummaryText
    // sobre el historial), lo que tiene el mismo problema de fondo que el
    // punto 6 de abajo: una explicacion normal de pago/envio puede "sonar" a
    // cierre sin serlo, y activaba el corte sin que hubiera una venta
    // realmente registrada -- descartando de punta datos reales del pedido
    // actual (identidad, cantidad, agencia ya dados) que quedaban ANTES de
    // esa explicacion. Ahora el corte se ancla a un cierre REALMENTE
    // persistido: session.lastOrderCloseHistoryIndex, el indice que se
    // guarda mas abajo en el momento exacto en que isNewClose detecta un
    // cierre real (no una heuristica de texto). Se mantiene el heuristico
    // viejo SOLO como respaldo para sesiones de ANTES de que existiera este
    // indice (compatibilidad: session.orderClosed ya en true pero sin el
    // indice todavia guardado).
    let cierreAnteriorIdx = -1;
    if (typeof session.lastOrderCloseHistoryIndex === 'number') {
      cierreAnteriorIdx = session.lastOrderCloseHistoryIndex;
    } else if (session.orderClosed) {
      for (let i = fullHistory.length - 1; i >= 0; i--) {
        const m = fullHistory[i];
        if (m.role === 'assistant' && looksLikeClosingSummaryText(m.content)) {
          cierreAnteriorIdx = i;
          break;
        }
      }
    }
    const segmentoPedidoActual = fullHistory.slice(cierreAnteriorIdx + 1);
    const recentUserText = segmentoPedidoActual
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join(' ');
    const closingCtx = {
      knownCustomer,
      recentUserText,
      // El producto puede venir del catalogo (gatillo de intro, linkedProductId)
      // O de la ficha (el clasificador lo detecto en la charla libre, sin que
      // haya un gatillo de producto formal): cualquiera de los dos cuenta
      // como "producto identificado" para la validacion de cierre.
      knownProduct: knownProduct || memoryUpdate.order.product || (!startsFreshOrder ? session.card?.producto : null) || null,
      knownCity,
      // agenciaConfirmadaEnChat es la persistencia de una confirmacion de
      // agencia dada EN LA CONVERSACION (ver el bloque que arma "patch" mas
      // abajo): distinta de card.agencia, que solo la carga el operador
      // desde el panel al confirmar la guia real (ver orderGuard.js). Sin
      // esto, una confirmacion como "Si" a "esta agencia te queda bien?"
      // solo cuenta en el turno exacto en que paso; unos turnos despues (dar
      // nombre/cedula/telefono, preguntar el plazo) dejaria de verse.
      cardAgencia: memoryUpdate.order.agency || (!startsFreshOrder ? (session.card?.agenciaConfirmadaEnChat || session.card?.agencia) : null) || null,
      // Para reconocer una aceptacion corta ("si"/"dale") como valida SOLO
      // cuando responde de verdad a una pregunta de confirmacion del bot
      // (ver looksLikeContextualShortAcceptance en ai.js): lastAssistantText
      // es el mensaje que el bot mando ANTES de este turno (el que el
      // cliente esta contestando ahora con userText).
      lastAssistantText: session.lastAssistantText || null,
      lastUserMessage: userText,
      knownQuantity: memoryUpdate.order.quantity,
      orderModality: memoryUpdate.order.modality,
      orderCourier: memoryUpdate.order.courier,
      expectedTotal: productRecord && memoryUpdate.order.quantity
        ? Number(productRecord.price) * Number(memoryUpdate.order.quantity)
        : null,
    };

    // FASE (correccion validacion-cierre v3, punto 6): si el propio texto
    // del modelo YA suena a un cierre de pedido (resumen + pago + entrega,
    // ver looksLikeClosingSummaryText) pero la validacion estructural de
    // arriba dice que en realidad todavia falta algo real, NUNCA se le
    // manda ese texto al cliente tal cual: quedaria diciendole "confirmado"
    // mientras el sistema NO lo guarda como pedido cerrado, una
    // inconsistencia bot-dice-cerrado / sistema-sigue-abierto que el
    // negocio pidio explicitamente evitar. Se reemplaza por un aviso
    // honesto de que falta confirmar tal o cual dato, ANTES de mandarlo
    // (esta red de seguridad no sirve de nada si corre despues del envio).
    if (!orderClosed && looksLikeClosingSummaryText(finalReply)) {
      const completeness = evaluateOrderCompleteness({ ...closingCtx, text: finalReply });
      if (!completeness.complete) {
        finalReply = buildIncompleteOrderNotice(completeness.missing);
      }
    }

    // Ver NOT_ARRIVED_CLAIM_RE arriba: ultima red de seguridad antes de
    // mandar, para que un pedido que ya llego (o ya se entrego) nunca salga
    // diciendo que todavia falta que llegue. OJO: se vuelve a leer la etapa
    // FRESCA aca (no la que se capturo como shippingStage al arrancar este
    // turno, varios segundos/una llamada a la IA atras): la etapa pudo haber
    // cambiado MIENTRAS se generaba esta respuesta (por ejemplo, alguien en
    // el panel acaba de marcar la llegada, o de cargar la guia y avanzar el
    // pedido), y el estado logistico vigente en el momento de MANDAR el
    // mensaje es el que tiene que prevalecer, no el que habia al empezar.
    const stageAtSendTime = getSession(from).stage || null;
    if (['esperando_retiro', 'entregado'].includes(stageAtSendTime) && looksLikeSaysNotArrivedYet(finalReply)) {
      finalReply = ALREADY_ARRIVED_CORRECTION;
    }

    // FASE (correccion regresion cierre secuencial, punto 9): isNewClose se
    // calcula ACA, con finalReply (despues de TODAS las correcciones de
    // arriba: datos duplicados, pregunta post-cierre, aviso de incompleto,
    // correccion de "todavia no llego"), nunca con el texto original "reply"
    // que salio de la IA. Bug real que esto arregla: si "reply" sonaba a un
    // cierre pero la validacion de completitud lo bajaba a un aviso de
    // "todavia falta confirmar tal cosa" (el bloque de arriba), antes igual
    // se podia marcar el pedido como cerrado/vendido usando el texto
    // ORIGINAL, aunque al cliente en definitiva le llego el aviso de
    // incompleto -- una contradiccion entre lo que de verdad se mando y lo
    // que quedo guardado.
    const isNewClose = !orderClosed && isClosingMessage(finalReply, closingCtx);

    if (images.length) await sendConversationImages(from, images);
    await sendReply(from, finalReply);

    // Ver PENDING_AGENCY_PROMISE_RE arriba: si el bot acaba de prometer
    // buscar la agencia "en un momento" sin haberla mandado ya, se la
    // mandamos nosotros mismos (sin pasar por el modelo) para no dejar la
    // promesa sin cumplir. Preferimos knownCity (la ficha ya guardada del
    // cliente, actualizada por el clasificador), pero esa ficha se actualiza
    // DESPUES de mandar la respuesta, asi que en el PRIMER mensaje donde el
    // cliente recien dice su ciudad, knownCity todavia esta vacio: para no
    // dejar la promesa sin cumplir justo en ese primer mensaje (paso de
    // verdad), si no hay knownCity probamos reconocer la ciudad directo del
    // ultimo mensaje del cliente.
    const ciudadParaFollowUp = knownCity || findKnownCityKey(userText);
    if (ciudadParaFollowUp && looksLikePendingAgencyPromise(finalReply)) {
      const followUp = buildDirectAgencyMessage(ciudadParaFollowUp);
      if (followUp) {
        await sleep(randomGap());
        await sendReply(from, followUp);
      }
    }

    // Ver PENDING_FORM_PROMISE_RE arriba: si el bot acaba de prometer un
    // "formulario" o "enlace" para los datos del pedido sin haber mandado ya
    // el pedido de datos real, se lo mandamos nosotros mismos, salvo que ya
    // se lo hayamos pedido antes en esta conversacion (dataAlreadyRequested)
    // — en ese caso no hace falta insistir de nuevo.
    let formFollowUpSent = false;
    if (!dataAlreadyRequested && looksLikePendingFormPromise(finalReply)) {
      await sleep(randomGap());
      // getDataRequestTemplate() es configurable desde el panel
      // (Configuracion > "Texto para pedir los datos del pedido"): el
      // default es seguro (menciona Tealca, no domicilio), pero si el
      // negocio la edita y menciona domicilio sin cobertura confirmada,
      // tiene que corregirse igual que cualquier otro camino de envio.
      await sendReply(from, guardAgainstUnauthorizedDelivery(getDataRequestTemplate(), knownCity, userText));
      formFollowUpSent = true;
    }

    const patch = { lastAssistantText: finalReply };
    if (!dataAlreadyRequested && (looksLikeEmptyDataRequest(reply) || formFollowUpSent)) {
      patch.orderDataRequested = true;
    }
    // FASE (correccion cobertura/agencia, punto 3 de la ronda de
    // verificacion): si el cliente confirma AHORA una agencia puntual
    // (looksLikeAgencyConfirmation, con el mensaje del bot y el mensaje del
    // cliente de ESTE turno), esa confirmacion se guarda para los turnos
    // siguientes. Sin esto, evaluateOrderCompleteness solo la ve en el
    // turno exacto en que paso (via lastAssistantText/lastUserMessage de
    // ESTE turno nada mas): unos turnos despues (dar nombre/cedula/
    // telefono, preguntar el plazo de entrega) volveria a pedir la agencia
    // de nuevo aunque el cliente ya la haya confirmado. Se guarda en un
    // campo PROPIO (card.agenciaConfirmadaEnChat), separado de
    // card.agencia -- ese es el campo que usa shipping.js para el mensaje
    // REAL de envio cuando el operador carga la guia desde el panel (mucho
    // despues, ver orderGuard.js): no se toca aca, para no contaminar ese
    // mensaje con el texto crudo de esta confirmacion conversacional.
    if (
      !session.card?.agencia &&
      !session.card?.agenciaConfirmadaEnChat &&
      looksLikeAgencyConfirmation(closingCtx.lastAssistantText, closingCtx.lastUserMessage)
    ) {
      const agenciaLabel = extractConfirmedAgencyLabel(closingCtx.lastAssistantText);
      if (agenciaLabel) {
        patch.card = { ...(session.card || {}), agenciaConfirmadaEnChat: agenciaLabel };
        patch.currentOrder = { ...(session.currentOrder || {}), agency: agenciaLabel, modality: 'agency_pickup' };
      }
    }
    if (isNewClose) {
      patch.orderClosed = true;
      patch.currentOrder = { ...(patch.currentOrder || session.currentOrder || {}), closed: true };
      // Ver punto 5 mas arriba (segmentoPedidoActual): este es el indice
      // REAL que las conversaciones futuras van a usar como limite del
      // pedido cerrado, en vez de tener que adivinarlo de nuevo por estilo
      // de texto. fullHistory.length es el largo del historial ANTES de que
      // se le agregue el mensaje de cierre que se esta por mandar ahora
      // (fullHistory es una copia local, no se ve afectada por los
      // appendMessage de sendReply que vienen despues en esta misma
      // funcion), asi que coincide exactamente con el indice que va a tener
      // ese mensaje de cierre una vez guardado.
      patch.lastOrderCloseHistoryIndex = fullHistory.length;
      // El cierre del pedido ES la venta: la marcamos como "vendido" en el
      // mismo momento deterministico en que se detecta el cierre (arriba),
      // en vez de esperar al clasificador por IA de mas abajo. En la
      // practica el clasificador casi nunca terminaba marcando "vendido"
      // textual: como el propio mensaje de cierre ya habla de guia/agencia,
      // saltaba directo a "esperando_retiro" (a veces hasta "entregado" sin
      // que el cliente hubiera confirmado nada), asi que ni la notificacion
      // push de venta nueva ni las metricas de conversion se disparaban
      // nunca con una venta real. No tocamos la etapa si un humano la fijo a
      // mano desde el panel (stageLocked), ni si ya esta en una etapa
      // posterior (SOLD_STAGES): no tiene sentido "retroceder" el pedido.
      if (!session.stageLocked && !SOLD_STAGES.includes(session.stage)) {
        patch.stage = 'vendido';
        patch.stageReason = 'Pedido cerrado (deteccion automatica)';
      }
      // Se guarda la fecha real de la venta (separada de updatedAt, que se
      // pisa con cualquier mensaje posterior) para que las metricas puedan
      // segmentar por dia cuando se cerro el pedido, no cuando fue el ultimo
      // mensaje de la conversacion.
      if (!session.soldAt) patch.soldAt = new Date().toISOString();
    }
    updateSession(from, patch);
    if (isNewClose && !session.stageLocked && !SOLD_STAGES.includes(session.stage)) {
      push.notifySale(from, getSession(from));
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
    // La respuesta al cliente ya fallo y ya se le aviso: no tiene sentido
    // seguir a la clasificacion de abajo (usaria variables de una respuesta
    // que nunca se genero). Se corta aca.
    return;
  }

  // FASE (correccion regresion cierre secuencial, punto 8): este bloque
  // corre en su PROPIO try/catch, separado del de arriba a proposito. Bug
  // real que esto arregla: la respuesta al cliente ya se genero y se mando
  // BIEN (el bloque de arriba ya termino sin error), pero si algo de ESTE
  // bloque (la clasificacion por IA, o el guardado de la ficha/etapa que
  // sigue) tiraba una excepcion, quedaba adentro del MISMO try/catch de
  // arriba, y el catch de arriba le mandaba al cliente "tuve un problema,
  // repetime eso" -- un mensaje confuso, pidiendole que repita una pregunta
  // que en realidad YA se le habia contestado bien segundos antes. Ahora un
  // fallo aca solo se registra: la etapa/ficha simplemente no se actualiza
  // este turno, sin tocar para nada la respuesta que el cliente ya recibio.
  try {
    // Clasificacion de etapa + ficha del cliente. Corre despues de mandar la
    // respuesta para no sumarle latencia. Si falla, no rompe nada: la
    // etapa/ficha simplemente no se actualiza este turno. Si la etapa esta
    // fijada a mano desde el panel, no se toca.
    const current = getSession(from);
    if (!current.stageLocked) {
      const classification = await classifyConversation(current.history.map((m) => ({ role: m.role, content: m.content })));
      if (classification) {
        // OJO: nunca reemplazar la ficha entera por lo que devuelve el
        // clasificador. Este clasificador relee TODA la conversacion cada
        // vez y a veces, en un turno puntual (por ejemplo si el cliente mete
        // un mensaje fuera de tema), no vuelve a detectar un dato que ya
        // habia dado antes (ciudad, nombre, etc) — si se pisara la ficha
        // entera, ese dato ya confirmado se borraria solo, y el bot volveria
        // a preguntarlo como si nunca lo hubiera sabido (esto paso de
        // verdad: un cliente ya habia dado su ciudad y el bot se la volvio a
        // pedir varias veces mas adelante en la misma conversacion). Ademas,
        // la ficha tambien guarda campos que este clasificador ni conoce
        // (guia, agencia, monto, foto de la guia...) cargados desde otro
        // lado (panel, seguimiento diario): reemplazarla entera tambien
        // borraria esos. Por eso se fusiona: solo se pisa un campo si esta
        // vuelta el clasificador SI trajo un valor para el; si vino vacio,
        // se conserva lo que ya habia.
        const mergedCard = { ...(current.card || {}) };
        for (const [key, value] of Object.entries(classification.card || {})) {
          if (value !== null && value !== undefined && String(value).trim() !== '') {
            if (key === 'ciudad' && current.currentOrder?.city) continue;
            mergedCard[key] = value;
          }
        }
        const classPatch = { card: mergedCard };
        // Ver isAllowedAutoTransition en stageRules.js: el clasificador
        // relee TODA la conversacion en cada turno, asi que un mensaje
        // informal suelto (un "gracias", un sticker, charla que no tiene
        // nada que ver con el pedido) puede hacerle "perder de vista" un
        // avance logistico que ya estaba confirmado por una fuente mas
        // fuerte (guia cargada, marcado manual desde el panel, un turno
        // anterior del propio clasificador) y proponer retroceder la etapa,
        // o hasta "desvenderla" a una etapa puramente conversacional. Eso ya
        // paso de verdad. Ahora esa reclasificacion NUNCA se aplica si
        // implicaria retroceder un rango logistico ya alcanzado; "devolucion"
        // es la unica excepcion (ver esa funcion), porque es evidencia nueva
        // legitima sin importar en que etapa logistica estaba el pedido.
        const classifierWouldSell = SOLD_STAGES.includes(classification.stage) && !SOLD_STAGES.includes(current.stage);
        const stageChangeAllowed = isAllowedAutoTransition(current.stage, classification.stage) &&
          (!classifierWouldSell || current.orderClosed === true);
        if (stageChangeAllowed) {
          classPatch.stage = classification.stage;
          classPatch.stageReason = classification.razon || null;
          // Mismo motivo que en el cierre deterministico de mas arriba: el
          // clasificador por IA es OTRO camino por el que una conversacion
          // puede pasar a una etapa de SOLD_STAGES (vendido, esperando_retiro,
          // en_camino, entregado) directamente, sin pasar nunca por el bloque
          // de isNewClose de arriba (de hecho, en la practica, la mayoria de
          // las ventas se detectan ACA, no ahi: el clasificador suele saltar
          // directo a "esperando_retiro" en vez de marcar "vendido" primero).
          // Sin esto, soldAt quedaba sin guardar para casi todas las ventas
          // reales, y las metricas por rango de fechas (Metricas > por dia)
          // las mostraba como "sin fecha" en vez de contarlas el dia que
          // pasaron de verdad.
          if (SOLD_STAGES.includes(classification.stage) && !current.soldAt) {
            classPatch.soldAt = new Date().toISOString();
          }
        }
        const updated = updateSession(from, classPatch);
        if (stageChangeAllowed && classification.stage === 'vendido' && current.stage !== 'vendido') {
          push.notifySale(from, updated);
        }
      }
    }
  } catch (err) {
    // OJO: este catch NUNCA le manda nada al cliente ni toca la respuesta ya
    // enviada arriba -- ver el comentario de mas arriba (punto 8). Solo se
    // registra para diagnostico; la etapa/ficha de este turno queda sin
    // actualizar, nada mas.
    console.error('Error clasificando la conversacion despues de responder (no afecta la respuesta ya enviada al cliente):', err.message);
  }
}

module.exports = {
  handleIncomingMessage,
  sendSplit,
  sendRawReply,
  sendGreeting,
  mediaUrl,
  SOLD_STAGES,
  // Exportados para que el simulador (simulator.js) pueda replicar la MISMA
  // red de seguridad de la promesa de agencia incumplida que corre en las
  // conversaciones reales (ver processReply mas arriba): sin esto, el
  // simulador no reproducia ese comportamiento y daba una falsa sensacion de
  // que el bot se quedaba "colgado" sin responder, cuando en produccion si
  // se manda el mensaje de seguimiento.
  looksLikePendingAgencyPromise,
  looksLikePendingFormPromise,
  looksLikeSaysNotArrivedYet,
  ALREADY_ARRIVED_CORRECTION,
};

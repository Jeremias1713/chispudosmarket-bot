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
  looksLikeEmptyDataRequest,
  stripDuplicateDataRequest,
  DATA_REQUEST_REMINDER,
  buildDirectAgencyMessage,
} = require('./ai');
const { classifyConversation } = require('./classifier');
const { matchTrigger, findProduct } = require('./catalog');
const { getImage, MEDIA_DIR } = require('./library');
const { getSettings } = require('./settings');
const { generateSpeech, deleteSpeech } = require('./tts');
const push = require('./push');

const SPLIT_GAP_MIN_MS = parseInt(process.env.SPLIT_GAP_MIN_MS || '6000', 10);
const SPLIT_GAP_MAX_MS = parseInt(process.env.SPLIT_GAP_MAX_MS || '9500', 10);
const DEFAULT_REPLY_DELAY_MS = 8000;
// Render define RENDER_EXTERNAL_URL solo automaticamente; PUBLIC_URL es el
// override manual por si se corre en otro lado.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
// Etapas que representan un pedido YA cerrado, en cualquier momento
// posterior del despacho (recien cerrado, coordinando retiro, en camino, o
// ya entregado). Se usa para no "retroceder" una conversacion que ya avanzo
// mas alla de "vendido" cuando se detecta el cierre; panel.js usa la misma
// lista para que las metricas (conversion, ingresos) cuenten cualquiera de
// estas etapas como una venta real, no solo "vendido" al pie de la letra.
const SOLD_STAGES = ['vendido', 'esperando_guia', 'esperando_retiro', 'en_camino', 'entregado'];

// Red de seguridad de codigo: esto paso de verdad una vez (ver
// buildDirectAgencyMessage en ai.js) — el modelo le prometio a un cliente
// "te busco la agencia mas cercana, dame un momentito" y nunca llamo a la
// herramienta ni mando la lista real, dejando al cliente esperando una
// respuesta que nunca llegaba. El prompt ya le pide explicitamente que
// nunca haga esto, pero es una instruccion probabilistica (no siempre se
// respeta), asi que esto detecta la promesa incumplida por el TEXTO que ya
// mando el bot y, si corresponde, manda la lista real como mensaje aparte
// en el mismo momento, en vez de dejar al cliente esperando.
// OJO: esta lista se amplio despues de un caso real ("voy a buscar las
// agencias de Tealca mas cercanas... Un momento, por favor") que no matcheaba
// ninguna de las frases originales (esas cubrian "te buscar", "dame un
// momento", etc, pero no "voy a buscar" ni "un momento" sin "dame" adelante).
const PENDING_AGENCY_PROMISE_RE =
  /te buscar|voy a buscar|dame un moment|un momento,?\s*por favor|en un momento|ya te (busco|paso|env[ií]o)|enseguida te|en breve|ahorita te/i;

function looksLikePendingAgencyPromise(text) {
  const t = String(text || '');
  if (!/agencia/i.test(t) || !PENDING_AGENCY_PROMISE_RE.test(t)) return false;
  // Si el mensaje YA trae una lista numerada (1. ... 2. ...), es porque la
  // herramienta si se llamo y la lista real ya se mando: no es una promesa
  // sin cumplir, es solo texto de acompañamiento. Solo cuenta como promesa
  // incumplida cuando NO hay ninguna lista numerada en el mensaje.
  return !/(^|\n)\s*\d+[.)]\s/.test(t);
}

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
  results.forEach((res) => {
    if (res.status === 'fulfilled') {
      appendMessage(to, 'assistant', '[imagen]');
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
      appendMessage(to, 'assistant', `[imagen] ${valid[i].img.name}`);
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

  let rawText =
    type === 'text'
      ? message.text.body.trim()
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
      const intro = product.intro.trim();
      await sendTextOrImage(from, intro, product.introImageIds);
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
    const knownCity = session.card?.ciudad || null;
    const knownProduct = session.linkedProductId ? findProduct(session.linkedProductId)?.name || null : null;
    // OJO: antes esto se sacaba de session.stage (puesto por el clasificador
    // por IA, que corre aparte y despues de mandar la respuesta). En la
    // practica eso resulto poco confiable: hubo conversaciones donde el
    // pedido ya estaba cerrado (se mando el mensaje de cierre) pero el
    // clasificador nunca marco la etapa como "vendido", asi que el bot
    // seguia agregando la pregunta de venta de siempre. Ahora usamos un flag
    // propio (session.orderClosed) que se prende mas abajo, en el momento
    // exacto en que el BOT genera el mensaje de cierre (deteccion directa
    // del texto, sin depender de otra IA aparte).
    const orderClosed = session.orderClosed === true;
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
    const { text: reply, images } = await getAssistantReply(history, userText, knownCity, knownProduct, orderClosed, dataAlreadyRequested, shippingStage, knownCustomer);

    // Red de seguridad de codigo, ademas del aviso en el prompt: si ya se
    // habia pedido nombre/cedula/telefono antes y el modelo igual intento
    // mandar ese bloque de nuevo, lo sacamos y mandamos solo un recordatorio
    // corto en su lugar (o el resto del mensaje, si tenia algo mas aparte del
    // bloque repetido).
    let finalReply = reply;
    if (dataAlreadyRequested && looksLikeEmptyDataRequest(reply)) {
      const stripped = stripDuplicateDataRequest(reply);
      finalReply = stripped === null ? DATA_REQUEST_REMINDER : stripped;
    }

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

    const patch = { lastAssistantText: finalReply };
    if (!dataAlreadyRequested && looksLikeEmptyDataRequest(reply)) {
      patch.orderDataRequested = true;
    }
    const isNewClose = !orderClosed && isClosingMessage(reply);
    if (isNewClose) {
      patch.orderClosed = true;
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
            mergedCard[key] = value;
          }
        }
        const classPatch = { stage: classification.stage, stageReason: classification.razon || null, card: mergedCard };
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
        const updated = updateSession(from, classPatch);
        if (classification.stage === 'vendido' && current.stage !== 'vendido') push.notifySale(from, updated);
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
};

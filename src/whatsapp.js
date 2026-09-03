const axios = require('axios');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';

function client() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) {
    throw new Error('Faltan WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_TOKEN en las variables de entorno.');
  }
  return axios.create({
    baseURL: 'https://graph.facebook.com/' + API_VERSION + '/' + phoneNumberId,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

async function sendText(to, body) {
  const api = client();
  await api.post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  });
}

async function sendButtons(to, bodyText, buttons) {
  const api = client();
  await api.post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

async function sendLocationRequest(to, bodyText) {
  const api = client();
  await api.post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: bodyText },
      action: { name: 'send_location' },
        },
  });
}

// Manda una imagen por URL publica (nuestro propio /media/<archivo>), sin
// pasar por el endpoint de subida de Meta: mas simple y alcanza porque el
// servidor ya es publico. caption es opcional.
async function sendImageByLink(to, link, caption) {
  const api = client();
  await api.post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: caption ? { link, caption } : { link },
  });
}

// Manda una nota de voz por URL publica (mismo mecanismo que sendImageByLink):
// nuestro propio /media/<archivo>.mp3, generado por tts.js.
async function sendAudioByLink(to, link) {
  const api = client();
  await api.post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: { link },
  });
}

// headerImageUrl: opcional. Algunas plantillas (ej. "guia_del_pedido") se
// aprobaron con un encabezado de imagen OBLIGATORIO en Meta: si la plantilla
// lo tiene, WhatsApp exige mandar ese componente en TODOS los envios, o
// rechaza el mensaje entero. Tiene que ser una URL publica (nuestro propio
// /media/<archivo>, igual que usa sendImageByLink) — no un archivo local.
async function sendTemplate(to, templateName, languageCode, params, headerImageUrl) {
  languageCode = languageCode || 'es';
  params = params || [];
  const api = client();
  const components = params.length > 0 ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }] : [];
  if (headerImageUrl) {
    components.unshift({ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] });
  }

await api.post('/messages', {
  messaging_product: 'whatsapp',
  to,
  type: 'template',
  template: {
    name: templateName,
    language: { code: languageCode },
    components,
  },
});
}

// Descarga un archivo multimedia que mando el cliente (audio, imagen, etc).
// WhatsApp no da una URL publica directa: primero hay que pedir la URL real
// con el ID del archivo, y despues descargarla, las dos veces con el mismo
// token (si no, la URL de Meta devuelve error de permisos).
async function downloadMedia(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('Falta WHATSAPP_TOKEN en las variables de entorno.');

  const metaRes = await axios.get(`https://graph.facebook.com/${API_VERSION}/${mediaId}`, {
    headers: { Authorization: 'Bearer ' + token },
    timeout: 15000,
  });
  const { url, mime_type } = metaRes.data;
  if (!url) throw new Error('Meta no devolvio una URL para este archivo.');

  const fileRes = await axios.get(url, {
    headers: { Authorization: 'Bearer ' + token },
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  return { buffer: Buffer.from(fileRes.data), mimeType: mime_type || '' };
}

async function markAsRead(messageId) {
  const api = client();
  try {
    await api.post('/messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  } catch (err) {
    console.warn('No se pudo marcar como leido:', err.message);
  }
}

module.exports = { sendText, sendButtons, sendLocationRequest, sendImageByLink, sendAudioByLink, sendTemplate, markAsRead, downloadMedia };

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

async function sendTemplate(to, templateName, languageCode, params) {
  languageCode = languageCode || 'es';
  params = params || [];
  const api = client();
  const components = params.length > 0 ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }] : [];

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

module.exports = { sendText, sendButtons, sendLocationRequest, sendImageByLink, sendTemplate, markAsRead };

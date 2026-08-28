require('dotenv').config();
const express = require('express');
const { handleIncomingMessage } = require('./flow');
const { markAsRead } = require('./whatsapp');
const { MEDIA_DIR } = require('./library');
const panelRouter = require('./web/panel');
const siteRouter = require('./web/site');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';

// Meta llama a este GET una sola vez para verificar que el webhook es tuyo.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado correctamente.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Meta envia aqui cada mensaje/evento entrante.
app.post('/webhook', async (req, res) => {
  // Responder rapido a Meta; procesar despues.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      // Puede ser un evento de estado (entregado/leido), lo ignoramos.
      return;
    }

    const from = message.from; // numero del cliente
    const profileName = value?.contacts?.find((c) => c.wa_id === from)?.profile?.name || null;

    if (message.id) {
      markAsRead(message.id).catch(() => {});
    }

    await handleIncomingMessage(from, message, profileName);
  } catch (err) {
    console.error('Error procesando mensaje entrante:', err);
  }
});

// Imagenes de la biblioteca: tienen que ser publicas y sin auth porque las
// va a buscar WhatsApp (Meta), no un navegador logueado.
app.use('/media', express.static(MEDIA_DIR));

app.use('/panel', panelRouter);
app.use('/', siteRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});

require('dotenv').config();
const express = require('express');
const { handleIncomingMessage } = require('./flow');
const { markAsRead } = require('./whatsapp');
const { MEDIA_DIR } = require('./library');
const panelRouter = require('./web/panel');
const siteRouter = require('./web/site');
const remarketing = require('./remarketing');

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
    const messages = value?.messages || [];

    // Normalmente Meta manda un mensaje por webhook, pero a veces junta
    // varios en un mismo POST (por ejemplo si el cliente escribio rapido):
    // se procesan todos, uno por uno, en el orden en que llegaron.
    for (const message of messages) {
      const from = message.from; // numero del cliente
      if (!from) {
        // Sin numero no hay a quien contestarle ni donde guardar el
        // mensaje: antes esto terminaba creando una conversacion fantasma
        // con la clave literal "undefined". Se loguea el payload completo
        // para poder diagnosticarlo (ej. un formato de webhook distinto,
        // como un mensaje de Instagram en vez de WhatsApp) y se lo saltea.
        console.warn('Mensaje entrante sin "from", se ignora:', JSON.stringify(message));
        continue;
      }
      const profileName = value?.contacts?.find((c) => c.wa_id === from)?.profile?.name || null;

      if (message.id) {
        markAsRead(message.id).catch(() => {});
      }

      await handleIncomingMessage(from, message, profileName);
    }
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
  remarketing.start();
});

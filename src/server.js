require('dotenv').config();
const express = require('express');
const { handleIncomingMessage, SOLD_STAGES } = require('./flow');
const { markAsRead } = require('./whatsapp');
const { MEDIA_DIR } = require('./library');
const { listSessions, updateSession } = require('./state');
const panelRouter = require('./web/panel');
const siteRouter = require('./web/site');
const remarketing = require('./remarketing');
const { normalizeProductName } = require('./catalog');

// Correccion de una sola vez (retroactiva): antes, a las conversaciones que
// ya estaban vendidas de antes de existir el campo soldAt se les rellenaba
// soldAt copiando updatedAt (la ultima vez que se toco esa conversacion por
// CUALQUIER motivo, no necesariamente la venta). Eso hacia que conversaciones
// vendidas hace semanas, pero con actividad reciente (una nota, el
// clasificador corriendo despues de cada respuesta del bot, etc.), aparecieran
// como "vendidas hoy" en las metricas por rango — el mismo bug que ya se
// habia arreglado, reintroducido por este relleno.
//
// La señal para detectar cuales soldAt vienen de ese relleno viejo (y no de
// una deteccion real) es que quedaron IDENTICOS a updatedAt: cuando el
// sistema detecta una venta de verdad, soldAt y updatedAt se calculan por
// separado (dos llamadas a new Date() distintas, milisegundos aparte), asi
// que practicamente nunca coinciden byte a byte. Si coinciden, es el relleno
// viejo. En esos casos se vuelve a dejar soldAt en null: la conversacion
// sigue contando en el total general de ventas, pero deja de aparecer con
// una fecha falsa en las metricas por rango (pasa a contarse como "sin fecha
// registrada").
//
// Es segura de correr en cada arranque: una vez corregida, soldAt queda en
// null y ya no vuelve a coincidir con updatedAt, asi que no se repite.
function fixBackfilledSoldAt() {
  const sessions = listSessions();
  let fixed = 0;
  for (const s of sessions) {
    if (s.soldAt && s.updatedAt && s.soldAt === s.updatedAt) {
      updateSession(s.phone, { soldAt: null });
      fixed++;
    }
  }
  if (fixed) {
    console.log(`Correccion de soldAt: se quito la fecha aproximada (no confiable) de ${fixed} conversacion(es); ahora cuentan como "sin fecha registrada" en vez de aparecer como vendidas hoy.`);
  }
}

// Correccion de una sola vez (retroactiva): card.producto se guarda como
// texto libre (lo que anota la IA charlando), asi que con el tiempo terminan
// quedando muchas variantes distintas del MISMO producto ("shilajit", "1
// frasco de Shilajit", "combo de 2 frascos de Shilajit", "Shilajit Viking"),
// fragmentando Metricas > Productos mas vendidos como si fueran ventas
// separadas (se detecto con datos reales: mas de 13 variantes para un solo
// item). El clasificador (ver classifier.js) ya normaliza esto de ahora en
// mas contra el catalogo, pero eso solo corrige conversaciones con mensajes
// nuevos: esto de aca pasa una vez por TODAS las conversaciones ya guardadas
// para que el arreglo se vea reflejado tambien en las ventas de antes.
//
// Segura de correr en cada arranque: normalizar un nombre que ya esta
// normalizado no cambia nada, asi que no se repite el trabajo ni hay riesgo
// de ir empeorando el dato con cada reinicio.
function fixFragmentedProductNames() {
  const sessions = listSessions();
  let fixed = 0;
  for (const s of sessions) {
    const actual = s.card?.producto;
    if (!actual) continue;
    const normalizado = normalizeProductName(actual);
    if (normalizado !== actual) {
      updateSession(s.phone, { card: { ...s.card, producto: normalizado } });
      fixed++;
    }
  }
  if (fixed) {
    console.log(`Normalizacion de productos: se unifico el nombre de producto de ${fixed} conversacion(es) contra el catalogo.`);
  }
}

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
  fixBackfilledSoldAt();
  fixFragmentedProductNames();
  remarketing.start();
});

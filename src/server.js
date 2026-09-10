require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { handleIncomingMessage, SOLD_STAGES } = require('./flow');
const { markAsRead } = require('./whatsapp');
const { MEDIA_DIR } = require('./library');
const { listSessions, updateSession, applyTemplateStatus } = require('./state');
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
// FASE 1 (H01): ademas de parsear el JSON, guardamos el cuerpo crudo
// (rawBody) porque la verificacion de firma de Meta (X-Hub-Signature-256)
// se calcula sobre los bytes exactos que llegaron, no sobre el objeto ya
// parseado (que puede serializarse distinto: orden de claves, espacios).
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';

// FASE 1 (H01): antes, CUALQUIERA que conociera (o adivinara) la URL de
// /webhook podia mandarle un POST fabricado a mano y el bot lo procesaba
// como si fuera un mensaje real de un cliente de WhatsApp -incluyendo
// hacer que la IA "conteste" ese contenido fabricado-. Meta firma cada POST
// real con HMAC-SHA256 (header X-Hub-Signature-256) usando el App Secret de
// la app de Meta; si configuramos ese mismo secreto aca, podemos verificar
// que el POST realmente vino de Meta antes de tocar la IA o el historial
// del cliente.
//
// Guardado a proposito para no romper produccion de un dia para el otro:
// si WHATSAPP_APP_SECRET todavia no esta cargado en Render, la verificacion
// queda desactivada (deja pasar todo, como antes) pero avisa fuerte en los
// logs para que se complete la configuracion cuanto antes.
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';

if (!APP_SECRET) {
  console.warn(
    'AVISO DE SEGURIDAD: WHATSAPP_APP_SECRET no esta configurado. ' +
      'El webhook /webhook NO esta verificando la firma de Meta, asi que ' +
      'en teoria cualquiera podria mandarle POSTs fabricados. Configura ' +
      'WHATSAPP_APP_SECRET en las variables de entorno (Render > ' +
      'Environment) con el App Secret de la app de Meta en cuanto puedas.'
  );
}

// Calcula la firma esperada para un cuerpo crudo dado, en el mismo formato
// que manda Meta ("sha256=<hex>"). Exportada aparte para poder probarla sin
// tener que levantar un servidor HTTP de verdad.
function computeExpectedSignature(rawBody) {
  const hmac = crypto.createHmac('sha256', APP_SECRET).update(rawBody || Buffer.alloc(0));
  return 'sha256=' + hmac.digest('hex');
}

// Middleware que rechaza (403) cualquier POST a /webhook cuya firma no
// coincida con la esperada, ANTES de que el mensaje llegue a
// handleIncomingMessage (y por lo tanto antes de que la IA lo vea o de que
// se guarde nada en el historial del cliente). Si WHATSAPP_APP_SECRET no
// esta configurado, deja pasar todo (ver aviso de arriba).
function verifyWebhookSignature(req, res, next) {
  if (!APP_SECRET) return next();

  const received = req.get('x-hub-signature-256') || '';
  const expected = computeExpectedSignature(req.rawBody);

  const receivedBuf = Buffer.from(received);
  const expectedBuf = Buffer.from(expected);
  const valid =
    receivedBuf.length === expectedBuf.length && crypto.timingSafeEqual(receivedBuf, expectedBuf);

  if (!valid) {
    console.warn('Webhook POST rechazado: firma X-Hub-Signature-256 ausente o invalida.');
    return res.sendStatus(403);
  }
  next();
}

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
app.post('/webhook', verifyWebhookSignature, async (req, res) => {
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

  // FASE 5 (H35): eventos de status de un mensaje YA mandado por nosotros
  // (sent/delivered/read/failed), separados de los mensajes entrantes de
  // arriba -- antes esto no se leia en absoluto, asi que el panel nunca
  // podia mostrar "entregado"/"leido" con confirmacion real de Meta. Va en
  // su propio try/catch para que un problema aca (ej. un formato de evento
  // inesperado) nunca tumbe el procesamiento de mensajes entrantes de
  // arriba, que es lo critico para el bot.
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const statuses = change?.value?.statuses || [];
    for (const statusEvent of statuses) {
      applyTemplateStatus(statusEvent);
    }
  } catch (err) {
    console.error('Error procesando status de WhatsApp:', err);
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

// FASE 1: solo arrancamos el servidor de verdad (bind de puerto, timers de
// remarketing, correcciones retroactivas) cuando este archivo se ejecuta
// directamente (npm start / node src/server.js), no cuando otro archivo lo
// require()-ea. Esto permite requerir server.js desde los tests (para
// probar verifyWebhookSignature / computeExpectedSignature) sin levantar un
// servidor real ni disparar efectos secundarios de arranque.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
    fixBackfilledSoldAt();
    fixFragmentedProductNames();
    remarketing.start();
  });
}

module.exports = { app, verifyWebhookSignature, computeExpectedSignature };

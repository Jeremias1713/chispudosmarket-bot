// Panel web para ver y manejar las conversaciones del bot sin abrir WhatsApp,
// administrar el catalogo, la biblioteca de imagenes, la configuracion en
// vivo, mandar envios masivos con plantillas aprobadas y probar el bot en un
// simulador. Protegido con usuario/clave, leidos de las variables de entorno
// PANEL_USER / PANEL_PASS (ver login() mas abajo: la sesion queda guardada
// en una cookie firmada por 30 dias, para no tener que iniciar sesion de
// nuevo cada rato en el celular).
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const {
  listSessions,
  getSession,
  updateSession,
  appendMessage,
  setPaused,
  setStage,
  unlockStage,
  markFollowUp,
} = require('../state');
const { sendText, sendImageByLink, sendTemplate } = require('../whatsapp');
const { STAGES } = require('../classifier');
const catalog = require('../catalog');
const library = require('../library');
const agencies = require('../agencies');
const settingsStore = require('../settings');
const broadcasts = require('../broadcasts');
const simulator = require('../simulator');
const coupons = require('../coupons');
const { mediaUrl, SOLD_STAGES } = require('../flow');
const push = require('../push');
const { WHATSAPP_WINDOW_MS, lastInboundAt, isWindowOpen } = require('../whatsappWindow');
const shipping = require('../shipping');
const dropanas = require('../dropanas');
const personalizedBroadcast = require('../personalizedBroadcast');
const seguimiento = require('../seguimiento');

const STAGE_LABELS = {
  nuevo: 'Nuevo',
  interesado: 'Interesado',
  negociando: 'Negociando',
  vendido: 'Vendido',
  esperando_guia: 'Esperando guía',
  esperando_retiro: 'Esperando retiro',
  en_camino: 'En camino',
  entregado: 'Entregado',
  necesita_atencion: 'Necesita atención',
  perdido: 'Perdido',
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/* ---------- login (cookie firmada, 30 dias) ---------- */
// Antes esto era HTTP Basic Auth: el navegador (sobre todo en el celular)
// olvidaba las credenciales cada rato y pedia usuario/clave de nuevo. Ahora
// es una pantalla de login propia que deja una cookie firmada (HMAC, sin
// guardar sesiones en el servidor) valida por 30 dias.
const SESSION_COOKIE = 'panel_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

function sessionSecret() {
  // Si se define PANEL_SESSION_SECRET en las variables de entorno se usa esa
  // (mejor, no depende de la clave del panel); si no, se deriva de
  // PANEL_PASS para que funcione sin configuracion extra.
  return process.env.PANEL_SESSION_SECRET || `${process.env.PANEL_PASS || ''}::chispudos-panel-session`;
}

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', sessionSecret()).update(data).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    if (!k) return;
    out[k] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function loginPageHtml(errorMsg) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ingresar — Panel ChispudosMarket</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f4f4fb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .card { background: #fff; border-radius: 16px; padding: 32px 28px; width: 100%; max-width: 340px;
    box-shadow: 0 10px 30px rgba(20,20,50,.08); }
  h1 { font-size: 18px; margin: 0 0 4px; color: #1a1a2e; }
  p.sub { margin: 0 0 20px; color: #70708a; font-size: 13px; }
  label { display: block; font-size: 13px; color: #40405a; margin-bottom: 4px; margin-top: 14px; }
  input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #dcdce8; font-size: 15px; }
  input:focus { outline: 2px solid #5D5FEF; border-color: transparent; }
  button { width: 100%; margin-top: 20px; padding: 11px; border: none; border-radius: 10px;
    background: #5D5FEF; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #4c4ed6; }
  .err { color: #d33; font-size: 13px; margin: 14px 0 0; }
</style></head>
<body>
  <form class="card" method="post" action="/panel/login">
    <h1>Panel ChispudosMarket</h1>
    <p class="sub">Iniciá sesión para entrar. Queda guardado en este dispositivo por 30 días.</p>
    <label for="username">Usuario</label>
    <input type="text" id="username" name="username" autocomplete="username" required autofocus>
    <label for="password">Clave</label>
    <input type="password" id="password" name="password" autocomplete="current-password" required>
    <button type="submit">Ingresar</button>
    ${errorMsg ? `<p class="err">${errorMsg}</p>` : ''}
  </form>
</body></html>`;
}

const router = express.Router();

router.get('/login', (_req, res) => {
  res.type('html').send(loginPageHtml());
});

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const user = process.env.PANEL_USER;
  const pass = process.env.PANEL_PASS;
  if (!user || !pass) {
    return res.status(503).send('El panel no esta configurado. Falta PANEL_USER / PANEL_PASS en las variables de entorno.');
  }
  const { username, password } = req.body || {};
  if (username !== user || password !== pass) {
    return res.status(401).type('html').send(loginPageHtml('Usuario o clave incorrectos.'));
  }
  const token = signSession({ u: username, exp: Date.now() + SESSION_TTL_MS });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/panel',
  });
  res.redirect('/panel/');
});

router.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/panel' });
  res.redirect('/panel/login');
});

function cookieAuth(req, res, next) {
  const user = process.env.PANEL_USER;
  const pass = process.env.PANEL_PASS;
  if (!user || !pass) {
    return res.status(503).send('El panel no esta configurado. Falta PANEL_USER / PANEL_PASS en las variables de entorno.');
  }

  const cookies = parseCookies(req);
  const session = verifySession(cookies[SESSION_COOKIE]);
  if (session && session.u === user) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Sesion vencida o no iniciada. Iniciá sesión de nuevo.' });
  }
  return res.redirect('/panel/login');
}

router.use(cookieAuth);
router.use(express.static(path.join(__dirname, '..', '..', 'public', 'panel')));

/* ---------- conversaciones ---------- */

function toConvo(s) {
  const history = s.history || [];
  const last = history[history.length - 1];
  const inboundAt = lastInboundAt(history);
  return {
    phone: s.phone,
    name: s.name || null,
    stage: s.stage || 'nuevo',
    stageLocked: Boolean(s.stageLocked),
    stageReason: s.stageReason || null,
    paused: Boolean(s.paused),
    pausedReason: s.pausedReason || null,
    card: s.card || {},
    lastMessage: last ? last.content : '',
    lastMessageAt: last ? last.at : s.updatedAt || s.createdAt || null,
    createdAt: s.createdAt || null,
    lastFollowUpAt: s.lastFollowUpAt || null,
    note: s.internalNote || null,
    shippingNotifiedAt: s.shippingNotifiedAt || null,
    // Ventana de 24h de WhatsApp: si esta cerrada, el panel avisa y bloquea
    // el texto libre en vez de dejar que WhatsApp lo rebote solo.
    lastInboundAt: inboundAt,
    windowOpen: inboundAt ? Date.now() - new Date(inboundAt).getTime() < WHATSAPP_WINDOW_MS : false,
  };
}

router.get('/api/stages', (_req, res) => {
  res.json(STAGES.map((id) => ({ id, label: STAGE_LABELS[id] || id })));
});

router.get('/api/conversations', (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  let list = listSessions().map(toConvo);

  if (search) {
    list = list.filter(
      (c) =>
        c.phone.includes(search) ||
        (c.name || '').toLowerCase().includes(search) ||
        (c.lastMessage || '').toLowerCase().includes(search)
    );
  }

  list.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
  res.json(list);
});

router.get('/api/conversations/:phone', (req, res) => {
  const phone = req.params.phone;
  const s = getSession(phone);
  const messages = (s.history || []).map((m, i) => ({
    id: i,
    role: m.role,
    content: m.content,
    at: m.at || null,
    attachment: m.attachment || null,
  }));
  res.json({ conversation: toConvo({ phone, ...s }), messages });
});

router.post('/api/conversations/:phone/send', async (req, res) => {
  const phone = req.params.phone;
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'El mensaje esta vacio' });

  if (!isWindowOpen(getSession(phone))) {
    return res.status(409).json({
      error: 'Pasaron mas de 24 horas desde el ultimo mensaje del cliente: WhatsApp ya no deja mandar texto libre. Mandale una plantilla aprobada.',
      windowClosed: true,
    });
  }

  try {
    await sendText(phone, text);
  } catch (err) {
    return res.status(502).json({ error: 'No se pudo mandar el mensaje por WhatsApp: ' + err.message });
  }

  appendMessage(phone, 'human', text);
  res.json({ ok: true });
});

// Manda una plantilla ya aprobada por Meta a UNA sola conversacion puntual
// (a diferencia de /api/broadcasts, que es para mandar a varias de una).
// Pensado para el caso de "se me cerro la ventana de 24h y necesito mandar
// la guia de envio igual": el panel ofrece este boton apenas detecta que la
// ventana esta cerrada (ver windowOpen en toConvo).
router.post('/api/conversations/:phone/send-template', async (req, res) => {
  const phone = req.params.phone;
  const templateName = String(req.body?.templateName || '').trim();
  if (!templateName) return res.status(400).json({ error: 'Falta el nombre de la plantilla' });
  const languageCode = String(req.body?.languageCode || 'es').trim() || 'es';
  const params = Array.isArray(req.body?.params) ? req.body.params : [];

  try {
    await sendTemplate(phone, templateName, languageCode, params);
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return res.status(502).json({ error: 'No se pudo mandar la plantilla: ' + detail });
  }

  appendMessage(phone, 'human', `[plantilla] ${templateName}`);
  res.json({ ok: true });
});

// Mandar una imagen a mano desde el panel (ademas del texto manual de arriba).
// Se sube el archivo, se guarda en la misma biblioteca de imagenes (carpeta
// aparte para no mezclar con las fotos de producto) y se manda por WhatsApp
// igual que las fotos automaticas del bot, para reusar el mismo mecanismo
// (sendImageByLink) que ya sabe subir el link publico a Meta.
router.post('/api/conversations/:phone/send-image', upload.single('file'), async (req, res) => {
  const phone = req.params.phone;
  if (!req.file) return res.status(400).json({ error: 'Falta la imagen' });
  if (!isWindowOpen(getSession(phone))) {
    return res.status(409).json({
      error: 'Pasaron mas de 24 horas desde el ultimo mensaje del cliente: WhatsApp ya no deja mandar nada libre. Mandale una plantilla aprobada.',
      windowClosed: true,
    });
  }
  const caption = String(req.body?.caption ?? '').trim();

  let item;
  try {
    item = library.addImage({
      buffer: req.file.buffer,
      mime: req.file.mimetype,
      name: caption || 'Enviada desde el chat',
      folder: 'Enviadas desde el chat',
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const url = mediaUrl(item.filename);
  try {
    await sendImageByLink(phone, url, caption || undefined);
  } catch (err) {
    return res.status(502).json({ error: 'No se pudo mandar la imagen por WhatsApp: ' + err.message });
  }

  appendMessage(phone, 'human', caption, { attachment: { kind: 'image', url } });
  res.json({ ok: true });
});

router.post('/api/conversations/:phone/pause', (req, res) => {
  const phone = req.params.phone;
  const paused = Boolean(req.body?.paused);
  const s = setPaused(phone, paused, paused ? 'manual' : null);
  res.json({ ok: true, paused: s.paused });
});

router.post('/api/conversations/:phone/stage', (req, res) => {
  const phone = req.params.phone;

  if (req.body?.auto) {
    unlockStage(phone);
    return res.json({ ok: true, locked: false });
  }

  const stage = String(req.body?.stage ?? '');
  if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Etapa desconocida' });

  const before = getSession(phone);
  let updated = setStage(phone, stage, 'Fijada desde el panel');
  // Igual que el cierre automatico y la clasificacion por IA (ver flow.js):
  // se guarda la fecha real de la venta la primera vez que la etapa pasa a
  // CUALQUIERA de las etapas de SOLD_STAGES (no solo "vendido" textual: si
  // se fija a mano directamente en "esperando_retiro" o mas adelante,
  // tambien cuenta como el momento de la venta), para que las metricas por
  // rango de fechas (Metricas > por dia) puedan contar esta venta en el dia
  // que paso, no en el ultimo mensaje de la conversacion.
  if (SOLD_STAGES.includes(stage) && !updated.soldAt) {
    updated = updateSession(phone, { soldAt: new Date().toISOString() });
  }
  if (stage === 'vendido' && before.stage !== 'vendido') push.notifySale(phone, updated);
  // Si el pedido pasa a "en camino" o "esperando retiro" y la guia ya
  // estaba cargada de antes (se cargo mientras estaba en otra etapa), este
  // es el momento de avisarle al cliente solo, sin esperar a que alguien
  // entre al chat. No se espera la respuesta (fire-and-forget): es un aviso
  // best-effort, nunca debe trabar la respuesta de este endpoint.
  if (['en_camino', 'esperando_retiro'].includes(stage)) {
    shipping.maybeNotifyShipping(phone, updated).catch((err) => {
      console.error('Error avisando la guia automaticamente al cambiar de etapa:', err.message);
    });
  }
  res.json({ ok: true, locked: true, stage });
});

/* ---------- notificaciones push (venta nueva, tipo Shopify) ---------- */

router.get('/api/push/public-key', (_req, res) => {
  res.json({ publicKey: push.getPublicKey() });
});

router.post('/api/push/subscribe', (req, res) => {
  const subscription = req.body?.subscription;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
  push.addSubscription(subscription);
  res.json({ ok: true });
});

router.post('/api/push/unsubscribe', (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) push.removeSubscription(endpoint);
  res.json({ ok: true });
});

router.post('/api/push/test', async (_req, res) => {
  const result = await push.sendToAll({
    title: '🔔 Notificación de prueba',
    body: 'Si ves esto, las notificaciones de venta van a funcionar.',
    tag: 'prueba',
    url: '/panel/',
  });
  res.json({ ok: true, ...result });
});

// Marca que se le mando la guia de envio (seguimiento) a esta conversacion.
router.post('/api/conversations/:phone/follow-up', (req, res) => {
  const phone = req.params.phone;
  const s = markFollowUp(phone);
  res.json({ ok: true, lastFollowUpAt: s.lastFollowUpAt });
});

/* ---------- metricas ---------- */

// Conversaciones que necesitan seguimiento: interesado/negociando/necesita_atencion
// con mas de 4 horas sin novedad, o cualquiera en necesita_atencion (sin
// importar la antiguedad, esa etapa siempre merece atencion).
const STALE_STAGES = ['interesado', 'negociando', 'necesita_atencion'];
const STALE_HOURS = 4;

// Junta un dia YYYY-MM-DD con from/to (mismo criterio que el rango manual
// del pipeline, ver public/panel/app.js filtrarPorRango): inclusive en las
// dos puntas, y si falta uno de los dos el rango queda abierto de ese lado.
function inDateRange(iso, fromTs, toTs) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= fromTs && t <= toTs;
}

// El negocio es venezolano y el servidor (Render) corre en UTC: "hoy" o un
// rango de fechas calculado con Date directo queda desfasado hasta 4 horas
// (a las 8pm hora de Venezuela ya es "manana" en UTC, asi que mensajes de la
// noche quedaban afuera de "hoy", o el dashboard mostraba el dia siguiente
// como si ya hubiera arrancado). Todo lo que agrupe o filtre por dia
// calendario tiene que pasar por esto, nunca por Date/toDateString directo.
const CARACAS_TZ = 'America/Caracas';
function caracasDateStr(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CARACAS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
// Venezuela usa UTC-4 fijo (sin horario de verano desde 2016), asi que el
// limite de un dia calendario ahi se puede armar sumando el offset directo.
function caracasDayRangeMs(dateStr) {
  return {
    startMs: new Date(dateStr + 'T00:00:00-04:00').getTime(),
    endMs: new Date(dateStr + 'T23:59:59.999-04:00').getTime(),
  };
}

router.get('/api/metrics', (req, res) => {
  const sessions = listSessions();
  const now = Date.now();

  const byStage = {};
  for (const id of STAGES) byStage[id] = 0;
  for (const s of sessions) {
    const stage = STAGES.includes(s.stage) ? s.stage : 'nuevo';
    byStage[stage] = (byStage[stage] || 0) + 1;
  }

  const total = sessions.length;
  // Cuenta como venta cualquiera de las etapas de SOLD_STAGES (vendido,
  // esperando_retiro, en_camino, entregado), no solo "vendido" al pie de la
  // letra: un pedido cerrado sigue siendo una venta real aunque avance a
  // "esperando_retiro" o mas alla (de hecho, en la practica esto pasa casi
  // siempre apenas se cierra: el propio mensaje de cierre ya habla de guia
  // y agencia). Antes esto solo miraba "vendido" y las ventas reales quedaban
  // afuera de la conversion y de los ingresos.
  const vendidos = SOLD_STAGES.reduce((sum, stage) => sum + (byStage[stage] || 0), 0);
  const conversionRate = total > 0 ? (vendidos / total) * 100 : null;

  // Ingresos: suma del monto cargado a mano (panel > conversacion > "Monto
  // vendido") en las conversaciones que ya cerraron el pedido (SOLD_STAGES).
  // No convierte monedas, asume que todos los montos cargados usan la misma.
  let revenue = 0;
  for (const s of sessions) {
    if (SOLD_STAGES.includes(s.stage) && s.card?.monto != null) {
      const monto = Number(s.card.monto);
      if (!Number.isNaN(monto)) revenue += monto;
    }
  }

  const today = caracasDateStr(new Date());
  let messagesToday = 0;
  for (const s of sessions) {
    for (const m of s.history || []) {
      if (m.at && caracasDateStr(new Date(m.at)) === today) messagesToday++;
    }
  }

  const locationCounts = new Map();
  for (const s of sessions) {
    const ciudad = String(s.card?.ciudad || '').trim();
    if (!ciudad) continue;
    const key = ciudad.toLowerCase();
    const entry = locationCounts.get(key) || { ciudad, count: 0 };
    entry.count++;
    locationCounts.set(key, entry);
  }
  const topLocations = [...locationCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Productos mas vendidos: se agrupan por el texto libre de card.producto
  // (lo que anoto el bot/vendedor), contando conversaciones en cualquier
  // etapa de SOLD_STAGES (pedido ya cerrado).
  const productStats = new Map();
  for (const s of sessions) {
    if (!SOLD_STAGES.includes(s.stage)) continue;
    const producto = String(s.card?.producto || '').trim();
    if (!producto) continue;
    const key = producto.toLowerCase();
    const entry = productStats.get(key) || { producto, count: 0, revenue: 0 };
    entry.count++;
    const monto = Number(s.card?.monto);
    if (s.card?.monto != null && !Number.isNaN(monto)) entry.revenue += monto;
    productStats.set(key, entry);
  }
  const topProducts = [...productStats.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Codigo de anuncio (I1C1, I2C3...): se agrupa TODA conversacion que tenga
  // uno cargado (no solo las vendidas, a diferencia de topProducts de arriba)
  // para poder calcular una tasa de conversion por codigo — es justamente lo
  // que hace falta para decidir cual anuncio escalar y cual no. Ver flow.js
  // para donde se captura el codigo (una sola vez, del primer mensaje).
  const adCodeStats = new Map();
  for (const s of sessions) {
    const codigo = String(s.adCode || '').trim().toUpperCase();
    if (!codigo) continue;
    const entry = adCodeStats.get(codigo) || { codigo, count: 0, sales: 0 };
    entry.count++;
    if (SOLD_STAGES.includes(s.stage)) entry.sales++;
    adCodeStats.set(codigo, entry);
  }
  const topAdCodes = [...adCodeStats.values()]
    .map((e) => ({ ...e, conversionRate: e.count > 0 ? (e.sales / e.count) * 100 : null }))
    .sort((a, b) => b.sales - a.sales || b.count - a.count);

  const staleAttention = sessions
    .map((s) => {
      const history = s.history || [];
      const last = history[history.length - 1];
      const lastMessageAt = last ? last.at : s.updatedAt || s.createdAt || null;
      const hoursSinceLastMessage = lastMessageAt ? (now - new Date(lastMessageAt).getTime()) / 3600000 : null;
      return {
        phone: s.phone,
        name: s.name || null,
        stage: s.stage || 'nuevo',
        lastMessageAt,
        hoursSinceLastMessage,
        lastFollowUpAt: s.lastFollowUpAt || null,
      };
    })
    .filter((c) => {
      if (c.stage === 'necesita_atencion') return true;
      if (!STALE_STAGES.includes(c.stage)) return false;
      return c.hoursSinceLastMessage != null && c.hoursSinceLastMessage > STALE_HOURS;
    })
    .sort((a, b) => {
      if (a.stage === 'necesita_atencion' && b.stage !== 'necesita_atencion') return -1;
      if (b.stage === 'necesita_atencion' && a.stage !== 'necesita_atencion') return 1;
      return (b.hoursSinceLastMessage || 0) - (a.hoursSinceLastMessage || 0);
    });

  // Metricas segmentadas por rango de fechas (Metricas > "Por dia"), para
  // poder comparar un dia/semana contra otro en vez de ver siempre el
  // acumulado historico. byStage/total de arriba quedan igual (son una
  // FOTO del estado actual, no tiene sentido filtrarlos por fecha); esto de
  // aca es aparte: nuevas conversaciones, ventas e ingresos que pasaron dentro
  // del rango pedido.
  const { from, to } = req.query;
  let range = null;
  if (from || to) {
    const fromTs = from ? caracasDayRangeMs(from).startMs : -Infinity;
    const toTs = to ? caracasDayRangeMs(to).endMs : Infinity;

    const newConversations = sessions.filter((s) => inDateRange(s.createdAt, fromTs, toTs)).length;

    let rangeRevenue = 0;
    let rangeSales = 0;
    let undatedSales = 0;
    const rangeProductStats = new Map();
    for (const s of sessions) {
      if (!SOLD_STAGES.includes(s.stage)) continue;
      // OJO (bug ya corregido): esto antes caia a s.updatedAt cuando no
      // habia soldAt, pero updatedAt se pisa con CUALQUIER mensaje nuevo de
      // la conversacion (el cliente dice "gracias" tres dias despues de
      // comprar, o se le edita una nota) asi que una venta vieja terminaba
      // contando como "vendida hoy" no bien alguien le escribia de nuevo.
      // Ahora solo se cuenta si soldAt esta guardado de verdad: las ventas
      // de antes de que existiera este campo quedan afuera de los rangos
      // por fecha (siguen contando en el total historico de arriba), no se
      // inventa una fecha que no se sabe.
      if (!s.soldAt) {
        undatedSales++;
        continue;
      }
      if (!inDateRange(s.soldAt, fromTs, toTs)) continue;
      rangeSales++;
      const monto = Number(s.card?.monto);
      const montoValido = s.card?.monto != null && !Number.isNaN(monto);
      if (montoValido) rangeRevenue += monto;
      const producto = String(s.card?.producto || '').trim();
      if (producto) {
        const key = producto.toLowerCase();
        const entry = rangeProductStats.get(key) || { producto, count: 0, revenue: 0 };
        entry.count++;
        if (montoValido) entry.revenue += monto;
        rangeProductStats.set(key, entry);
      }
    }

    let rangeMessages = 0;
    for (const s of sessions) {
      for (const m of s.history || []) {
        if (inDateRange(m.at, fromTs, toTs)) rangeMessages++;
      }
    }

    // Mismo codigo de anuncio que el bloque de arriba, pero acotado al rango:
    // conversaciones NUEVAS del rango (por createdAt) vs cuantas de esas
    // (o de cualquier otra, si la venta se cerro despues) se vendieron
    // tambien dentro del rango (por soldAt).
    const rangeAdCodeStats = new Map();
    for (const s of sessions) {
      const codigo = String(s.adCode || '').trim().toUpperCase();
      if (!codigo || !inDateRange(s.createdAt, fromTs, toTs)) continue;
      const entry = rangeAdCodeStats.get(codigo) || { codigo, count: 0, sales: 0 };
      entry.count++;
      rangeAdCodeStats.set(codigo, entry);
    }
    for (const s of sessions) {
      const codigo = String(s.adCode || '').trim().toUpperCase();
      if (!codigo || !SOLD_STAGES.includes(s.stage) || !s.soldAt) continue;
      if (!inDateRange(s.soldAt, fromTs, toTs)) continue;
      const entry = rangeAdCodeStats.get(codigo) || { codigo, count: 0, sales: 0 };
      entry.sales++;
      rangeAdCodeStats.set(codigo, entry);
    }
    const rangeTopAdCodes = [...rangeAdCodeStats.values()]
      .map((e) => ({ ...e, conversionRate: e.count > 0 ? (e.sales / e.count) * 100 : null }))
      .sort((a, b) => b.sales - a.sales || b.count - a.count);

    range = {
      from: from || null,
      to: to || null,
      newConversations,
      sales: rangeSales,
      revenue: rangeRevenue,
      conversionRate: newConversations > 0 ? (rangeSales / newConversations) * 100 : null,
      messages: rangeMessages,
      // Ventas cerradas ANTES de que existiera el campo soldAt: no se sabe
      // que dia fue, asi que no se pueden ubicar en ningun rango. Se avisa
      // la cantidad para que no parezca que "faltan" ventas sin explicacion.
      undatedSales,
      topProducts: [...rangeProductStats.values()].sort((a, b) => b.count - a.count).slice(0, 10),
      topAdCodes: rangeTopAdCodes,
    };
  }

  res.json({ byStage, total, conversionRate, messagesToday, topLocations, topProducts, topAdCodes, staleAttention, revenue, range });
});

// Guarda el monto vendido de una conversacion (cargado a mano desde el
// panel). Vive dentro de card para reusar el mismo objeto que ya guarda
// nombre/ciudad/telefono/producto/notas.
router.post('/api/conversations/:phone/amount', (req, res) => {
  const phone = req.params.phone;
  const raw = req.body?.monto;
  const monto = raw === '' || raw == null ? null : Number(raw);
  if (monto != null && Number.isNaN(monto)) return res.status(400).json({ error: 'Monto invalido' });

  const s = getSession(phone);
  const card = { ...(s.card || {}), monto };
  const updated = updateSession(phone, { card });
  res.json({ ok: true, card: updated.card });
});

// Guarda el numero de guia de envio de un pedido (a mano, desde el panel), y
// opcionalmente la FOTO de esa guia (la mayoria de las agencias piden mostrar
// la foto del comprobante ademas del numero para poder retirar el pedido).
// En cuanto queda cargada, dispara el aviso automatico al cliente con ambas
// cosas (plantilla o texto libre segun la ventana de 24h — ver shipping.js):
// esta es la funcion que reemplaza tener que entrar al chat a avisarle a mano.
router.post('/api/conversations/:phone/guia', upload.single('imagen'), async (req, res) => {
  const phone = req.params.phone;
  const guia = String(req.body?.guia ?? '').trim();

  const s = getSession(phone);
  const card = { ...(s.card || {}) };
  if (req.body?.guia !== undefined) card.guia = guia || null;
  // Agencia de destino: se carga a mano aca porque este flujo (guia por
  // chat, una por una) no tiene un Excel del que sacarla sola, a diferencia
  // del seguimiento diario de Dropanas. Se usa como variable de la plantilla
  // "guia_del_pedido" cuando la ventana de 24h ya esta cerrada.
  if (req.body?.agencia !== undefined) {
    const agencia = String(req.body.agencia ?? '').trim();
    card.agencia = agencia || null;
  }

  if (req.file) {
    let item;
    try {
      item = library.addImage({
        buffer: req.file.buffer,
        mime: req.file.mimetype,
        name: `Guia de envio - ${phone}`,
        folder: 'Guias de envio',
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    card.guiaImageUrl = mediaUrl(item.filename);
  }

  const updated = updateSession(phone, { card });

  let notice = { sent: false, reason: 'sin_guia' };
  if (card.guia) {
    notice = await shipping.maybeNotifyShipping(phone, updated);
  }
  res.json({ ok: true, card: updated.card, notice });
});

/* ---------- guias por lote (export de Dropanas) ---------- */

// Analiza el Excel que se exporta desde Dropanas (con los numeros de guia ya
// generados) y propone a que conversacion corresponde cada uno, cruzando por
// nombre del cliente (ese export no trae telefono). No manda nada todavia:
// solo arma la lista para que el negocio la revise en el panel antes de
// confirmar (ver dropanas.js para el detalle del cruce por nombre).
router.post('/api/dropanas/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
  try {
    const rows = dropanas.matchExport(req.file.buffer);
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Espera entre cada envio del lote. No hace falta por limite tecnico de
// WhatsApp (el limite real es de decenas de mensajes por segundo): es solo
// para que la tanda salga de forma mas espaciada/natural.
const BULK_GUIA_DELAY_MS = 1200;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Confirma en bloque: para cada {phone, guia} que el negocio reviso y aprobo
// en el panel (ya sea una coincidencia automatica o una elegida a mano entre
// los candidatos ambiguos), guarda la guia y dispara el aviso automatico —
// exactamente el mismo mecanismo que cargarla una por una desde el chat (ver
// POST /api/conversations/:phone/guia), pero mandado uno por uno con una
// pausa chica entre cada uno en vez de todos de golpe.
router.post('/api/dropanas/confirm', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No hay nada para confirmar' });

  const results = [];
  for (const item of items) {
    const phone = String(item?.phone || '').trim();
    const guia = String(item?.guia || '').trim();
    if (!phone || !guia) {
      results.push({ phone, guia, ok: false, error: 'Faltan datos' });
      continue;
    }
    try {
      const s = getSession(phone);
      const card = { ...(s.card || {}), guia };
      const updated = updateSession(phone, { card });
      const notice = await shipping.maybeNotifyShipping(phone, updated);
      results.push({ phone, guia, ok: true, notice });
    } catch (err) {
      results.push({ phone, guia, ok: false, error: err.message });
    }
    if (items.length > 1) await sleep(BULK_GUIA_DELAY_MS);
  }

  res.json({ ok: true, results });
});

/* ---------- seguimiento diario (mismo Excel de Dropanas, actualiza etapas + avisa retiro) ---------- */

// Analiza el mismo Excel de Dropanas (guia, cliente, ciudad, producto,
// estado pedido, total venta, bodega destino) y arma una fila por pedido con
// la etapa nueva propuesta (si corresponde) y, si el estado es "En oficina",
// las variables ya calculadas de la plantilla de retiro. No cambia ni manda
// nada todavia: el negocio lo revisa en el panel y confirma.
router.post('/api/seguimiento/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
  try {
    const rows = dropanas.parseExportBuffer(req.file.buffer);
    const items = seguimiento.buildPreview(rows);
    res.json({ ok: true, items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Confirma en bloque: por cada fila que el negocio reviso y marco, actualiza
// la etapa (si corresponde) y manda la plantilla de retiro (si corresponde),
// una por una con una pausa chica entre cada una.
router.post('/api/seguimiento/confirm', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No hay nada para confirmar' });
  const results = await seguimiento.applyItems(items);
  res.json({ ok: true, results });
});

// Nota interna del negocio sobre este cliente (tags, recordatorios, lo que
// sea). No la toca el bot ni el clasificador: es aparte de "notas" dentro de
// card, que es lo que la IA infiere sola de la conversacion.
router.post('/api/conversations/:phone/note', (req, res) => {
  const phone = req.params.phone;
  const note = String(req.body?.note ?? '').trim();
  const updated = updateSession(phone, { internalNote: note || null });
  res.json({ ok: true, note: updated.internalNote || null });
});

/* ---------- catalogo ---------- */

router.get('/api/products', (_req, res) => {
  res.json(catalog.listProducts());
});

router.post('/api/products', (req, res) => {
  const product = catalog.createProduct(sanitizeProductInput(req.body));
  res.json(product);
});

router.post('/api/products/:id', (req, res) => {
  const product = catalog.updateProduct(req.params.id, sanitizeProductInput(req.body));
  if (!product) return res.status(404).json({ error: 'No existe ese producto' });
  res.json(product);
});

router.delete('/api/products/:id', (req, res) => {
  const ok = catalog.deleteProduct(req.params.id);
  if (!ok) return res.status(404).json({ error: 'No existe ese producto' });
  res.json({ ok: true });
});

function sanitizeProductInput(body) {
  const patch = {};
  if (body.name != null) patch.name = String(body.name).trim();
  if (body.sku != null) patch.sku = String(body.sku).trim();
  if (body.price != null) patch.price = Number(body.price) || 0;
  if (body.currency != null) patch.currency = String(body.currency).trim() || 'Bs';
  if (body.description != null) patch.description = String(body.description);
  if (body.active != null) patch.active = Boolean(body.active);
  if (body.prompt != null) patch.prompt = String(body.prompt);
  if (body.intro != null) patch.intro = String(body.intro);
  if (body.upsell != null) patch.upsell = String(body.upsell);
  if (body.remarketingEnabled != null) patch.remarketingEnabled = Boolean(body.remarketingEnabled);
  if (body.remarketing2h != null) patch.remarketing2h = String(body.remarketing2h);
  if (body.remarketing5h != null) patch.remarketing5h = String(body.remarketing5h);
  if (body.introImageIds !== undefined) {
    patch.introImageIds = Array.isArray(body.introImageIds)
      ? body.introImageIds
      : String(body.introImageIds || '').split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (body.triggers != null) {
    patch.triggers = Array.isArray(body.triggers)
      ? body.triggers
      : String(body.triggers).split(',').map((t) => t.trim()).filter(Boolean);
  }
  return patch;
}

/* ---------- cupones ---------- */

router.get('/api/coupons', (_req, res) => {
  res.json(coupons.listCoupons());
});

router.post('/api/coupons', (req, res) => {
  const coupon = coupons.createCoupon(sanitizeCouponInput(req.body));
  res.json(coupon);
});

router.post('/api/coupons/:id', (req, res) => {
  const coupon = coupons.updateCoupon(req.params.id, sanitizeCouponInput(req.body));
  if (!coupon) return res.status(404).json({ error: 'No existe ese cupon' });
  res.json(coupon);
});

router.delete('/api/coupons/:id', (req, res) => {
  const ok = coupons.deleteCoupon(req.params.id);
  if (!ok) return res.status(404).json({ error: 'No existe ese cupon' });
  res.json({ ok: true });
});

function sanitizeCouponInput(body) {
  const patch = {};
  if (body.code != null) patch.code = String(body.code).trim().toUpperCase();
  if (body.discountPercent != null) patch.discountPercent = Number(body.discountPercent) || 0;
  if (body.description != null) patch.description = String(body.description);
  if (body.active != null) patch.active = Boolean(body.active);
  return patch;
}

/* ---------- biblioteca de imagenes ---------- */

router.get('/api/library', (_req, res) => {
  res.json(library.listImages());
});

router.get('/api/library/folders', (_req, res) => {
  res.json(library.listFolders());
});

router.post('/api/library', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
  try {
    const item = library.addImage({
      buffer: req.file.buffer,
      mime: req.file.mimetype,
      name: req.body?.name || req.file.originalname,
      folder: req.body?.folder || null,
    });
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Renombrar una imagen y/o moverla de carpeta.
router.post('/api/library/:id', (req, res) => {
  const patch = {};
  if (req.body?.name != null) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'El nombre no puede quedar vacio' });
    patch.name = name;
  }
  if (req.body?.folder !== undefined) {
    patch.folder = req.body.folder ? String(req.body.folder).trim().slice(0, 60) || null : null;
  }
  const item = library.updateImage(req.params.id, patch);
  if (!item) return res.status(404).json({ error: 'No existe esa imagen' });
  res.json(item);
});

router.delete('/api/library/:id', (req, res) => {
  const ok = library.deleteImage(req.params.id);
  if (!ok) return res.status(404).json({ error: 'No existe esa imagen' });
  res.json({ ok: true });
});

/* ---------- cobertura de agencias (Excel) ---------- */

router.get('/api/agencies/meta', (_req, res) => {
  res.json(agencies.getMeta());
});

router.post('/api/agencies/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
  try {
    const meta = agencies.importFromWorkbookBuffer(req.file.buffer);
    res.json({ ok: true, ...meta });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---------- configuracion ---------- */

router.get('/api/settings', (_req, res) => {
  res.json(settingsStore.getSettings());
});

router.post('/api/settings', (req, res) => {
  const body = req.body || {};
  const patch = {};
  const fields = [
    'businessName',
    'welcomeMessage',
    'knowledgeBase',
    'openaiModel',
    'dataRequestTemplate',
    'shippingTemplateName',
    'shippingTemplateLanguage',
    'shippingFreeText',
    'pickupTemplateName',
    'pickupTemplateLanguage',
  ];
  for (const f of fields) if (body[f] != null) patch[f] = String(body[f]);
  if (body.welcomeImageIds !== undefined) {
    patch.welcomeImageIds = Array.isArray(body.welcomeImageIds)
      ? body.welcomeImageIds
      : String(body.welcomeImageIds || '').split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (body.openaiTemperature != null) patch.openaiTemperature = Number(body.openaiTemperature);
  if (body.openaiHistoryN != null) patch.openaiHistoryN = Number(body.openaiHistoryN);
  if (body.botEnabled != null) patch.botEnabled = Boolean(body.botEnabled);
  if (body.replyDelayMs != null) patch.replyDelayMs = Number(body.replyDelayMs);
  if (body.maxWordsPerMessage != null) patch.maxWordsPerMessage = Number(body.maxWordsPerMessage);
  if (body.maxWordsHardCap != null) patch.maxWordsHardCap = Number(body.maxWordsHardCap);
  if (body.maxMessageParts != null) patch.maxMessageParts = Number(body.maxMessageParts);
  if (body.splitRepliesEnabled != null) patch.splitRepliesEnabled = Boolean(body.splitRepliesEnabled);
  if (body.splitMinWords != null) patch.splitMinWords = Number(body.splitMinWords);
  if (body.splitGapMinMs != null) patch.splitGapMinMs = Number(body.splitGapMinMs);
  if (body.splitGapMaxMs != null) patch.splitGapMaxMs = Number(body.splitGapMaxMs);
  if (body.audioReplyEnabled != null) patch.audioReplyEnabled = Boolean(body.audioReplyEnabled);
  if (body.remarketingEnabled != null) patch.remarketingEnabled = Boolean(body.remarketingEnabled);
  if (body.remarketingHourStart != null) patch.remarketingHourStart = Number(body.remarketingHourStart);
  if (body.remarketingHourEnd != null) patch.remarketingHourEnd = Number(body.remarketingHourEnd);
  res.json(settingsStore.updateSettings(patch));
});

router.post('/api/bot/toggle', (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const s = settingsStore.updateSettings({ botEnabled: enabled });
  res.json({ ok: true, botEnabled: s.botEnabled });
});

/* ---------- envios masivos ---------- */

// Intenta traer las plantillas ya aprobadas desde Meta. Si no esta
// configurado WHATSAPP_BUSINESS_ACCOUNT_ID, el panel simplemente deja
// escribir el nombre de la plantilla a mano (como ya hacia broadcast.js).
router.get('/api/templates', async (_req, res) => {
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!wabaId || !token) return res.json({ available: false, templates: [] });

  try {
    const apiVersion = process.env.WHATSAPP_API_VERSION || 'v20.0';
    const { data } = await axios.get(`https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 100 },
      timeout: 10000,
    });
    const templates = (data.data || [])
      .filter((t) => t.status === 'APPROVED')
      .map((t) => ({ name: t.name, language: t.language, category: t.category }));
    res.json({ available: true, templates });
  } catch (err) {
    res.json({ available: false, templates: [], error: err.message });
  }
});

router.get('/api/broadcasts', (_req, res) => {
  res.json(broadcasts.listRuns());
});

router.post('/api/broadcasts', async (req, res) => {
  const templateName = String(req.body?.templateName || '').trim();
  if (!templateName) return res.status(400).json({ error: 'Falta el nombre de la plantilla' });

  const params = Array.isArray(req.body?.params) ? req.body.params : [];
  const target = req.body?.target || { scope: 'all' };
  const languageCode = req.body?.languageCode || 'es';

  const targets = broadcasts.resolveTargets(target);
  if (!targets.length) return res.status(400).json({ error: 'No hay conversaciones que coincidan con ese filtro' });

  const run = await broadcasts.startRun({ templateName, languageCode, params, target });
  res.json(run);
});

/* ---------- envio masivo PERSONALIZADO (variables distintas por cliente) ---------- */

// A diferencia de /api/broadcasts (que manda las mismas variables a todo el
// mundo), esto lee un Excel con una fila por cliente (telefono, nombre,
// apellido, monto...) y cada uno recibe la plantilla con SUS propios datos.
// No manda nada todavia: solo analiza el Excel y devuelve la lista para que
// el negocio la revise en el panel antes de confirmar.
router.post('/api/broadcasts/personalized/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
  try {
    const { rows, camposDetectados } = personalizedBroadcast.parsePersonalizedList(req.file.buffer);
    res.json({ ok: true, rows, camposDetectados });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Confirma en bloque: manda la plantilla a cada fila valida del Excel ya
// revisado, con sus propias variables en el orden indicado (order), una por
// una con una pausa chica entre cada envio (ver personalizedBroadcast.js).
router.post('/api/broadcasts/personalized/send', async (req, res) => {
  const templateName = String(req.body?.templateName || '').trim();
  if (!templateName) return res.status(400).json({ error: 'Falta el nombre de la plantilla' });
  const order = Array.isArray(req.body?.order) ? req.body.order : [];
  if (!order.length) return res.status(400).json({ error: 'Falta indicar el orden de las variables de la plantilla' });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No hay filas para mandar' });
  const languageCode = String(req.body?.languageCode || 'es').trim() || 'es';

  const results = await personalizedBroadcast.sendPersonalized({ templateName, languageCode, order, rows });
  res.json({ ok: true, results });
});

/* ---------- simulador ---------- */

router.get('/api/simulator', (_req, res) => {
  res.json(simulator.getState());
});

router.post('/api/simulator/reset', (_req, res) => {
  res.json(simulator.reset());
});

router.post('/api/simulator/message', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'El mensaje esta vacio' });
  try {
    const result = await simulator.sendMessage(text);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/simulator/location', async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: 'Faltan lat/lng' });
  const result = await simulator.sendLocation(Number(lat), Number(lng));
  res.json(result);
});

/* ---------- copia de seguridad ---------- */

// Junta lo que no esta en el codigo (y por lo tanto se puede perder si el
// servicio se reinicia sin disco persistente): conversaciones, catalogo,
// cupones y configuracion. Se descarga como un solo JSON desde el panel.
router.get('/api/backup', (_req, res) => {
  const backup = {
    generatedAt: new Date().toISOString(),
    sessions: listSessions(),
    products: catalog.listProducts(),
    coupons: coupons.listCoupons(),
    settings: settingsStore.getSettings(),
  };
  const filename = `chispudos-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json(backup);
});

// Igual que el backup pero en CSV, pensado para abrir en Excel/Sheets: una
// fila por conversacion con lo que sirve para llevar cuentas o declarar.
router.get('/api/export.csv', (_req, res) => {
  const sessions = listSessions();
  const header = [
    'Telefono',
    'Nombre',
    'Etapa',
    'Producto',
    'Ciudad',
    'Monto vendido',
    'Nota interna',
    'Ultimo mensaje',
    'Creado',
  ];
  const csvEscape = (value) => {
    const str = String(value ?? '');
    return /[",\n;]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  };
  const rows = sessions.map((s) => {
    const history = s.history || [];
    const last = history[history.length - 1];
    return [
      s.phone,
      s.name || '',
      STAGE_LABELS[s.stage] || s.stage || '',
      s.card?.producto || '',
      s.card?.ciudad || '',
      s.card?.monto != null ? s.card.monto : '',
      s.internalNote || '',
      (last ? last.at : s.updatedAt) || '',
      s.createdAt || '',
    ];
  });
  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const filename = `chispudos-ventas-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM al inicio para que Excel muestre bien las tildes/eñes.
  res.send('\uFEFF' + csv);
});

module.exports = router;

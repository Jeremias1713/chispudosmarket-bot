// Panel web para ver y manejar las conversaciones del bot sin abrir WhatsApp,
// administrar el catalogo, la biblioteca de imagenes, la configuracion en
// vivo, mandar envios masivos con plantillas aprobadas y probar el bot en un
// simulador. Protegido con usuario/clave (HTTP Basic Auth) leidos de las
// variables de entorno PANEL_USER / PANEL_PASS.
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
const { sendText } = require('../whatsapp');
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

const STAGE_LABELS = {
  nuevo: 'Nuevo',
  interesado: 'Interesado',
  negociando: 'Negociando',
  vendido: 'Vendido',
  esperando_retiro: 'Esperando retiro',
  en_camino: 'En camino',
  entregado: 'Entregado',
  necesita_atencion: 'Necesita atención',
  perdido: 'Perdido',
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function basicAuth(req, res, next) {
  const user = process.env.PANEL_USER;
  const pass = process.env.PANEL_PASS;

  if (!user || !pass) {
    return res
      .status(503)
      .send('El panel no esta configurado. Falta PANEL_USER / PANEL_PASS en las variables de entorno.');
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const u = decoded.slice(0, sep);
    const p = decoded.slice(sep + 1);
    if (u === user && p === pass) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Panel ChispudosMarket"');
  return res.status(401).send('Autenticacion requerida.');
}

const router = express.Router();
router.use(basicAuth);
router.use(express.static(path.join(__dirname, '..', '..', 'public', 'panel')));

/* ---------- conversaciones ---------- */

function toConvo(s) {
  const history = s.history || [];
  const last = history[history.length - 1];
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

  try {
    await sendText(phone, text);
  } catch (err) {
    return res.status(502).json({ error: 'No se pudo mandar el mensaje por WhatsApp: ' + err.message });
  }

  appendMessage(phone, 'human', text);
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
  const updated = setStage(phone, stage, 'Fijada desde el panel');
  if (stage === 'vendido' && before.stage !== 'vendido') push.notifySale(phone, updated);
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

router.get('/api/metrics', (_req, res) => {
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

  const today = new Date().toDateString();
  let messagesToday = 0;
  for (const s of sessions) {
    for (const m of s.history || []) {
      if (m.at && new Date(m.at).toDateString() === today) messagesToday++;
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

  res.json({ byStage, total, conversionRate, messagesToday, topLocations, topProducts, staleAttention, revenue });
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
  const fields = ['businessName', 'welcomeMessage', 'knowledgeBase', 'openaiModel'];
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

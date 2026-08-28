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
const { mediaUrl } = require('../flow');

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

  setStage(phone, stage, 'Fijada desde el panel');
  res.json({ ok: true, locked: true, stage });
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
  const vendidos = byStage.vendido || 0;
  const conversionRate = total > 0 ? (vendidos / total) * 100 : null;

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

  res.json({ byStage, total, conversionRate, messagesToday, topLocations, staleAttention });
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

router.post('/api/library', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
  try {
    const item = library.addImage({
      buffer: req.file.buffer,
      mime: req.file.mimetype,
      name: req.body?.name || req.file.originalname,
    });
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

module.exports = router;

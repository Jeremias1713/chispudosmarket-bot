// Panel web para ver y manejar las conversaciones del bot sin abrir WhatsApp:
// lista de chats con su etapa, ficha del cliente e historial completo de cada
// uno, con la posibilidad de pausar el bot y responder a mano. Protegido con
// usuario/clave (HTTP Basic Auth) leidos de las variables de entorno
// PANEL_USER / PANEL_PASS.
const express = require('express');
const path = require('path');
const {
  listSessions,
  getSession,
  appendMessage,
  setPaused,
  setStage,
  unlockStage,
} = require('../state');
const { sendText } = require('../whatsapp');
const { STAGES } = require('../classifier');

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

module.exports = router;

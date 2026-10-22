'use strict';
// Registro de los fallos de la IA (OpenAI), para poder ver la causa desde el
// panel sin entrar a los logs de Render, y para avisar a Jere por push (como
// mucho una vez por hora) cuando la IA empieza a fallar.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./dataDir');

const FILE = path.join(DATA_DIR, 'ai-errors.json');
const MAX = 100;
const PUSH_EVERY_MS = 60 * 60 * 1000;
let cache = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (err) { cache = { errors: [], lastPushAt: null }; }
  if (!Array.isArray(cache.errors)) cache.errors = [];
  return cache;
}

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(cache)); } catch (err) { /* sin disco: solo en memoria */ }
}

// Que tipo de fallo es, en palabras para Jere.
function kindOf(err) {
  const status = Number(err?.status);
  const code = String(err?.code || err?.error?.code || '');
  const msg = String(err?.message || '');
  if (code === 'insufficient_quota' || /quota|billing/i.test(msg)) return 'sin_saldo';
  if (status === 429) return 'limite_por_minuto';
  if (status === 401 || status === 403) return 'clave_invalida';
  if (status >= 500) return 'openai_caido';
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|ENETUNREACH|fetch failed|Connection error/i.test(msg + ' ' + String(err?.cause || ''))) return 'red_o_demora';
  return 'otro';
}

const LABEL = {
  sin_saldo: 'OpenAI sin saldo o límite mensual alcanzado: recarga en platform.openai.com > Billing',
  limite_por_minuto: 'Demasiados mensajes por minuto para el plan de OpenAI (error 429)',
  clave_invalida: 'La clave de OpenAI no es válida o no tiene permiso',
  openai_caido: 'OpenAI está fallando de su lado (error 5xx)',
  red_o_demora: 'El servidor no pudo conectarse a OpenAI o tardó demasiado',
  otro: 'Otro error',
};

function record(err, phone, deps = {}) {
  const c = load();
  const kind = kindOf(err);
  const at = new Date().toISOString();
  c.errors.push({
    at, kind, phone: phone ? `…${String(phone).slice(-4)}` : null,
    status: err?.status ?? null, code: err?.code || null,
    message: String(err?.message || '').slice(0, 300),
  });
  if (c.errors.length > MAX) c.errors = c.errors.slice(-MAX);
  let pushed = false;
  if (!c.lastPushAt || Date.now() - Date.parse(c.lastPushAt) > PUSH_EVERY_MS) {
    c.lastPushAt = at;
    pushed = true;
    try {
      const notify = deps.notifyAdmin || ((t, b) => require('./push').notifyAdmin(t, b));
      const p = notify('La IA está fallando', `${LABEL[kind]}. Detalle: ${String(err?.message || '').slice(0, 120)}`);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* push opcional */ }
  }
  save();
  return { kind, pushed };
}

// Para el panel: ultimos fallos y conteo por tipo en las ultimas 24 h.
function summary(now = Date.now()) {
  const c = load();
  const last24 = c.errors.filter((e) => now - Date.parse(e.at) < 24 * 3600 * 1000);
  const byKind = {};
  for (const e of last24) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return {
    ultimas24h: last24.length,
    porTipo: Object.fromEntries(Object.entries(byKind).map(([k, n]) => [LABEL[k] || k, n])),
    ultimos: c.errors.slice(-15).reverse(),
  };
}

function reset() { cache = { errors: [], lastPushAt: null }; save(); }

module.exports = { record, summary, kindOf, reset, LABEL };

// Limpieza automatica del disco. El bot se cayo por ENOSPC (disco lleno): ademas
// de las copias de sessions.json (ya acotadas en state.js), crecian sin limite
// los medios que mandan los clientes (audio-in-*, image-in-*, video-in-*), las
// capturas de guias (media/guias/*.png) y los mp3 de voz huerfanos (voz-*).
// Este modulo los borra por antiguedad, avisa por push cuando el disco se
// acerca al limite y le dice al resto del bot cuando NO conviene mandar nada
// automatico (si no se puede guardar la marca de "ya enviado", un mensaje
// puede salir repetido).
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./dataDir');

const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const CLIENT_MEDIA = /^(audio-in-|image-in-|video-in-)/;

let lastEnospcAt = 0;
let lastUsedRatio = null;
const lastAlertAt = { warn: 0, critical: 0 };

function envDays(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function markEnospc() {
  lastEnospcAt = Date.now();
}

// { totalBytes, freeBytes, usedRatio } o null si el sistema no lo soporta.
function diskUsage() {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(DATA_DIR);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!total) return null;
    const usage = { totalBytes: total, freeBytes: free, usedRatio: 1 - free / total };
    lastUsedRatio = usage.usedRatio;
    return usage;
  } catch (err) {
    return null;
  }
}

function isDiskCritical() {
  if (lastEnospcAt && Date.now() - lastEnospcAt < 15 * 60 * 1000) return true;
  return lastUsedRatio !== null && lastUsedRatio >= 0.95;
}

// Nombres de archivo que estan referenciados por library.json o products.json
// (no se borran nunca). Devuelve null si no se pudo leer alguno de los dos
// (que no exista no es error): en ese caso solo se borra lo que tiene prefijo
// conocido.
function referencedNames() {
  let text = '';
  for (const f of ['library.json', 'products.json']) {
    try {
      text += fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
    }
  }
  return text;
}

function isOldEnough(file, maxAgeMs, now) {
  return now - fs.statSync(file).mtimeMs > maxAgeMs;
}

function runOnce({ aggressive = false, now = Date.now() } = {}) {
  const result = { deleted: 0, freedBytes: 0, errors: 0 };
  const mediaDays = aggressive ? 7 : envDays('MEDIA_RETENTION_DAYS', 30);
  const guideDays = aggressive ? 15 : envDays('GUIDE_RETENTION_DAYS', 45);
  const refs = referencedNames();

  const tryDelete = (file) => {
    try {
      const size = fs.statSync(file).size;
      fs.unlinkSync(file);
      result.deleted += 1;
      result.freedBytes += size;
    } catch (err) {
      result.errors += 1;
    }
  };

  let names = [];
  try {
    names = fs.readdirSync(MEDIA_DIR);
  } catch (err) {
    names = [];
  }
  for (const name of names) {
    const file = path.join(MEDIA_DIR, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      if (name.startsWith('voz-')) {
        if (isOldEnough(file, HOUR_MS, now)) tryDelete(file);
      } else if (CLIENT_MEDIA.test(name)) {
        if (refs !== null && refs.includes(name)) continue;
        if (isOldEnough(file, mediaDays * DAY_MS, now)) tryDelete(file);
      }
    } catch (err) {
      result.errors += 1;
    }
  }

  const guiasDir = path.join(MEDIA_DIR, 'guias');
  let guias = [];
  try {
    guias = fs.readdirSync(guiasDir);
  } catch (err) {
    guias = [];
  }
  for (const name of guias) {
    if (!name.toLowerCase().endsWith('.png')) continue;
    const file = path.join(guiasDir, name);
    try {
      if (isOldEnough(file, guideDays * DAY_MS, now)) tryDelete(file);
    } catch (err) {
      result.errors += 1;
    }
  }

  // Si sessions.json esta muy pesado, los historiales de chats inactivos se
  // archivan comprimidos (ver state.compactHistories).
  try {
    const limit = envDays('SESSIONS_COMPACT_BYTES', 15 * 1024 * 1024);
    const sessionsFile = path.join(DATA_DIR, 'sessions.json');
    if (fs.statSync(sessionsFile).size > limit) {
      const compacted = require('./state').compactHistories({ olderThanMs: 90 * DAY_MS, keepLast: 150, now });
      result.compactedSessions = compacted.sessions;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') result.errors += 1;
  }

  console.log(`diskJanitor: ${result.deleted} archivos borrados, ${Math.round(result.freedBytes / 1024)} KB liberados, ${result.errors} errores${aggressive ? ' (modo agresivo)' : ''}`);
  return result;
}

function alert(kind, title, body) {
  const now = Date.now();
  if (now - lastAlertAt[kind] < 6 * HOUR_MS) return;
  lastAlertAt[kind] = now;
  try {
    const p = require('./push').notifyAdmin(title, body);
    if (p && p.catch) p.catch(() => {});
  } catch (err) {
    console.error('diskJanitor: no se pudo avisar por push:', err.message);
  }
}

function checkDisk() {
  const usage = diskUsage();
  if (!usage) return;
  const pct = Math.round(usage.usedRatio * 100);
  if (usage.usedRatio >= 0.9) {
    runOnce({ aggressive: true });
    alert('critical', 'Disco crítico', `El disco del bot está al ${pct}%. Se hizo limpieza agresiva de archivos viejos.`);
  } else if (usage.usedRatio >= 0.8) {
    alert('warn', 'Disco casi lleno', `El disco del bot está al ${pct}%.`);
  }
}

function start() {
  try {
    runOnce();
    checkDisk();
  } catch (err) {
    console.error('diskJanitor: error al arrancar:', err.message);
  }
  const clean = setInterval(() => {
    try { runOnce(); } catch (err) { console.error('diskJanitor:', err.message); }
  }, 6 * HOUR_MS);
  const check = setInterval(() => {
    try { checkDisk(); } catch (err) { console.error('diskJanitor:', err.message); }
  }, 10 * 60 * 1000);
  clean.unref?.();
  check.unref?.();
}

module.exports = { start, runOnce, diskUsage, isDiskCritical, markEnospc };

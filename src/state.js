// Almacen simple de sesiones por numero de telefono, persistido en un archivo JSON.
// Suficiente para un negocio pequeno/mediano; si el volumen crece mucho, se puede
// cambiar esto por una base de datos real sin tocar el resto del bot (mismo API).
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'data', 'sessions.json');

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveAll(sessions) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(sessions, null, 2));
}

function getSession(phone) {
  const sessions = loadAll();
  if (!sessions[phone]) {
    sessions[phone] = { step: 'START', cart: [], createdAt: new Date().toISOString() };
    saveAll(sessions);
  }
  return sessions[phone];
}

function updateSession(phone, patch) {
  const sessions = loadAll();
  sessions[phone] = { ...(sessions[phone] || {}), ...patch };
  saveAll(sessions);
  return sessions[phone];
}

function resetSession(phone) {
  const sessions = loadAll();
  sessions[phone] = { step: 'START', cart: [], createdAt: new Date().toISOString() };
  saveAll(sessions);
  return sessions[phone];
}

module.exports = { getSession, updateSession, resetSession };

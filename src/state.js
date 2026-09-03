// Almacen simple de sesiones por numero de telefono, persistido en un archivo JSON.
// Suficiente para un negocio pequeno/mediano; si el volumen crece mucho, se puede
// cambiar esto por una base de datos real sin tocar el resto del bot (mismo API).
//
// OJO: en el plan gratuito de Render el disco no es persistente entre reinicios
// del servicio (por ejemplo cuando la instancia se "duerme" por inactividad y
// se vuelve a levantar), asi que este historial puede perderse. Para produccion
// real con volumen conviene una base de datos o un disco persistente de Render.
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

function blankSession() {
  const now = new Date().toISOString();
  return {
    step: 'START',
    cart: [],
    history: [],
    name: null,
    stage: 'nuevo',
    // Fijar la etapa a mano le apaga el candado al clasificador: no la
    // vuelve a mover hasta que el panel lo pida explicitamente.
    stageLocked: false,
    stageReason: null,
    // Con el bot pausado, el mensaje entrante se guarda en el historial
    // (para que el panel lo vea) pero no se le contesta solo.
    paused: false,
    pausedReason: null,
    card: { nombre: null, ciudad: null, telefono: null, cedula: null, producto: null, notas: null },
    // Codigo de anuncio (I1C1, I2C3...) que el negocio precarga en el texto
    // del link de cada anuncio, para saber de que anuncio salio cada venta.
    // Se captura UNA sola vez, del primer mensaje de la conversacion (ver
    // flow.js), y nunca se vuelve a tocar despues.
    adCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

function getSession(phone) {
  const sessions = loadAll();
  if (!sessions[phone]) {
    sessions[phone] = blankSession();
    saveAll(sessions);
  }
  return sessions[phone];
}

function updateSession(phone, patch) {
  const sessions = loadAll();
  sessions[phone] = {
    ...(sessions[phone] || blankSession()),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveAll(sessions);
  return sessions[phone];
}

function resetSession(phone) {
  const sessions = loadAll();
  sessions[phone] = blankSession();
  saveAll(sessions);
  return sessions[phone];
}

// Agrega un mensaje al historial con marca de tiempo. role es 'user'
// (cliente), 'assistant' (IA) o 'human' (mandado a mano desde el panel).
// extra es opcional: por ahora se usa para { attachment } (ej. el audio
// original de una nota de voz, para que el panel lo pueda reproducir ademas
// de mostrar la transcripcion).
function appendMessage(phone, role, content, extra) {
  const sessions = loadAll();
  const session = sessions[phone] || blankSession();
  const history = [...(session.history || [])];
  history.push({ role, content, at: new Date().toISOString(), ...(extra || {}) });
  sessions[phone] = { ...session, history, updatedAt: new Date().toISOString() };
  saveAll(sessions);
  return sessions[phone];
}

// Pausar deja al bot mudo en esa conversacion (para que un humano tome el
// control a mano desde el panel); reason queda solo para mostrar por que.
function setPaused(phone, paused, reason) {
  return updateSession(phone, { paused: Boolean(paused), pausedReason: paused ? (reason || 'manual') : null });
}

// Fijar la etapa a mano prende el candado: el clasificador por IA deja de
// tocarla hasta que se llame a unlockStage.
function setStage(phone, stage, reason) {
  return updateSession(phone, { stage, stageLocked: true, stageReason: reason || 'Fijada desde el panel' });
}

function unlockStage(phone) {
  return updateSession(phone, { stageLocked: false, stageReason: null });
}

// Marca que se le mando la guia de envio (o se hizo el seguimiento) a esta
// conversacion, con la hora actual. Solo guarda la marca de tiempo; el panel
// la usa para mostrar "hace cuanto" y para el listado de seguimiento.
function markFollowUp(phone) {
  return updateSession(phone, { lastFollowUpAt: new Date().toISOString() });
}

// Devuelve todas las conversaciones, cada una con su numero de telefono
// incluido. Usado por el panel web para listar chats.
function listSessions() {
  const sessions = loadAll();
  return Object.entries(sessions).map(([phone, data]) => ({ phone, ...data }));
}

module.exports = {
  getSession,
  updateSession,
  resetSession,
  appendMessage,
  setPaused,
  setStage,
  unlockStage,
  markFollowUp,
  listSessions,
};

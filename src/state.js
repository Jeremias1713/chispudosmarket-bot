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
          stage: 'nuevo',
          card: { nombre: null, ciudad: null, telefono: null, producto: null, notas: null },
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

// Devuelve todas las conversaciones, cada una con su numero de telefono
// incluido. Usado por el panel web para listar chats.
function listSessions() {
    const sessions = loadAll();
    return Object.entries(sessions).map(([phone, data]) => ({ phone, ...data }));
}

module.exports = { getSession, updateSession, resetSession, listSessions };

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
const { DATA_DIR } = require('./dataDir');

const STATE_PATH = path.join(DATA_DIR, 'sessions.json');

// FASE 1 (H04): antes, cualquier error al leer sessions.json (archivo
// inexistente O corrupto) se trataba igual: se devolvia {} en silencio, y el
// siguiente saveAll() escribia ESE {} encima del archivo, borrando para
// siempre todas las sesiones anteriores. Ahora se distingue:
//   - archivo inexistente (ENOENT): es normal la primera vez, se devuelve {}.
//   - JSON invalido (corrupcion, escritura cortada a mitad): se intenta
//     restaurar desde la copia de seguridad valida mas reciente (ver abajo)
//     en vez de perder los datos. Solo si tampoco hay backup utilizable se
//     lanza un error (nunca se sigue de largo con un {} que despues se
//     guardaria encima de lo corrupto).
const BACKUPS_DIR = path.join(DATA_DIR, 'backups', 'sessions');
const MAX_BACKUPS = 20;

function listBackupFiles() {
  try {
    return fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort(); // los nombres son ISO 8601 con caracteres seguros, ordenan cronologicamente
  } catch (err) {
    return [];
  }
}

// Guarda una copia del contenido ACTUAL de sessions.json (antes de
// sobrescribirlo) con una marca de tiempo en el nombre, y recorta las copias
// mas viejas para no llenar el disco. Si sessions.json todavia no existe (primer
// arranque) no hay nada que respaldar.
function backupCurrentFile() {
  let current;
  try {
    current = fs.readFileSync(STATE_PATH, 'utf8');
  } catch (err) {
    return; // nada que respaldar todavia
  }
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(BACKUPS_DIR, `sessions-${stamp}.json`), current);

  const files = listBackupFiles();
  const excess = files.length - MAX_BACKUPS;
  for (let i = 0; i < excess; i++) {
    try {
      fs.unlinkSync(path.join(BACKUPS_DIR, files[i]));
    } catch (err) {
      // si ya no esta, no importa
    }
  }
}

// Busca, de la mas nueva a la mas vieja, la primera copia de seguridad que
// todavia sea JSON valido. Devuelve el objeto de sesiones restaurado, o null
// si no hay ninguna copia utilizable.
function tryRestoreFromBackup() {
  const files = listBackupFiles().reverse();
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(BACKUPS_DIR, f), 'utf8'));
      console.error(`AVISO: sessions.json estaba corrupto. Se restauro desde la copia de seguridad ${f}. Revisar el disco/los reinicios del servicio.`);
      return parsed;
    } catch (err) {
      continue; // esa copia tambien esta corrupta, probar la anterior
    }
  }
  return null;
}

function loadAll() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {}; // primera vez: todavia no hay archivo, es normal
    throw err; // otro error de lectura (permisos, disco): no lo escondemos
  }

  try {
    return JSON.parse(raw);
  } catch (parseErr) {
    const restored = tryRestoreFromBackup();
    if (restored !== null) return restored;
    // Sin ninguna copia utilizable: mejor fallar ruidosamente que sobrescribir
    // el archivo corrupto con un objeto vacio y perder todo para siempre.
    throw new Error(`sessions.json esta corrupto y no hay ninguna copia de seguridad valida para restaurar: ${parseErr.message}`);
  }
}

function saveAll(sessions) {
  // FASE 1 (H04): copia de seguridad del contenido anterior antes de tocar el
  // archivo, y escritura atomica (archivo temporal + rename, que en el mismo
  // filesystem es una operacion atomica) para que una interrupcion a mitad de
  // camino (reinicio, caida del proceso) nunca deje sessions.json a medio
  // escribir/corrupto.
  backupCurrentFile();
  const tmpPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmpPath, STATE_PATH);
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

// FASE 1 (H03): antes esto reemplazaba TODA la sesion por una en blanco,
// borrando historial, ficha del pedido (card), codigo de anuncio original,
// fecha de venta y de aviso de envio — un cliente que ya habia comprado y
// solo escribia "menu" para volver a ver el catalogo perdia su pedido
// entero. Ahora "reiniciar" solo vuelve a poner el flujo conversacional en
// el arranque (para que el bot vuelva a saludar/guiar desde cero), pero
// conserva todo lo demas: historial, card, adCode, soldAt,
// shippingNotifiedAt, etc. Un borrado permanente de verdad (si alguna vez
// hace falta) tiene que ser una accion administrativa explicita y separada
// desde el panel, no un efecto secundario de que el cliente escriba "menu".
function resetSession(phone) {
  const sessions = loadAll();
  const previous = sessions[phone] || blankSession();
  sessions[phone] = {
    ...previous,
    step: 'START',
    updatedAt: new Date().toISOString(),
  };
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

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
const { applyStatusUpdate } = require('./messageStatus');

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
// Cada copia es el sessions.json ENTERO (con miles de chats pesa varios MB):
// antes se guardaba una copia en CADA guardado (cada mensaje) y se conservaban
// 20, con lo que el disco del servidor se llenaba ("ENOSPC: no space left on
// device"), el bot se caia al guardar un mensaje y se reiniciaba en bucle.
// Ahora: pocas copias y separadas en el tiempo.
const MAX_BACKUPS = 5;
const BACKUP_MIN_INTERVAL_MS = 30 * 60 * 1000;

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
// Borra las copias mas viejas y deja solo las ultimas `keep`.
function pruneBackups(keep) {
  const files = listBackupFiles();
  const excess = files.length - keep;
  for (let i = 0; i < excess; i++) {
    try {
      fs.unlinkSync(path.join(BACKUPS_DIR, files[i]));
    } catch (err) {
      // si ya no esta, no importa
    }
  }
}

function newestBackupAgeMs() {
  const files = listBackupFiles();
  if (!files.length) return Infinity;
  try {
    return Date.now() - fs.statSync(path.join(BACKUPS_DIR, files[files.length - 1])).mtimeMs;
  } catch (err) {
    return Infinity;
  }
}

function backupCurrentFile() {
  // Si ya hay una copia reciente, no se hace otra: no hace falta una copia por
  // cada mensaje y cada una ocupa todo el archivo de sesiones.
  if (newestBackupAgeMs() < BACKUP_MIN_INTERVAL_MS) return;
  let current;
  try {
    current = fs.readFileSync(STATE_PATH, 'utf8');
  } catch (err) {
    return; // nada que respaldar todavia
  }
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(BACKUPS_DIR, `sessions-${stamp}.json`);
  try {
    fs.writeFileSync(target, current);
  } catch (err) {
    // Disco lleno: se borran copias viejas y se sigue. La copia de seguridad
    // NUNCA debe impedir guardar el mensaje del cliente.
    try { fs.unlinkSync(target); } catch (e) { /* puede no existir */ }
    pruneBackups(1);
    console.error('AVISO: no se pudo crear la copia de seguridad de sesiones:', err.message);
    return;
  }
  pruneBackups(MAX_BACKUPS);
}

// Al arrancar: si el disco ya esta lleno de copias viejas, se liberan antes
// de que el bot intente guardar su primer mensaje.
try {
  pruneBackups(MAX_BACKUPS);
  fs.unlinkSync(`${STATE_PATH}.tmp`);
} catch (err) {
  // no hay nada que limpiar
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
  try {
    backupCurrentFile();
  } catch (err) {
    console.error('AVISO: fallo la copia de seguridad de sesiones, se sigue guardando:', err.message);
  }
  const tmpPath = `${STATE_PATH}.tmp`;
  const data = JSON.stringify(sessions);
  const write = () => {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, STATE_PATH);
  };
  try {
    write();
  } catch (err) {
    if (err.code !== 'ENOSPC') throw err;
    // Disco lleno: se libera lo que se pueda (temporal, copias, medios viejos)
    // y se reintenta UNA vez. Si vuelve a fallar se relanza: quien llama tiene
    // que saber que no se guardo.
    try { fs.unlinkSync(tmpPath); } catch (e) { /* puede no existir */ }
    pruneBackups(0);
    try {
      const janitor = require('./diskJanitor'); // require perezoso: evita ciclo de modulos
      janitor.markEnospc();
      janitor.runOnce({ aggressive: true });
    } catch (e) {
      console.error('AVISO: fallo la limpieza de emergencia del disco:', e.message);
    }
    write();
  }
  readCache = null;
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
    // Datos del pedido en curso. Se separan de `card`, que conserva datos
    // historicos y personales del cliente entre compras.
    currentOrder: null,
    newOrderPending: false,
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
    currentOrder: null,
    newOrderPending: true,
    linkedProductId: null,
    orderDataRequested: false,
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

// Marca el ULTIMO mensaje del bot como "se mando tambien como nota de voz"
// (audioSent: true). No agrega mensajes nuevos al historial (la IA y las
// reglas leen el historial), solo una marca en el mensaje de texto al que
// acompano el audio; el panel muestra un aviso en esa burbuja.
function markLastAssistantAudio(phone) {
  const sessions = loadAll();
  const session = sessions[phone];
  if (!session || !Array.isArray(session.history)) return;
  const history = [...session.history];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') {
      history[i] = { ...history[i], audioSent: true };
      sessions[phone] = { ...session, history, audioRepliesCount: (session.audioRepliesCount || 0) + 1 };
      saveAll(sessions);
      return;
    }
  }
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

// Lectura cacheada SOLO para el panel (listado, pipeline, detalle de una
// charla). Con miles de conversaciones, sessions.json pesa varios MB y el
// panel lo volvia a leer y parsear entero cada 4 segundos por cada pestaña
// abierta (y otra vez para la charla abierta): en el celular eso era lo que
// hacia todo lento. Aca se parsea una sola vez y se reutiliza mientras el
// archivo no cambie (mismo mtime y tamaño; cualquier guardado de este u otro
// proceso lo invalida). OJO: lo que devuelve es compartido, es de SOLO
// LECTURA -- nadie debe modificarlo. Todo lo que escribe sigue pasando por
// loadAll()/saveAll() como siempre.
let readCache = null;
function listSessionsCached() {
  let stat;
  try {
    stat = fs.statSync(STATE_PATH);
  } catch (err) {
    if (err.code === 'ENOENT') return { list: [], byPhone: new Map() };
    throw err;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  if (readCache && readCache.key === key) return readCache;
  const list = listSessions();
  const byPhone = new Map(list.map((s) => [String(s.phone), s]));
  readCache = { key, list, byPhone };
  return readCache;
}

// FASE 3h: el borrado PERMANENTE de verdad que ya anticipaba el comentario
// de resetSession() de arriba -- una accion administrativa explicita y
// separada, nunca automatica ni efecto secundario de otra cosa. Borra del
// archivo las conversaciones cuyo telefono este en la lista dada (se elige
// la lista de telefonos afuera, en el panel, filtrando por etapa u otro
// criterio -- esta funcion no sabe de etapas, solo borra lo que se le pide).
// Como saveAll() ya hace una copia de seguridad completa de sessions.json
// ANTES de escribir (ver backupCurrentFile arriba), un borrado por error
// sigue siendo recuperable a mano desde data/backups/sessions/ mientras esa
// copia no se haya rotado (se guardan las ultimas 20). No hay una funcion de
// "restaurar una sola conversacion": si hace falta, es leer el JSON de la
// copia y sacar esa entrada a mano.
function deleteSessions(phones) {
  const sessions = loadAll();
  let deleted = 0;
  for (const phone of Array.isArray(phones) ? phones : []) {
    if (Object.prototype.hasOwnProperty.call(sessions, phone)) {
      delete sessions[phone];
      deleted += 1;
    }
  }
  if (deleted > 0) saveAll(sessions);
  return deleted;
}

// FASE 5 (H35): aplica un evento de status de WhatsApp (sent/delivered/
// read/failed, del webhook de Meta) al mensaje de plantilla que corresponda
// (buscado por wamid), y guarda sessions.json solo si de verdad cambio
// algo. La logica de "que hacer con el evento" vive en messageStatus.js
// (pura, sin tocar disco) para poder probarla sin depender de
// sessions.json; esta funcion es la unica que la conecta con la
// persistencia real.
function applyTemplateStatus(statusEvent) {
  const sessions = loadAll();
  const resultado = applyStatusUpdate(sessions, statusEvent);
  if (resultado.updated) saveAll(sessions);
  return resultado;
}

// Archiva los historiales viejos de chats inactivos para que sessions.json no
// crezca sin tope. Solo toca sesiones SIN mensajes en los ultimos `olderThanMs`
// (se mide por el `at` del ultimo mensaje, no por updatedAt, que se pisa con
// cualquier updateSession) y con mas de `keepLast` mensajes: lo mas viejo va a
// <archiveDir>/<phone>.jsonl.gz (se agrega al final) y la sesion conserva los
// ultimos `keepLast`. Una sola lectura y un solo saveAll.
function compactHistories({ olderThanMs, keepLast = 150, archiveDir, now = Date.now() } = {}) {
  const zlib = require('zlib');
  const dir = archiveDir || path.join(DATA_DIR, 'archive');
  const sessions = loadAll();
  let touched = 0;
  let archived = 0;
  for (const [phone, s] of Object.entries(sessions)) {
    const h = Array.isArray(s.history) ? s.history : [];
    if (h.length <= keepLast) continue;
    const lastAt = Date.parse(h[h.length - 1]?.at || '');
    if (!Number.isFinite(lastAt) || now - lastAt < olderThanMs) continue;
    const moved = h.slice(0, h.length - keepLast);
    const safeName = String(phone).replace(/[^A-Za-z0-9._-]/g, '_');
    fs.mkdirSync(dir, { recursive: true });
    // Un .gz con varios miembros concatenados es un .gz valido: se agrega sin releer.
    fs.appendFileSync(path.join(dir, `${safeName}.jsonl.gz`), zlib.gzipSync(moved.map((m) => JSON.stringify(m)).join('\n') + '\n'));
    sessions[phone] = { ...s, history: h.slice(h.length - keepLast), historyArchivedCount: (s.historyArchivedCount || 0) + moved.length };
    touched += 1;
    archived += moved.length;
  }
  if (touched > 0) saveAll(sessions);
  return { sessions: touched, messages: archived };
}

module.exports = {
  getSession,
  compactHistories,
  updateSession,
  resetSession,
  appendMessage,
  markLastAssistantAudio,
  setPaused,
  setStage,
  unlockStage,
  markFollowUp,
  listSessions,
  listSessionsCached,
  deleteSessions,
  applyTemplateStatus,
};

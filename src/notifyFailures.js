'use strict';

// S6, bug real: el bot marcaba el aviso como enviado cuando Meta aceptaba la
// plantilla (devolvia wamid). Si despues llegaba por webhook status "failed"
// (plantilla pausada o recategorizada, 131049, numero invalido...), el fallo
// solo quedaba en el historial: nadie lo reintentaba ni se enteraba.
//
// Ahora cada aviso automatico guarda que marca corresponde a su wamid
// (session.notifyWamids) y, cuando Meta lo rechaza:
//  - 131047 (fuera de la ventana de 24 h) o 131026 (no se pudo entregar): se
//    libera la marca para que el siguiente reintento o el reconciliador lo
//    intente otra vez, como maximo 2 veces por aviso (notifyRetries).
//  - 131049, 131050 u otros: no se reintenta; queda en notifyFailed y el chat
//    aparece en "Llamar hoy" con motivo "aviso no entregado".
//  - mas de 5 fallos de una misma plantilla en un dia: push a Jere.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./dataDir');

const MAX_WAMIDS = 20;
const MAX_RETRIES = 2;
const RETRYABLE = new Set([131047, 131026]);
const DAILY_ALERT_THRESHOLD = 5;
const COUNTS_PATH = () => path.join(DATA_DIR, 'notify-failures.json');

// Devuelve el patch con el wamid registrado (para updateSession).
function rememberWamid(session, wamid, marker) {
  if (!wamid || !marker) return {};
  const entries = Object.entries({ ...(session?.notifyWamids || {}), [wamid]: marker }).slice(-MAX_WAMIDS);
  return { notifyWamids: Object.fromEntries(entries) };
}

function caracasDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function loadCounts() {
  try {
    return JSON.parse(fs.readFileSync(COUNTS_PATH(), 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveCounts(counts) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(COUNTS_PATH(), JSON.stringify(counts));
  } catch (err) {
    console.error('No se pudo guardar el conteo de fallos de plantillas:', err.message);
  }
}

// Cuenta el fallo de la plantilla en el dia. Devuelve true si hay que avisar.
function countTemplateFailure(templateName, code, now = new Date()) {
  const day = caracasDay(now);
  const counts = loadCounts();
  const today = counts.day === day ? counts : { day, templates: {} };
  const key = String(templateName || 'desconocida');
  const row = today.templates[key] || { count: 0, alerted: false, lastCode: null };
  row.count += 1;
  row.lastCode = code;
  let alert = false;
  if (row.count > DAILY_ALERT_THRESHOLD && !row.alerted) {
    row.alerted = true;
    alert = true;
  }
  today.templates[key] = row;
  saveCounts(today);
  return alert;
}

// Muta la sesion (dentro del mismo guardado de state.applyTemplateStatus).
// msg: el mensaje del historial con la plantilla. Devuelve lo que hizo.
function applyFailure(session, msg, statusEvent, { now = new Date(), notifyAdmin } = {}) {
  if (!session || statusEvent?.status !== 'failed') return { action: 'none' };
  const wamid = statusEvent.id;
  const marker = session.notifyWamids?.[wamid];
  if (!marker) return { action: 'none' };
  const error = Array.isArray(statusEvent.errors) ? statusEvent.errors[0] || {} : {};
  const code = Number(error.code) || null;
  const nowIso = now.toISOString();
  const templateName = msg?.template?.name || null;
  let action;
  const retries = Number(session.notifyRetries?.[marker]) || 0;
  if (RETRYABLE.has(code) && retries < MAX_RETRIES) {
    session[marker] = null;
    session[`${marker}FailedAt`] = nowIso;
    session.notifyRetries = { ...(session.notifyRetries || {}), [marker]: retries + 1 };
    action = 'released';
  } else {
    session.notifyFailed = { ...(session.notifyFailed || {}), [marker]: { code, at: nowIso, template: templateName } };
    action = 'call_today';
  }
  if (countTemplateFailure(templateName, code, now)) {
    try {
      const notify = notifyAdmin || ((title, body) => require('./push').notifyAdmin(title, body));
      const p = notify('Plantilla fallando', `La plantilla ${templateName || '-'} está fallando (código ${code || '-'}). Revisa su estado en WhatsApp Manager.`);
      if (p && p.catch) p.catch(() => {});
    } catch (err) {
      console.error('No se pudo avisar la plantilla que falla:', err.message);
    }
  }
  return { action, marker, code };
}

// Filas extra para "Llamar hoy": avisos que Meta rechazo y que nadie llamo
// despues del fallo.
function callTodayRows(sessions) {
  const rows = [];
  for (const s of sessions || []) {
    if (['entregado', 'devolucion'].includes(s.stage)) continue;
    const failed = Object.entries(s.notifyFailed || {});
    if (!failed.length) continue;
    const [marker, info] = failed.sort((a, b) => String(b[1]?.at).localeCompare(String(a[1]?.at)))[0];
    if (s.phoneContactAt && String(s.phoneContactAt) > String(info?.at || '')) continue;
    rows.push({
      phone: s.phone, name: s.name || s.card?.nombre || '', agencia: s.card?.agencia || '',
      deadline: null, daysLeft: -1, motivo: 'aviso no entregado', marker, code: info?.code || null,
    });
  }
  return rows;
}

module.exports = { rememberWamid, applyFailure, callTodayRows, countTemplateFailure, MAX_RETRIES };

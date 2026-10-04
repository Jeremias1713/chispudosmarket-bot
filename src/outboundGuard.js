// Un solo lugar que decide si un envio AUTOMATICO (remarketing, recordatorios,
// masivos, avisos de envio) puede salir. Motivo: la calidad del numero de Meta
// baja con bloqueos y reportes; los reenvios en bucle (marca guardada DESPUES
// de enviar, con el disco lleno), la falta de opt-out y los topes inexistentes
// eran las causas probables.
//
// Patron obligatorio para quien manda (ver docs de cada modulo):
//   1) canSendAutomatic  2) reserveAutomatic + marca ANTES de enviar
//   3) enviar            4) appendMessage en su propio try/catch
const { getSettings } = require('./settings');
const { updateSession } = require('./state');

const MARKETING_KINDS = ['remarketing', 'pickup_reminder', 'broadcast'];
const TRANSACTIONAL_KINDS = ['shipping', 'arrival', 'delivered', 'novelty', 'return_pending', 'order_confirm', 'last_notice', 'return_reason'];
const TIME_ZONE = 'America/Caracas';

function caracasParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const v = (t) => parts.find((p) => p.type === t)?.value || '';
  return { date: `${v('year')}-${v('month')}-${v('day')}`, hour: Number(v('hour')) };
}

function isMarketing(kind) {
  return MARKETING_KINDS.includes(kind);
}

// Devuelve { ok: true } o { ok: false, reason }.
function canSendAutomatic(session, kind, now = new Date(), settings = getSettings()) {
  if (require('./diskJanitor').isDiskCritical()) return { ok: false, reason: 'disco_critico' };
  if (session?.optOut === true && isMarketing(kind)) return { ok: false, reason: 'opt_out' };
  if (settings.qualityGuardActive === true && isMarketing(kind)) return { ok: false, reason: 'calidad_en_riesgo' };
  const { date, hour } = caracasParts(now);
  // AUTO_SEND_ANYTIME=1 desactiva solo el horario (lo usan las pruebas, que
  // corren a cualquier hora del dia).
  if (process.env.AUTO_SEND_ANYTIME !== '1') {
    const start = Number(settings.autoSendHourStart ?? 8);
    const end = Number(settings.autoSendHourEnd ?? 20);
    if (hour < start || hour >= end) return { ok: false, reason: 'fuera_de_horario' };
  }
  if (isMarketing(kind)) {
    const max = Number(settings.maxAutoSendsPerDay ?? 2);
    const a = session?.autoSends;
    if (a && a.date === date && Number(a.count || 0) >= max) return { ok: false, reason: 'tope_diario' };
  }
  return { ok: true };
}

// Nuevo valor de session.autoSends con este envio sumado (sin guardar).
function nextAutoSends(session, kind, now = new Date()) {
  const { date } = caracasParts(now);
  const current = session?.autoSends && session.autoSends.date === date ? session.autoSends : { date, count: 0, kinds: [] };
  return { date, count: Number(current.count || 0) + 1, kinds: [...(current.kinds || []), kind] };
}

// Suma el envio al contador del dia. Se llama ANTES de enviar. Si el guardado
// falla, el error se propaga: quien llama NO debe mandar. `update` permite
// inyectar otro updateSession (pruebas).
function reserveAutomatic(phone, kind, now = new Date(), session = null, update = updateSession) {
  const autoSends = nextAutoSends(session, kind, now);
  update(phone, { autoSends });
  return autoSends;
}

module.exports = { canSendAutomatic, reserveAutomatic, nextAutoSends, MARKETING_KINDS, TRANSACTIONAL_KINDS, caracasParts };

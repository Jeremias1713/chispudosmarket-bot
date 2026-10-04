// Fase 7C: fecha limite de retiro. Tealca guarda el paquete N dias; pasado ese
// plazo lo devuelve. La fecha la calcula el CODIGO (la IA nunca la inventa) y
// solo existe si Jere cargo los dias de guarda (tealcaStorageDays).
const { getSettings } = require('./settings');
const calendar = require('./calendar');

// Dia (YYYY-MM-DD, Caracas) en que vence el plazo, contado desde el aviso de
// llegada. null si falta el dato de dias o la fecha de llegada.
function deadlineFor(session, settings = getSettings()) {
  const days = Number(settings.tealcaStorageDays);
  if (!Number.isFinite(days) || days < 1 || settings.tealcaStorageDays === null) return null;
  const arrival = session?.arrivalNotifiedAt ? calendar.localParts(session.arrivalNotifiedAt)?.ymd : session?.pickupReminderAnchorDate;
  if (!arrival) return null;
  return settings.tealcaStorageBusinessDays === true
    ? calendar.addBusinessDays(arrival, days, settings)
    : calendar.addDays(arrival, days);
}

// "el viernes 16 de octubre" o '' si no hay fecha limite.
function deadlineText(session, settings = getSettings()) {
  const d = deadlineFor(session, settings);
  return d ? `el ${calendar.formatDayShort(d)}` : '';
}

module.exports = { deadlineFor, deadlineText };

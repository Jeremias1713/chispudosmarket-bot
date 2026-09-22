const { listSessions, updateSession, appendMessage } = require('./state');
const { getSettings, updateSettings } = require('./settings');
const { sendTemplateWithSnapshot } = require('./templateSend');
const { placeholderValues } = require('./shipping');

const CHECK_EVERY_MS = 15 * 60 * 1000;
const TIME_ZONE = 'America/Caracas';
let timer = null;
let running = false;

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return { date: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')) };
}

function eligible(session, settings, now = new Date()) {
  if (!settings.pickupReminderEnabled || session.stage !== 'esperando_retiro') return false;
  if (!session.arrivalNotifiedAt) return false;
  if (!settings.pickupReminderActivatedAt || new Date(session.arrivalNotifiedAt) < new Date(settings.pickupReminderActivatedAt)) return false;
  const today = localParts(now).date;
  if (localParts(new Date(session.arrivalNotifiedAt)).date === today) return false;
  if (session.pickupReminderLastDate === today) return false;
  return Number(session.pickupReminderCount || 0) < Number(settings.pickupReminderMaxDays || 5);
}

async function sendReminder(session, settings, now = new Date()) {
  const values = placeholderValues(session);
  const params = [values.nombre, values.producto, values.guia, values.monto];
  const templateName = settings.pickupTemplateName || 'pedido_ha_llegado_a_tealca';
  const { wamid, snapshot } = await sendTemplateWithSnapshot({
    to: session.phone,
    templateName,
    languageCode: settings.pickupTemplateLanguage || 'es',
    values: params,
  });
  appendMessage(session.phone, 'human', `[recordatorio automatico] ${templateName}`, {
    template: { name: templateName, origin: 'seguimiento', params, snapshot, wamid, status: 'sent' },
  });
  updateSession(session.phone, {
    pickupReminderLastDate: localParts(now).date,
    pickupReminderCount: Number(session.pickupReminderCount || 0) + 1,
  });
  return { phone: session.phone, sent: true };
}

async function run(now = new Date()) {
  if (running) return [];
  running = true;
  try {
    let settings = getSettings();
    if (!settings.pickupReminderActivatedAt) {
      settings = updateSettings({ pickupReminderActivatedAt: now.toISOString() });
      return [];
    }
    if (!settings.pickupReminderEnabled || localParts(now).hour !== Number(settings.pickupReminderHour ?? 10)) return [];
    const results = [];
    for (const session of listSessions().filter((row) => eligible(row, settings, now))) {
      try {
        results.push(await sendReminder(session, settings, now));
      } catch (error) {
        console.error('No se pudo mandar recordatorio de retiro a', session.phone, error.response?.data || error.message);
        results.push({ phone: session.phone, sent: false, error: error.message });
      }
    }
    return results;
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  run().catch((error) => console.error('Recordatorios de retiro:', error.message));
  timer = setInterval(() => run().catch((error) => console.error('Recordatorios de retiro:', error.message)), CHECK_EVERY_MS);
  timer.unref?.();
}

module.exports = { start, run, eligible, localParts, sendReminder };

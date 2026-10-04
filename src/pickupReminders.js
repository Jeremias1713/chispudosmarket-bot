// Recordatorios de retiro: a los clientes cuyo pedido sigue en la oficina
// ("esperando_retiro") se les manda la plantilla de "tu pedido ya llego" los
// dias 1, 3 y 5 despues del aviso de llegada (maximo 3 en total), a partir de
// la hora configurada (10:00 Venezuela). Antes era uno por dia hasta 10
// veces: demasiado para quien ya sabe que su pedido llego, y una de las
// causas probables de la baja de calidad del numero en Meta.
//
// Para no escribirle a alguien que YA retiro, antes de recordar se confirma
// con DroPanas que el pedido sigue "En oficina":
//   - DroPanas dice que sigue en oficina  -> se recuerda si hoy toca (1, 3 o 5).
//   - DroPanas dice otro estado (entregado, devolucion...) -> no se recuerda.
//   - No se pudo consultar ese pedido -> solo se recuerda si el bot mismo
//     aviso la llegada (arrivalNotifiedAt).
// Si un dia de la lista se perdio (servidor caido) no se recupera: se espera
// al siguiente. Si el cliente escribio en las ultimas 48 h esta en
// conversacion y no se le recuerda. Nunca se manda dos veces el mismo dia.
// La marca se guarda ANTES de enviar: es preferible perder un recordatorio a
// mandarlo dos veces si el guardado falla despues.
const { listSessions, updateSession, appendMessage } = require('./state');
const { getSettings, updateSettings } = require('./settings');
const { sendTemplateWithSnapshot } = require('./templateSend');
const { placeholderValues } = require('./shipping');
const { canSendAutomatic, nextAutoSends } = require('./outboundGuard');

const CHECK_EVERY_MS = 15 * 60 * 1000;
const TIME_ZONE = 'America/Caracas';
// Despues de esta hora ya no se manda nada (si el servidor estuvo caido a la
// hora configurada, se recupera en cuanto vuelve, pero nunca de noche).
const LAST_HOUR = 19;
const CONFIRMED_MAX_REMINDERS = 3;
const REMINDER_DAYS = [1, 3, 5];

// Fase 7C/7D: si Jere cargo los dias de guarda de Tealca y el ultimo aviso esta
// prendido, el recordatorio del dia 5 lo reemplaza el ULTIMO AVISO (lastNotice),
// que sale la vispera de la fecha limite.
function reminderDays(session, settings) {
  const replaced = settings.lastNoticeEnabled === true && require('./pickupDeadline').deadlineFor(session, settings);
  return replaced ? [1, 3] : REMINDER_DAYS;
}
const MAX_FAILURES_PER_DAY = 3;
const OFFICE_STATUSES = new Set(['en oficina', 'en agencia', 'listo para retirar']);
const DP_GUIDE = /^DP(\d+)$/i;
const MAX_PER_ID_LOOKUPS = 40;
let timer = null;
let running = false;
// Conversaciones ya resueltas hoy (recordadas o descartadas). Asi, en los
// chequeos de cada 15 minutos no se vuelve a consultar DroPanas por ellas.
let decided = { date: null, phones: new Set() };

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return { date: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')) };
}

function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000);
}

function fold(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// Cuantos recordatorios lleva ESTE pedido (si la guia cambio por una compra
// nueva, el contador vuelve a cero).
function reminderCount(session) {
  const guia = String(session.card?.guia || '');
  if (session.pickupReminderGuia && session.pickupReminderGuia !== guia) return 0;
  return Number(session.pickupReminderCount || 0);
}

// Fecha (Caracas) desde la que se cuentan los dias: la del aviso de llegada o,
// si DroPanas confirma la oficina sin que el bot haya avisado, la que se
// guardo el primer dia que se vio (ese dia cuenta como dia 0).
function anchorDate(session) {
  if (session.arrivalNotifiedAt) return localParts(new Date(session.arrivalNotifiedAt)).date;
  return session.pickupReminderAnchorDate || null;
}

// El cliente escribio despues del aviso/ultimo recordatorio y hace menos de
// 48 h: esta conversando, si quiere algo lo pide.
function clientIsTalking(session, now) {
  const history = Array.isArray(session.history) ? session.history : [];
  let lastUser = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'user') { lastUser = Date.parse(history[i].at || '') || 0; break; }
  }
  if (!lastUser || now.getTime() - lastUser >= 48 * 3600 * 1000) return false;
  const arrival = Date.parse(session.arrivalNotifiedAt || '') || 0;
  const lastReminder = session.pickupReminderLastDate ? Date.parse(`${session.pickupReminderLastDate}T00:00:00-04:00`) || 0 : 0;
  return lastUser > Math.max(arrival, lastReminder);
}

// confirmation: 'en_oficina' | 'otro_estado' | null (no se pudo consultar).
function eligible(session, settings, now = new Date(), confirmation = null) {
  if (!settings.pickupReminderEnabled || session.stage !== 'esperando_retiro') return false;
  if (!String(session.card?.guia || '').trim()) return false;
  const today = localParts(now).date;
  if (session.pickupReminderLastDate === today) return false;
  if (session.pickupReminderFailDate === today && Number(session.pickupReminderFailCount || 0) >= MAX_FAILURES_PER_DAY) return false;
  if (confirmation === 'otro_estado') return false;
  // Sin confirmacion de DroPanas: solo si el bot mismo aviso la llegada.
  if (confirmation !== 'en_oficina' && !session.arrivalNotifiedAt) return false;
  const anchor = anchorDate(session);
  if (!anchor) return false;
  const days = reminderDays(session, settings);
  const index = days.indexOf(daysBetween(anchor, today));
  if (index === -1) return false;
  const count = reminderCount(session);
  // Maximo 3 (2 si el dia 5 lo reemplaza el ultimo aviso); si se perdio un dia anterior, este igual sale.
  if (count >= days.length || count > index) return false;
  if (clientIsTalking(session, now)) return false;
  return true;
}

function orderKeys(session) {
  const ids = new Set();
  const guias = new Set();
  const card = session.card || {};
  for (const guia of [card.guia, card.guiaDropanas]) {
    const value = String(guia || '').trim().toUpperCase();
    if (!value) continue;
    guias.add(value);
    const dp = value.match(DP_GUIDE);
    if (dp) ids.add(dp[1]);
  }
  if (card.dropanasId) ids.add(String(card.dropanasId));
  if (session.dropanasOrder?.id) ids.add(String(session.dropanasOrder.id));
  return { ids: [...ids], guias: [...guias] };
}

// Consulta a DroPanas (solo lectura) el estado actual de cada pedido. Primero
// intenta el listado completo; si no esta autorizado, consulta uno por uno los
// pedidos cuyo numero de orden se conoce. Devuelve Map phone -> { state, order }.
async function officeStatus(sessions, deps) {
  const result = new Map();
  result.apiOk = false;
  let byId = null;
  let byGuia = null;
  let perIdLookups = 0;
  try {
    const listed = await deps.fetchOrders();
    byId = new Map();
    byGuia = new Map();
    for (const order of listed.orders || []) {
      byId.set(String(order.dropanasId), order);
      if (order.guia) byGuia.set(String(order.guia).trim().toUpperCase(), order);
    }
    result.apiOk = true;
  } catch (error) {
    console.error('Recordatorios de retiro: no se pudo leer el listado de DroPanas:', error.message);
  }
  for (const session of sessions) {
    const keys = orderKeys(session);
    let order = null;
    if (byId) {
      for (const id of keys.ids) order = order || byId.get(id) || null;
      for (const guia of keys.guias) order = order || byGuia.get(guia) || null;
    } else if (keys.ids.length && perIdLookups < MAX_PER_ID_LOOKUPS) {
      // DroPanas limita a 100 consultas por minuto: consultar pedido por
      // pedido es solo un respaldo, con tope y con pausa entre consultas.
      perIdLookups += 1;
      if (perIdLookups > 1) await new Promise((resolve) => setTimeout(resolve, deps.lookupPauseMs ?? 1500));
      try {
        order = (await deps.fetchOrder(keys.ids[0])).order;
        result.apiOk = true;
      } catch (error) {
        order = null;
      }
    }
    if (!order) {
      result.set(session.phone, { state: null, order: null });
      continue;
    }
    result.set(session.phone, {
      state: OFFICE_STATUSES.has(fold(order.estadoPedido)) ? 'en_oficina' : 'otro_estado',
      order,
    });
  }
  return result;
}

// Si DroPanas ya tiene la guia real de la transportadora y la conversacion
// sigue con la interna "DP<orden>" de ESE MISMO pedido, se actualiza, para que
// el recordatorio muestre el numero que sirve en la agencia.
function upgradeGuide(session, order, deps) {
  const current = String(session.card?.guia || '').trim().toUpperCase();
  const real = String(order?.guia || '').trim();
  if (!real || DP_GUIDE.test(real) || current === real.toUpperCase()) return session;
  if (current !== `DP${order.dropanasId}`) return session;
  const card = { ...(session.card || {}), guia: real, dropanasId: String(order.dropanasId) };
  if (!card.guiaDropanas) card.guiaDropanas = session.card.guia;
  return deps.updateSession(session.phone, { card }) || { ...session, card };
}

async function sendReminder(session, settings, now = new Date(), deps = defaultDeps()) {
  const guard = canSendAutomatic(session, 'pickup_reminder', now, settings);
  if (!guard.ok) return { phone: session.phone, sent: false, reason: guard.reason };
  const values = placeholderValues(session);
  // Fase 7C: con plantilla de fecha limite aprobada y fecha conocida, el
  // recordatorio dice hasta cuando puede retirar. Sin eso, la de siempre.
  const limite = require('./pickupDeadline').deadlineText(session, settings);
  const useDeadline = Boolean(settings.pickupDeadlineTemplateName && limite);
  const params = useDeadline
    ? [values.nombre, values.producto, values.agencia, limite]
    : [values.nombre, values.producto, values.guia, values.monto];
  const templateName = useDeadline ? settings.pickupDeadlineTemplateName : (settings.pickupTemplateName || 'pedido_ha_llegado_a_tealca');
  const templateLanguage = useDeadline ? (settings.pickupDeadlineTemplateLanguage || 'es') : (settings.pickupTemplateLanguage || 'es');
  const previousCount = reminderCount(session);
  // La marca va ANTES de enviar. Si este guardado falla, se propaga el error y
  // NO se manda nada.
  deps.updateSession(session.phone, {
    pickupReminderLastDate: localParts(now).date,
    pickupReminderCount: previousCount + 1,
    pickupReminderGuia: String(session.card?.guia || ''),
    autoSends: nextAutoSends(session, 'pickup_reminder', now),
  });
  let wamid;
  let snapshot;
  try {
    ({ wamid, snapshot } = await deps.sendTemplateWithSnapshot({
      to: session.phone,
      templateName,
      languageCode: templateLanguage,
      values: params,
    }));
  } catch (error) {
    // No salio: el dia queda marcado (no se reintenta hoy) pero el recordatorio
    // no cuenta para el maximo de 3.
    try { deps.updateSession(session.phone, { pickupReminderCount: previousCount }); } catch (e) { /* sin disco */ }
    throw error;
  }
  try {
    deps.appendMessage(session.phone, 'human', `[recordatorio automatico] ${templateName}`, {
      template: { name: templateName, origin: 'seguimiento', params, snapshot, wamid, status: 'sent' },
    });
  } catch (error) {
    console.error('El recordatorio salio pero no se pudo guardar en el historial de', `…${String(session.phone).slice(-4)}`, ':', error.message);
  }
  return { phone: session.phone, sent: true };
}

function defaultDeps() {
  const api = require('./dropanasApi');
  return {
    listSessions,
    updateSession,
    appendMessage,
    sendTemplateWithSnapshot,
    fetchOrders: () => api.fetchOrders(),
    fetchOrder: (id) => api.fetchOrder(id),
  };
}

// Calcula a quien le toca hoy, sin mandar nada. La usa run() y la vista
// previa del panel.
async function plan(now = new Date(), overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const settings = overrides.settings || getSettings();
  const today = localParts(now).date;
  const waiting = [];
  const seen = new Set();
  for (const session of deps.listSessions()) {
    if (!session?.phone || seen.has(session.phone)) continue;
    seen.add(session.phone);
    if (session.stage !== 'esperando_retiro') continue;
    if (!String(session.card?.guia || '').trim()) continue;
    if (session.pickupReminderLastDate === today) continue;
    if (!overrides.ignoreDecided && decided.date === today && decided.phones.has(session.phone)) continue;
    waiting.push(session);
  }
  const status = waiting.length ? await officeStatus(waiting, deps) : new Map();
  const due = [];
  const skipped = [];
  const needsAnchor = [];
  for (const session of waiting) {
    const info = status.get(session.phone) || { state: null, order: null };
    if (info.state === 'en_oficina' && !anchorDate(session)) needsAnchor.push(session);
    if (eligible(session, settings, now, info.state)) due.push({ session, order: info.order, confirmation: info.state });
    else skipped.push({ phone: session.phone, confirmation: info.state, estado: info.order?.estadoPedido || null });
  }
  return { date: today, due, skipped, needsAnchor, deps, settings, apiOk: Boolean(status.apiOk) };
}

async function run(now = new Date(), overrides = {}) {
  if (running) return [];
  running = true;
  try {
    let settings = overrides.settings || getSettings();
    if (!settings.pickupReminderActivatedAt && !overrides.settings) {
      settings = updateSettings({ pickupReminderActivatedAt: now.toISOString() });
    }
    if (!settings.pickupReminderEnabled) return [];
    const hour = localParts(now).hour;
    if (hour < Number(settings.pickupReminderHour ?? 10) || hour >= LAST_HOUR) return [];
    const { date, due, skipped, needsAnchor, deps, apiOk } = await plan(now, { ...overrides, settings });
    // Pedido en oficina sin aviso de llegada del bot: hoy es el dia 0.
    for (const session of needsAnchor) {
      try { deps.updateSession(session.phone, { pickupReminderAnchorDate: date }); } catch (error) { console.error('No se pudo guardar la fecha ancla de', `…${String(session.phone).slice(-4)}`, error.message); }
    }
    if (decided.date !== date) decided = { date, phones: new Set() };
    // Si DroPanas no respondio, los descartados se vuelven a mirar en el
    // proximo chequeo (puede haber sido un corte momentaneo).
    if (apiOk) for (const item of skipped) decided.phones.add(item.phone);
    const results = [];
    for (const item of due) {
      let session = item.session;
      try {
        if (item.order) session = upgradeGuide(session, item.order, deps);
        results.push(await sendReminder(session, settings, now, deps));
        decided.phones.add(session.phone);
      } catch (error) {
        console.error('No se pudo mandar recordatorio de retiro a', session.phone, error.response?.data || error.message);
        const today = localParts(now).date;
        try {
          deps.updateSession(session.phone, {
            pickupReminderFailDate: today,
            pickupReminderFailCount: (session.pickupReminderFailDate === today ? Number(session.pickupReminderFailCount || 0) : 0) + 1,
          });
        } catch (e) {
          console.error('No se pudo anotar el fallo del recordatorio de', `…${String(session.phone).slice(-4)}`, e.message);
        }
        results.push({ phone: session.phone, sent: false, error: error.message });
      }
    }
    return results;
  } finally {
    running = false;
  }
}

function resetDecided() {
  decided = { date: null, phones: new Set() };
}

function start() {
  if (timer) return;
  run().catch((error) => console.error('Recordatorios de retiro:', error.message));
  timer = setInterval(() => run().catch((error) => console.error('Recordatorios de retiro:', error.message)), CHECK_EVERY_MS);
  timer.unref?.();
}

module.exports = {
  start, run, plan, eligible, resetDecided, localParts, sendReminder, officeStatus, orderKeys,
  CONFIRMED_MAX_REMINDERS, REMINDER_DAYS, LAST_HOUR,
};

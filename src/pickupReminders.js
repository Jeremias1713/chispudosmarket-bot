// Recordatorio diario de retiro: a TODOS los clientes cuyo pedido sigue en
// la oficina ("esperando_retiro") se les manda la plantilla de "tu pedido ya
// llego" una vez por dia, a partir de la hora configurada (10:00 Venezuela).
//
// Para no escribirle a alguien que YA retiro (muchas conversaciones quedaron
// en "esperando_retiro" porque el aviso de "entregado" se perdia antes), antes
// de recordar se confirma con DroPanas que el pedido sigue "En oficina":
//   - DroPanas dice que sigue en oficina  -> se recuerda (tope de seguridad:
//     CONFIRMED_MAX_REMINDERS recordatorios por pedido).
//   - DroPanas dice otro estado (entregado, devolucion...) -> no se recuerda.
//   - No se pudo consultar ese pedido -> solo se recuerda si el bot mismo
//     aviso la llegada hace pocos dias (pickupReminderMaxDays), como antes.
// Nunca se manda dos veces el mismo dia, ni el mismo dia del aviso de llegada.
const { listSessions, updateSession, appendMessage } = require('./state');
const { getSettings, updateSettings } = require('./settings');
const { sendTemplateWithSnapshot } = require('./templateSend');
const { placeholderValues } = require('./shipping');

const CHECK_EVERY_MS = 15 * 60 * 1000;
const TIME_ZONE = 'America/Caracas';
// Despues de esta hora ya no se manda nada (si el servidor estuvo caido a la
// hora configurada, se recupera en cuanto vuelve, pero nunca de noche).
const LAST_HOUR = 19;
const CONFIRMED_MAX_REMINDERS = 10;
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

// confirmation: 'en_oficina' | 'otro_estado' | null (no se pudo consultar).
function eligible(session, settings, now = new Date(), confirmation = null) {
  if (!settings.pickupReminderEnabled || session.stage !== 'esperando_retiro') return false;
  if (!String(session.card?.guia || '').trim()) return false;
  const today = localParts(now).date;
  if (session.pickupReminderLastDate === today) return false;
  if (session.pickupReminderFailDate === today && Number(session.pickupReminderFailCount || 0) >= MAX_FAILURES_PER_DAY) return false;
  if (session.arrivalNotifiedAt && localParts(new Date(session.arrivalNotifiedAt)).date === today) return false;
  const count = reminderCount(session);
  if (confirmation === 'otro_estado') return false;
  if (confirmation === 'en_oficina') return count < CONFIRMED_MAX_REMINDERS;
  // Sin confirmacion de DroPanas: solo pedidos cuya llegada aviso el bot hace
  // pocos dias (evita escribirle a quien ya retiro hace semanas).
  if (!session.arrivalNotifiedAt) return false;
  const maxDays = Number(settings.pickupReminderMaxDays || 5);
  const age = daysBetween(localParts(new Date(session.arrivalNotifiedAt)).date, today);
  return age >= 1 && age <= maxDays && count < maxDays;
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
  const values = placeholderValues(session);
  const params = [values.nombre, values.producto, values.guia, values.monto];
  const templateName = settings.pickupTemplateName || 'pedido_ha_llegado_a_tealca';
  const { wamid, snapshot } = await deps.sendTemplateWithSnapshot({
    to: session.phone,
    templateName,
    languageCode: settings.pickupTemplateLanguage || 'es',
    values: params,
  });
  deps.appendMessage(session.phone, 'human', `[recordatorio automatico] ${templateName}`, {
    template: { name: templateName, origin: 'seguimiento', params, snapshot, wamid, status: 'sent' },
  });
  deps.updateSession(session.phone, {
    pickupReminderLastDate: localParts(now).date,
    pickupReminderCount: reminderCount(session) + 1,
    pickupReminderGuia: String(session.card?.guia || ''),
  });
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
  for (const session of waiting) {
    const info = status.get(session.phone) || { state: null, order: null };
    if (eligible(session, settings, now, info.state)) due.push({ session, order: info.order, confirmation: info.state });
    else skipped.push({ phone: session.phone, confirmation: info.state, estado: info.order?.estadoPedido || null });
  }
  return { date: today, due, skipped, deps, settings, apiOk: Boolean(status.apiOk) };
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
    const { date, due, skipped, deps, apiOk } = await plan(now, { ...overrides, settings });
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
        deps.updateSession(session.phone, {
          pickupReminderFailDate: today,
          pickupReminderFailCount: (session.pickupReminderFailDate === today ? Number(session.pickupReminderFailCount || 0) : 0) + 1,
        });
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
  CONFIRMED_MAX_REMINDERS, LAST_HOUR,
};

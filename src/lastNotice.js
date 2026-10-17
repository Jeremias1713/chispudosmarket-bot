// Fase 7D: ULTIMO AVISO antes de que Tealca devuelva el paquete, con botones,
// y motivo de devolucion.
//
// Cuando sale (settings.reminderScheduleMode):
//  - 'fixed' (por defecto): el dia 5 desde la llegada (si ese dia no se pudo,
//    al siguiente). No necesita los dias de guarda de Tealca. Tope diario
//    (lastNoticeDailyCap, el mas viejo primero) para que, al activarlo, la
//    tanda de pedidos atrasados no salga toda de golpe.
//  - 'deadline': la vispera de la fecha limite (necesita tealcaStorageDays).
// Maximo 3 mensajes de retiro por pedido en total (recordatorios + este).
//
// Reglas: solo si Jere cargo los dias de guarda (pickupDeadline) y prendio el
// interruptor; solo si DroPanas confirma que sigue "En oficina"; no se manda si
// el equipo ya hablo por telefono HOY (phoneContactAt). Todo texto es fijo: la
// IA no interviene ni calcula fechas. La marca se guarda ANTES de enviar.
const { getSettings } = require('./settings');
const { listSessions, getSession, updateSession, appendMessage } = require('./state');
const outboundGuard = require('./outboundGuard');
const calendar = require('./calendar');
const pickupDeadline = require('./pickupDeadline');
const whatsappWindow = require('./whatsappWindow');

const CHECK_EVERY_MS = 15 * 60 * 1000;
const LAST_HOUR = 19;
const PICKUP = 'ld_pickup';
const CHANGE = 'ld_change';
const CANCEL = 'ld_cancel';
// Lo que se guarda en el historial para que el panel muestre los botones.
const buttonsHistoryExtra = (...a) => require('./whatsapp').buttonsHistoryExtra(...a);
const BUTTONS = [
  { id: PICKUP, title: 'Voy a retirarlo' },
  { id: CHANGE, title: 'Cambiar agencia' },
  { id: CANCEL, title: 'Ya no lo quiero' },
];
// Un boton de plantilla puede llegar sin payload propio, solo con su texto.
const TITLE_TO_ID = { 'voy a retirarlo': PICKUP, 'cambiar agencia': CHANGE, 'ya no lo quiero': CANCEL };
const REASON_RULES = [
  ['precio', /(caro|precio|dinero|plata|pagar|no tengo|presupuesto)/i],
  ['no_necesita', /(ya no (lo )?(necesito|quiero)|no (lo )?necesito|me arrepent|cambi[eé] de opini)/i],
  ['demora', /(demor|tard|mucho tiempo|espera|lento)/i],
  ['agencia_lejos', /(lejos|agencia|oficina|no puedo ir|no tengo como)/i],
  ['no_contactaron', /(no me (llam|avis|contact|escrib)|nadie)/i],
];
let timer = null;
let running = false;

function iso(d) { return d.toISOString(); }

function buttonIdFrom(message) {
  const id = message?.interactive?.button_reply?.id || message?.button?.payload || '';
  if (/^ld_/.test(id)) return id;
  const title = String(message?.button?.text || message?.interactive?.button_reply?.title || '').trim().toLowerCase();
  return TITLE_TO_ID[title] || '';
}

const NOTICE_DAY = 5;
const MAX_PICKUP_MESSAGES = 3; // recordatorios + ultimo aviso, por pedido
const reminders = () => require('./pickupReminders');

function isFixed(settings) {
  return reminders().scheduleMode(settings) === 'fixed';
}

// Fecha (Caracas) en que toca el aviso: dia 5 desde la llegada (modo fijo) o
// la vispera de la fecha limite (modo fecha limite).
function noticeDate(session, settings) {
  if (isFixed(settings)) {
    const anchor = reminders().anchorDate(session);
    return anchor ? calendar.addDays(anchor, NOTICE_DAY) : null;
  }
  const d = pickupDeadline.deadlineFor(session, settings);
  return d ? calendar.addDays(d, -1) : null;
}

// En modo fijo vale desde el dia 5 en adelante (si el tope diario lo dejo para
// manana, sale manana); en modo fecha limite, solo la vispera.
function isNoticeDay(session, settings, now) {
  if (isFixed(settings)) {
    const day = reminders().dayNumber(session, now);
    return day !== null && day >= NOTICE_DAY;
  }
  return noticeDate(session, settings) === calendar.localParts(now).ymd;
}

function eligible(session, settings, now, confirmation) {
  if (settings.lastNoticeEnabled !== true || session.stage !== 'esperando_retiro') return false;
  // Chat pausado o cliente que pidio no recibir mensajes (outboundGuard no frena
  // el opt-out en avisos de este tipo, por eso se mira aca).
  if (session.paused === true || session.optOut === true) return false;
  if (confirmation !== 'en_oficina') return false; // sin confirmacion de DroPanas no se avisa
  const guia = String(session.card?.guia || '');
  if (!guia) return false;
  if (session.lastNoticeSentAt && session.lastNoticeGuia === guia) return false;
  if (session.lastNoticeAnswer && (!session.lastNoticeGuia || session.lastNoticeGuia === guia)) return false;
  const p = calendar.localParts(now);
  if (!isNoticeDay(session, settings, now)) return false;
  if (session.phoneContactAt && calendar.localParts(session.phoneContactAt)?.ymd === p.ymd) return false;
  // Nunca dos mensajes de retiro el mismo dia, y maximo 3 por pedido.
  const r = reminders();
  if (session.pickupReminderLastDate === r.localParts(now).date) return false;
  if (r.reminderCount(session) >= MAX_PICKUP_MESSAGES) return false;
  // OJO: el ultimo aviso NO se frena porque el cliente este conversando (eso
  // solo frena los recordatorios de los dias 1 y 3): es el mensaje importante,
  // sale una sola vez, y si la ventana de 24 h esta abierta va con botones.
  return true;
}

function noticeText(session, settings) {
  const v = require('./shipping').placeholderValues(session);
  const limite = pickupDeadline.deadlineText(session, settings);
  const monto = v.monto && v.monto !== '-' ? ` Monto a pagar al recibir: ${v.monto}.` : '';
  const plazo = limite ? ` Tienes hasta ${limite} para retirarlo.` : '';
  return `Hola ${v.nombre}, este es el último aviso sobre tu pedido de ${v.producto} (guía ${v.guia}). Lleva varios días en la oficina de Tealca y está por ser devuelto a bodega.${plazo}${monto} ¿Qué prefieres?`;
}

// Parametros de la plantilla ultimo_aviso_retiro_pedido: nombre, producto, guia, monto.
function noticeParams(session) {
  const v = require('./shipping').placeholderValues(session);
  return [v.nombre, v.producto, v.guia, v.monto];
}

async function sendNotice(session, settings, now, deps) {
  const phone = session.phone;
  const guard = outboundGuard.canSendAutomatic(session, 'last_notice', now, settings);
  if (!guard.ok) return { phone, sent: false, reason: guard.reason };
  const guia = String(session.card?.guia || '');
  const open = whatsappWindow.isWindowOpen(session, now);
  if (!open && !settings.lastNoticeTemplateName) return { phone, sent: false, reason: 'sin_plantilla' };
  // Marca ANTES de enviar (si el guardado falla, se propaga y no sale nada).
  updateSession(phone, {
    lastNoticeSentAt: iso(now), lastNoticeGuia: guia,
    autoSends: outboundGuard.nextAutoSends(session, 'last_notice', now),
  });
  const text = noticeText(session, settings);
  try {
    if (open) {
      const res = await deps.sendButtons(phone, text, BUTTONS);
      appendMessage(phone, 'assistant', text, buttonsHistoryExtra(BUTTONS, res));
    } else {
      const params = noticeParams(session);
      const { wamid, snapshot } = await deps.sendTemplateWithSnapshot({
        to: phone, templateName: settings.lastNoticeTemplateName, languageCode: settings.lastNoticeTemplateLanguage || 'es', values: params,
      });
      appendMessage(phone, 'human', `[ultimo aviso] ${settings.lastNoticeTemplateName}`, {
        template: { name: settings.lastNoticeTemplateName, origin: 'ultimo_aviso', params, snapshot, wamid, status: 'sent' },
      });
    }
  } catch (err) {
    console.error('lastNotice: no se pudo enviar a', `…${String(phone).slice(-4)}`, err.message);
    return { phone, sent: false, reason: 'error', error: err.message };
  }
  return { phone, sent: true, viaTemplate: !open };
}

function defaultDeps() {
  const reminders = require('./pickupReminders');
  const api = require('./dropanasApi');
  return {
    listSessions,
    sendButtons: (...a) => require('./whatsapp').sendButtons(...a),
    sendTemplateWithSnapshot: (...a) => require('./templateSend').sendTemplateWithSnapshot(...a),
    fetchOrders: () => api.fetchOrders(),
    fetchOrder: (id) => api.fetchOrder(id),
    officeStatus: (sessions, deps) => reminders.officeStatus(sessions, deps),
    notifyAdmin: (t, b) => require('./push').notifyAdmin(t, b),
  };
}

// A quien le toca hoy (sin mandar nada). La usan run() y la vista previa del
// panel. Ordena del pedido mas viejo al mas nuevo y respeta el tope diario.
async function plan(now = new Date(), overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const settings = overrides.settings || getSettings();
  const p = calendar.localParts(now);
  const sessions = deps.listSessions();
  const sentToday = sessions.filter((s) => s?.lastNoticeSentAt && calendar.localParts(s.lastNoticeSentAt)?.ymd === p.ymd).length;
  const cap = Math.max(0, Number(settings.lastNoticeDailyCap ?? 25));
  const empty = { date: p.ymd, due: [], waiting: 0, sentToday, cap };
  if (settings.lastNoticeEnabled !== true) return empty;
  const candidates = sessions.filter((s) => s?.phone && s.stage === 'esperando_retiro' && String(s.card?.guia || '').trim()
    && isNoticeDay(s, settings, now) && !(s.lastNoticeSentAt && s.lastNoticeGuia === String(s.card?.guia || '')));
  if (!candidates.length) return empty;
  const status = await deps.officeStatus(candidates, deps);
  const ok = candidates
    .filter((s) => eligible(s, settings, now, (status.get(s.phone) || { state: null }).state))
    .sort((a, b) => String(reminders().anchorDate(a) || '').localeCompare(String(reminders().anchorDate(b) || '')));
  const room = Math.max(0, cap - sentToday);
  return {
    date: p.ymd, sentToday, cap, waiting: Math.max(0, ok.length - room),
    due: ok.slice(0, room).map((session) => ({ session, day: reminders().dayNumber(session, now) })),
  };
}

async function run(now = new Date(), overrides = {}) {
  let settings = overrides.settings || getSettings();
  if (settings.lastNoticeEnabled !== true) return [];
  const p = calendar.localParts(now);
  if (p.hour < Number(settings.lastNoticeHour ?? 10) || p.hour >= LAST_HOUR) return [];
  // Primera vez en modo fijo: se anota desde cuando rige (los atrasados salen
  // de a poco por el tope diario, nunca todos juntos).
  if (isFixed(settings) && !settings.reminderFixedActivatedAt && !overrides.settings) {
    settings = require('./settings').updateSettings({ reminderFixedActivatedAt: iso(now) });
  }
  const deps = { ...defaultDeps(), ...overrides };
  const { due } = await plan(now, { ...overrides, settings });
  const results = [];
  for (const { session } of due) results.push(await sendNotice(session, settings, now, deps));
  return results;
}

// ---- Respuestas del cliente ----

async function say(phone, text) {
  try {
    await require('./whatsapp').sendText(phone, text);
    appendMessage(phone, 'assistant', text);
  } catch (err) {
    console.warn('lastNotice: respuesta:', err.message);
  }
}

const REASON_QUESTION = 'Lamentamos que ya no lo quieras. Para mejorar, ¿nos cuentas en una frase por qué? (por ejemplo: precio, demora, agencia lejos u otro motivo)';

async function handleReply(phone, id, deps = defaultDeps(), now = new Date()) {
  if (![PICKUP, CHANGE, CANCEL].includes(id)) return false;
  const session = getSession(phone);
  const settings = getSettings();
  const stamp = iso(now);
  if (id === PICKUP) {
    updateSession(phone, { lastNoticeAnswer: 'pickup', lastNoticeAnsweredAt: stamp });
    const limite = pickupDeadline.deadlineText(session, settings);
    await say(phone, `¡Perfecto! Te esperamos${limite ? `: tienes hasta ${limite} para retirarlo` : ''}. Cualquier duda, aquí estamos.`);
  } else if (id === CHANGE) {
    updateSession(phone, { lastNoticeAnswer: 'change', lastNoticeAnsweredAt: stamp });
    await say(phone, 'Claro, dime a qué agencia lo quieres llevar y lo coordinamos.');
    deps.notifyAdmin('Cambio de agencia', `${phone} pidió cambiar de agencia en el último aviso.`);
  } else {
    // "Ya no lo quiero": queda pendiente de devolucion y se pregunta el motivo (una sola vez).
    updateSession(phone, { lastNoticeAnswer: 'cancel', lastNoticeAnsweredAt: stamp, stage: 'pendiente_devolucion', stageSource: 'cliente_ultimo_aviso' });
    deps.notifyAdmin('Cliente no quiere su pedido', `${phone} respondió "Ya no lo quiero" en el último aviso.`);
    const fresh = getSession(phone);
    if (!fresh.returnReasonAskedAt && outboundGuard.canSendAutomatic(fresh, 'return_reason', now, settings).ok) {
      // Marca antes de enviar.
      updateSession(phone, { returnReasonAskedAt: stamp, autoSends: outboundGuard.nextAutoSends(fresh, 'return_reason', now) });
      await say(phone, REASON_QUESTION);
    }
  }
  return true;
}

function classifyReason(text) {
  for (const [key, re] of REASON_RULES) if (re.test(text)) return key;
  return 'otro';
}

// Si se le pregunto el motivo y todavia no contesto, su proximo mensaje de texto es el motivo.
async function captureReason(phone, text) {
  const s = getSession(phone);
  if (!s.returnReasonAskedAt || s.returnReason || !String(text || '').trim()) return false;
  updateSession(phone, { returnReason: classifyReason(text), returnReasonText: String(text).slice(0, 300), returnReasonAt: iso(new Date()) });
  await say(phone, 'Gracias por contarnos, lo tendremos en cuenta. Si cambias de opinión, escríbenos por aquí.');
  return true;
}

// ---- Panel ----

function setPhoneContact(phone, note, now = new Date()) {
  return updateSession(phone, { phoneContactAt: iso(now), phoneContactNote: String(note || '').slice(0, 300) });
}

// Lista "Llamar hoy": pedidos en oficina que vencen hoy o manana, o con ultimo
// aviso sin respuesta, que todavia no se llamaron hoy.
function callToday(sessions, settings = getSettings(), now = new Date()) {
  const today = calendar.localParts(now).ymd;
  const rows = [];
  for (const s of sessions) {
    if (s.stage !== 'esperando_retiro') continue;
    const deadline = pickupDeadline.deadlineFor(s, settings);
    if (!deadline) {
      // Modo fijo sin fecha limite: se llama a quien no contesto el ultimo aviso de un dia anterior.
      const sentDay = s.lastNoticeSentAt ? calendar.localParts(s.lastNoticeSentAt)?.ymd : null;
      if (!sentDay || s.lastNoticeAnswer || sentDay === today) continue;
      if (s.phoneContactAt && calendar.localParts(s.phoneContactAt)?.ymd === today) continue;
      rows.push({ phone: s.phone, name: s.name || s.card?.nombre || '', agencia: s.card?.agencia || '', deadline: null, daysLeft: 99, lastNoticeAnswer: null, noReply: true });
      continue;
    }
    const left = calendar.daysBetween(today, deadline);
    const noReply = s.lastNoticeSentAt && !s.lastNoticeAnswer;
    if (left > 1 && !noReply) continue;
    if (s.phoneContactAt && calendar.localParts(s.phoneContactAt)?.ymd === today) continue;
    rows.push({ phone: s.phone, name: s.name || s.card?.nombre || '', agencia: s.card?.agencia || '', deadline, daysLeft: left, lastNoticeAnswer: s.lastNoticeAnswer || null, noReply: Boolean(noReply) });
  }
  // S6: avisos que Meta rechazo (131049, 131050...) tambien hay que llamarlos.
  const seen = new Set(rows.map((r) => r.phone));
  for (const r of require('./notifyFailures').callTodayRows(sessions)) {
    if (!seen.has(r.phone)) rows.push(r);
  }
  return rows.sort((a, b) => a.daysLeft - b.daysLeft);
}

function start() {
  if (timer) return false;
  const go = () => {
    if (running) return;
    running = true;
    run().catch((err) => console.error('lastNotice:', err.message)).finally(() => { running = false; });
  };
  timer = setInterval(go, CHECK_EVERY_MS);
  timer.unref?.();
  return true;
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { run, plan, eligible, noticeDate, noticeText, noticeParams, NOTICE_DAY, MAX_PICKUP_MESSAGES, handleReply, captureReason, classifyReason, buttonIdFrom, setPhoneContact, callToday, start, stop, PICKUP, CHANGE, CANCEL, BUTTONS };

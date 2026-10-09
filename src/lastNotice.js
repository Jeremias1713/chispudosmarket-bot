// Fase 7D: ULTIMO AVISO la vispera de la fecha limite de retiro (Tealca devuelve
// el paquete pasada esa fecha), con botones, y motivo de devolucion.
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

// Fecha (Caracas) en que toca el aviso: la vispera de la fecha limite.
function noticeDate(session, settings) {
  const d = pickupDeadline.deadlineFor(session, settings);
  return d ? calendar.addDays(d, -1) : null;
}

function eligible(session, settings, now, confirmation) {
  if (settings.lastNoticeEnabled !== true || session.stage !== 'esperando_retiro') return false;
  if (confirmation !== 'en_oficina') return false; // sin confirmacion de DroPanas no se avisa
  const guia = String(session.card?.guia || '');
  if (!guia) return false;
  if (session.lastNoticeSentAt && session.lastNoticeGuia === guia) return false;
  const p = calendar.localParts(now);
  if (noticeDate(session, settings) !== p.ymd) return false;
  if (session.phoneContactAt && calendar.localParts(session.phoneContactAt)?.ymd === p.ymd) return false;
  return true;
}

function noticeText(session, settings) {
  const v = require('./shipping').placeholderValues(session);
  const limite = pickupDeadline.deadlineText(session, settings);
  return `Hola ${v.nombre}, mañana vence el plazo para retirar tu pedido de ${v.producto} en ${v.agencia} (tienes hasta ${limite}); después Tealca lo devuelve. ¿Qué prefieres?`;
}

async function sendNotice(session, settings, now, deps) {
  const phone = session.phone;
  const guard = outboundGuard.canSendAutomatic(session, 'last_notice', now, settings);
  if (!guard.ok) return { phone, sent: false, reason: guard.reason };
  const guia = String(session.card?.guia || '');
  const open = whatsappWindow.isWindowOpen(session);
  if (!open && !settings.lastNoticeTemplateName) return { phone, sent: false, reason: 'sin_plantilla' };
  // Marca ANTES de enviar (si el guardado falla, se propaga y no sale nada).
  updateSession(phone, {
    lastNoticeSentAt: iso(now), lastNoticeGuia: guia,
    autoSends: outboundGuard.nextAutoSends(session, 'last_notice', now),
  });
  const text = noticeText(session, settings);
  try {
    if (open) {
      await deps.sendButtons(phone, text, BUTTONS);
      appendMessage(phone, 'assistant', text);
    } else {
      const v = require('./shipping').placeholderValues(session);
      const params = [v.nombre, v.producto, v.agencia, pickupDeadline.deadlineText(session, settings)];
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

async function run(now = new Date(), overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const settings = overrides.settings || getSettings();
  if (settings.lastNoticeEnabled !== true) return [];
  const p = calendar.localParts(now);
  if (p.hour < Number(settings.lastNoticeHour ?? 10) || p.hour >= LAST_HOUR) return [];
  const candidates = deps.listSessions().filter((s) => s?.phone && s.stage === 'esperando_retiro' && noticeDate(s, settings) === p.ymd
    && !(s.lastNoticeSentAt && s.lastNoticeGuia === String(s.card?.guia || '')));
  if (!candidates.length) return [];
  const status = await deps.officeStatus(candidates, deps);
  const results = [];
  for (const s of candidates) {
    const info = status.get(s.phone) || { state: null };
    if (!eligible(s, settings, now, info.state)) continue;
    results.push(await sendNotice(s, settings, now, deps));
  }
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
    if (!deadline) continue;
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

module.exports = { run, eligible, noticeDate, handleReply, captureReason, classifyReason, buttonIdFrom, setPhoneContact, callToday, start, stop, PICKUP, CHANGE, CANCEL };

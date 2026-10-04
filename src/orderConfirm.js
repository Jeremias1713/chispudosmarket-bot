// Fase 7A: confirmacion del pedido con botones ANTES de subirlo a DroPanas.
// Motivo: muchas devoluciones nacen de pedidos que el cliente nunca confirmo
// de verdad (dato mal tomado, monto distinto, "solo estaba preguntando").
//
// Flujo: al cerrarse la venta se programa un mensaje de confirmacion (code arma
// producto, monto, agencia y fechas; la IA no calcula nada). Si el cliente toca
// "Si, confirmo" el pedido queda confirmado y recien ahi se sube. Mientras no
// este confirmado, la subida AUTOMATICA devuelve reason 'esperando_confirmacion'
// (la subida manual desde el panel nunca se bloquea).
//
// Estado en session.orderConfirm:
//   { status: 'pending'|'sent'|'confirmed'|'change'|'expired'|'no_window'|'incomplete',
//     scheduledFor, sentAt, reminderSentAt, confirmedAt, confirmedBy, monto }
const { getSettings } = require('./settings');
const { listSessions, getSession, updateSession, appendMessage } = require('./state');
const outboundGuard = require('./outboundGuard');
const calendar = require('./calendar');
const whatsappWindow = require('./whatsappWindow');

const TICK_MS = 60 * 1000;
const YES = 'oc_yes';
const CHANGE = 'oc_change';
const AFFIRM_TEXT = /^\s*(si|sí|sii+|confirmo|confirmado|correcto|todo correcto|dale|ok|okey|listo|de acuerdo)[\s.!]*$/i;
let timer = null;
let running = false;

function iso(ms) { return new Date(ms).toISOString(); }

// Una venta anterior a la activacion NO se bloquea: asi prender el interruptor
// no frena de golpe las ventas que ya estaban en marcha.
function isGated(session, settings = getSettings()) {
  if (settings.orderConfirmEnabled !== true || !settings.orderConfirmActivatedAt) return false;
  if (!session?.soldAt || new Date(session.soldAt) < new Date(settings.orderConfirmActivatedAt)) return false;
  return true;
}

function gate(session, settings = getSettings()) {
  if (!isGated(session, settings)) return { ok: true };
  if (session.orderConfirm?.status === 'confirmed') return { ok: true };
  return { ok: false, reason: 'esperando_confirmacion' };
}

function delayMinutes(now, settings) {
  const near = calendar.minutesToCutoff(now, settings);
  // Si el corte de despacho esta cerca se avisa mas rapido para no perder el dia.
  if (calendar.isConfigured(settings) && near > 0 && near <= 60) return Number(settings.orderConfirmNearCutoffDelayMin ?? 5);
  return Number(settings.orderConfirmDelayMin ?? 20);
}

// Se llama al cerrar la venta (o recompra). Idempotente: una venta, una confirmacion.
function scheduleForClose(phone, now = new Date(), settings = getSettings()) {
  const session = getSession(phone);
  if (!isGated(session, settings)) return false;
  const cur = session.orderConfirm;
  if (cur && cur.soldAt === session.soldAt) return false;
  updateSession(phone, {
    orderConfirm: {
      status: 'pending', soldAt: session.soldAt,
      scheduledFor: iso(now.getTime() + delayMinutes(now, settings) * 60000),
    },
  });
  return true;
}

function money(n) {
  return Number(n).toLocaleString('es-VE', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });
}

// Texto de la confirmacion. Todo dato sale de la ficha; null si falta producto, monto o agencia.
function buildMessage(session, now = new Date(), settings = getSettings(), loader) {
  const card = session.card || {};
  const monto = Number(card.monto);
  const producto = String(card.producto || (Array.isArray(card.productos) ? card.productos.map((p) => p.nombre || p.name || p).join(' + ') : '') || '').trim();
  const agencia = String(card.agencia || '').trim();
  if (!producto || !Number.isFinite(monto) || monto <= 0 || !agencia) return null;
  const nombre = String(card.nombre || session.name || '').trim().split(/\s+/)[0];
  const dates = calendar.datesForSession(session, now, settings, loader);
  const fechas = dates ? ` Sale ${dates.dispatchText} y llegaría ${dates.rangeText} (estimado).` : '';
  return `${nombre ? `Hola ${nombre}, ` : ''}confirmo tu pedido: ${producto} por ${money(monto)} Bs, para retirar en ${agencia}.${fechas} ¿Está todo correcto?`;
}

async function sendOne(session, now, settings, deps) {
  const phone = session.phone;
  const oc = session.orderConfirm;
  if (!whatsappWindow.isWindowOpen(session)) {
    updateSession(phone, { orderConfirm: { ...oc, status: 'no_window' } });
    deps.notifyAdmin('Pedido sin confirmar', `${phone}: pasaron más de 24 h sin escribir; confirma por teléfono.`);
    return 'no_window';
  }
  const text = buildMessage(session, now, settings, deps.loader);
  if (!text) {
    updateSession(phone, { orderConfirm: { ...oc, status: 'incomplete' } });
    deps.notifyAdmin('Pedido sin confirmar', `${phone}: faltan producto, monto o agencia en la ficha.`);
    return 'incomplete';
  }
  const verdict = outboundGuard.canSendAutomatic(session, 'order_confirm', now, settings);
  if (!verdict.ok) return verdict.reason; // se reintenta en el proximo tick
  // Marca ANTES de enviar: es preferible no confirmar a mandarlo dos veces.
  const monto = Number(session.card.monto);
  const autoSends = outboundGuard.nextAutoSends(session, 'order_confirm', now);
  updateSession(phone, { autoSends, orderConfirm: { ...oc, status: 'sent', sentAt: now.toISOString(), monto } });
  try {
    await deps.sendButtons(phone, text, [{ id: YES, title: 'Sí, confirmo' }, { id: CHANGE, title: 'Quiero cambiar algo' }]);
  } catch (err) {
    console.error('orderConfirm: no se pudo enviar la confirmacion:', err.message);
    return 'error';
  }
  try { appendMessage(phone, 'assistant', text); } catch (err) { console.warn('orderConfirm: historial:', err.message); }
  return 'sent';
}

async function sendReminder(session, now, settings, deps) {
  const verdict = outboundGuard.canSendAutomatic(session, 'order_confirm', now, settings);
  if (!verdict.ok || !whatsappWindow.isWindowOpen(session)) return 'skip';
  const oc = session.orderConfirm;
  const text = 'Solo para confirmar tu pedido antes de enviarlo: ¿está todo correcto?';
  updateSession(session.phone, {
    autoSends: outboundGuard.nextAutoSends(session, 'order_confirm', now),
    orderConfirm: { ...oc, reminderSentAt: now.toISOString() },
  });
  try {
    await deps.sendButtons(session.phone, text, [{ id: YES, title: 'Sí, confirmo' }, { id: CHANGE, title: 'Quiero cambiar algo' }]);
    appendMessage(session.phone, 'assistant', text);
  } catch (err) {
    console.error('orderConfirm: recordatorio:', err.message);
  }
  return 'reminded';
}

function defaultDeps() {
  return {
    sendButtons: (...a) => require('./whatsapp').sendButtons(...a),
    notifyAdmin: (t, b) => require('./push').notifyAdmin(t, b),
    sessions: () => listSessions(),
    loader: undefined,
  };
}

// Un barrido: envia las confirmaciones que ya les toca, recuerda y expira.
async function tick(now = new Date(), deps = defaultDeps(), settings = getSettings()) {
  if (settings.orderConfirmEnabled !== true) return { sent: 0 };
  let sent = 0;
  for (const session of deps.sessions()) {
    const oc = session.orderConfirm;
    if (!oc) continue;
    if (oc.status === 'pending' && new Date(oc.scheduledFor) <= now) {
      if (await sendOne(session, now, settings, deps) === 'sent') sent += 1;
    } else if (oc.status === 'sent') {
      const ageH = (now - new Date(oc.sentAt)) / 3600000;
      if (ageH >= Number(settings.orderConfirmExpireAfterH ?? 20)) {
        updateSession(session.phone, { orderConfirm: { ...oc, status: 'expired' } });
        deps.notifyAdmin('Pedido sin confirmar', `${session.phone} no confirmó su pedido; revisa o llama.`);
      } else if (!oc.reminderSentAt && ageH >= Number(settings.orderConfirmReminderAfterH ?? 4)) {
        await sendReminder(session, now, settings, deps);
      }
    }
  }
  return { sent };
}

function confirm(phone, by) {
  const s = getSession(phone);
  const oc = s.orderConfirm || {};
  if (oc.status === 'confirmed') return false;
  const monto = oc.monto ?? (Number.isFinite(Number(s.card?.monto)) ? Number(s.card.monto) : null);
  updateSession(phone, { orderConfirm: { ...oc, status: 'confirmed', confirmedAt: new Date().toISOString(), confirmedBy: by, monto } });
  // Recien ahora se sube a DroPanas (con el monto confirmado ya guardado).
  try { require('./dropanasOrderAutomation').maybeCreate(phone); } catch (err) { console.error('orderConfirm: subida:', err.message); }
  return true;
}

// Respuesta a los botones. Devuelve true si el id era de este modulo.
async function handleReply(phone, id, deps = defaultDeps()) {
  if (id !== YES && id !== CHANGE) return false;
  const session = getSession(phone);
  if (session.orderConfirm?.status !== 'sent' && session.orderConfirm?.status !== 'pending') return true;
  if (id === YES) {
    confirm(phone, 'cliente_boton');
    const reply = '¡Perfecto! Tu pedido queda confirmado y lo enviamos en el próximo despacho.';
    try { await require('./whatsapp').sendText(phone, reply); appendMessage(phone, 'assistant', reply); } catch (err) { console.warn('orderConfirm: respuesta:', err.message); }
  } else {
    updateSession(phone, { orderConfirm: { ...session.orderConfirm, status: 'change' } });
    const reply = 'Claro, dime qué quieres cambiar y lo ajustamos antes de enviarlo.';
    try { await require('./whatsapp').sendText(phone, reply); appendMessage(phone, 'assistant', reply); } catch (err) { console.warn('orderConfirm: respuesta:', err.message); }
    deps.notifyAdmin('Pedido por cambiar', `${phone} quiere cambiar algo de su pedido.`);
  }
  return true;
}

// "si" escrito a mano mientras hay una confirmacion pendiente de respuesta.
function confirmByText(phone, text) {
  const s = getSession(phone);
  if (s.orderConfirm?.status !== 'sent' || !AFFIRM_TEXT.test(String(text || ''))) return false;
  return confirm(phone, 'cliente_texto');
}

function start() {
  if (timer) return false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    tick().catch((err) => console.error('orderConfirm tick:', err.message)).finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
  return true;
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { isGated, gate, scheduleForClose, buildMessage, tick, confirm, handleReply, confirmByText, start, stop, YES, CHANGE };

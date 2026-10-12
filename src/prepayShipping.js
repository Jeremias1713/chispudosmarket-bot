'use strict';

// Descuento por pagar el envio por adelantado (pedido de Jere, para bajar
// devoluciones: quien ya pago el flete casi siempre retira).
//
// Flujo:
//  1. Al cerrarse la venta el bot ofrece, con botones: "si pagas el envio por
//     adelantado (X) por pago movil, te descontamos Y% del producto".
//  2. "Si" -> se mandan los datos de pago movil y se espera la captura.
//     "Pago al retirar" -> sigue contra entrega normal.
//  3. El cliente manda la captura -> push a Jere; el bot contesta "recibido".
//  4. Jere confirma en el panel ("Pago recibido" o "No llego") -> se le avisa
//     al cliente y recien ahi se sube el pedido a DroPanas, con el descuento
//     aplicado al precio del producto (lo que el cliente paga al retirar).
//  Sin respuesta a la oferta, o sin captura en el plazo, sigue contra entrega.
//
// La IA nunca calcula montos: todo texto con montos lo arma este modulo.
// Estado en session.prepay:
//   { status: 'offered'|'awaiting_payment'|'receipt_sent'|'paid'|'declined'|'rejected'|'expired',
//     soldAt, percent, offeredAt, chosenAt, receiptAt, receiptUrl, paidAt, decidedBy,
//     total, discountBs, lines: [{ productName, total, discountBs }] }
//
// Cuanto se descuenta: cada producto puede tener su propio descuento en
// Productos (prepayDiscountType: 'percent' | 'amount' (Bs) | 'none'); si no
// tiene, se usa el % general de Fase 7. El monto se calcula al ofrecer y queda
// guardado: lo que se le prometio al cliente es lo que se sube a DroPanas.
const { getSettings } = require('./settings');
const { listSessions, getSession, updateSession, appendMessage } = require('./state');
const whatsappWindow = require('./whatsappWindow');

const YES = 'pp_yes';
const NO = 'pp_no';
const OFFER_BUTTONS = [{ id: YES, title: 'Sí, quiero descuento' }, { id: NO, title: 'Pago al retirar' }];
// Lo que se guarda en el historial para que el panel muestre los botones.
const buttonsHistoryExtra = (...a) => require('./whatsapp').buttonsHistoryExtra(...a);
const TICK_MS = 60 * 1000;
const WAITING = ['offered', 'awaiting_payment', 'receipt_sent'];
let timer = null;
let running = false;

function isConfigured(settings = getSettings()) {
  return settings.prepayEnabled === true
    && String(settings.prepayShippingAmount || '').trim() !== ''
    && String(settings.prepayPaymentInfo || '').trim() !== '';
}

function sameSale(session) {
  return Boolean(session?.prepay) && session.prepay.soldAt === (session.soldAt || null);
}

// La subida automatica a DroPanas espera mientras la oferta este abierta.
function gate(session) {
  if (!sameSale(session) || !WAITING.includes(session.prepay.status)) return { ok: true };
  return { ok: false, reason: 'esperando_pago_envio' };
}

function money(n) {
  return Number(n).toLocaleString('es-VE', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });
}

// Total del producto (lo que se cobra al retirar) sin descuento, o null.
function productTotal(session) {
  const monto = Number(session?.card?.monto);
  if (Number.isFinite(monto) && monto > 0) return monto;
  try {
    const draft = require('./dropanasOrderAutomation').baseDraft(session.phone, session);
    return Number(draft?.total) > 0 ? Number(draft.total) : null;
  } catch (err) {
    return null;
  }
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Regla de descuento de un producto del catalogo (o la general).
function ruleFor(product, settings = getSettings()) {
  const type = product?.prepayDiscountType || '';
  const value = Number(product?.prepayDiscountValue);
  if (type === 'none') return { type: 'none', value: 0 };
  if ((type === 'percent' || type === 'amount') && Number.isFinite(value) && value > 0) return { type, value };
  const general = Number(settings.prepayDiscountPercent);
  return { type: 'percent', value: Number.isFinite(general) && general > 0 ? general : 0, general: true };
}

// Producto del catalogo que corresponde a una linea del pedido (mismo criterio
// que el precio: ver catalog.productForOrderItem).
function productForItem(item) {
  try { return require('./catalog').productForOrderItem(item?.productName, item?.mapping) || null; } catch (err) { return null; }
}

// "4000" -> "4.000 Bs"; un texto con letras (ej. "450 Bs", "5$") va tal cual.
function shippingAmountText(raw) {
  const t = String(raw || '').trim();
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  return /^[\d.,\s]+$/.test(t) && Number.isFinite(n) && n > 0 ? `${money(n)} Bs` : t;
}

function lineDiscount(total, rule) {
  if (rule.type === 'amount') return round2(total > 0 ? Math.min(rule.value, total) : rule.value);
  if (rule.type === 'percent') return total > 0 ? round2(total * rule.value / 100) : 0;
  return 0;
}

// Cuanto se le descuenta a esta venta: { total, discountBs, lines }.
function computeDiscount(session, settings = getSettings()) {
  let items = [];
  try {
    const draft = require('./dropanasOrderAutomation').baseDraft(session.phone, session);
    items = Array.isArray(draft?.items) ? draft.items : [];
  } catch (err) {
    items = [];
  }
  if (!items.length) {
    const monto = Number(session?.card?.monto);
    items = [{ productName: String(session?.card?.producto || ''), total: Number.isFinite(monto) && monto > 0 ? monto : 0 }];
  }
  const lines = items.map((item) => {
    const total = Number(item.total) > 0 ? Number(item.total) : 0;
    const rule = ruleFor(productForItem(item), settings);
    return { productName: item.productName || '', total, discountBs: lineDiscount(total, rule) };
  });
  const total = round2(lines.reduce((s, l) => s + l.total, 0));
  const discountBs = round2(lines.reduce((s, l) => s + l.discountBs, 0));
  return { total: total > 0 ? total : null, discountBs, lines };
}

// Descuento guardado de esta venta en Bs (ventas viejas: con el %).
function storedDiscountBs(session, total) {
  const p = session?.prepay || {};
  if (Number.isFinite(Number(p.discountBs)) && p.discountBs != null) return Number(p.discountBs);
  return total ? round2(total * (Number(p.percent) || 0) / 100) : 0;
}

function discounted(total, percent) {
  return Math.round(total * (1 - Number(percent) / 100) * 100) / 100;
}

function defaultDeps() {
  return {
    sendButtons: (...a) => require('./whatsapp').sendButtons(...a),
    sendText: (...a) => require('./whatsapp').sendText(...a),
    notifyAdmin: (t, b) => require('./push').notifyAdmin(t, b),
    maybeCreate: (phone) => require('./dropanasOrderAutomation').maybeCreate(phone),
    sessions: () => listSessions(),
  };
}

async function say(phone, text, deps) {
  try {
    await deps.sendText(phone, text);
    appendMessage(phone, 'assistant', text);
  } catch (err) {
    console.error('prepay: no se pudo enviar a', `…${String(phone).slice(-4)}`, err.message);
  }
}

// Se llama al cerrar la venta (o recompra). Una oferta por venta.
async function offerAfterClose(phone, deps = defaultDeps(), settings = getSettings(), now = new Date()) {
  if (!isConfigured(settings)) return false;
  const session = getSession(phone);
  if (!session?.soldAt || sameSale(session)) return false;
  if (settings.prepayActivatedAt && new Date(session.soldAt) < new Date(settings.prepayActivatedAt)) return false;
  if (session.attention?.open === true || session.paused) return false;
  if (!whatsappWindow.isWindowOpen(session)) return false;
  const percent = Number(settings.prepayDiscountPercent) || 0;
  const d = computeDiscount({ ...session, phone }, settings);
  // Sin descuento para estos productos (o sin precio para calcularlo): no se ofrece.
  if (!(d.discountBs > 0)) return false;
  // Marca ANTES de enviar: es preferible no ofrecer a ofrecer dos veces.
  updateSession(phone, { prepay: {
    status: 'offered', soldAt: session.soldAt, percent, offeredAt: now.toISOString(),
    total: d.total, discountBs: d.discountBs, lines: d.lines,
  } });
  const cuenta = d.total ? ` (al retirar pagas ${money(d.total - d.discountBs)} Bs en vez de ${money(d.total)} Bs)` : '';
  const text = `💸 *Opcional:* si pagas el envío por adelantado (${shippingAmountText(settings.prepayShippingAmount)}) por pago móvil, te descontamos ${money(d.discountBs)} Bs del producto${cuenta}. ¿Te interesa?`;
  try {
    const res = await deps.sendButtons(phone, text, OFFER_BUTTONS);
    appendMessage(phone, 'assistant', text, buttonsHistoryExtra(OFFER_BUTTONS, res));
  } catch (err) {
    console.error('prepay: no se pudo ofrecer el descuento:', err.message);
    // Si no salio, la venta sigue normal (contra entrega).
    updateSession(phone, { prepay: { ...getSession(phone).prepay, status: 'expired', error: err.message } });
    return false;
  }
  return true;
}

function setStatus(phone, status, extra = {}) {
  const s = getSession(phone);
  return updateSession(phone, { prepay: { ...(s.prepay || {}), status, ...extra } });
}

// Botones de la oferta (o las frases exactas de los botones escritas a mano).
const YES_TEXT = /^\s*(si,? quiero (el )?descuento|quiero (el )?descuento)[\s.!]*$/i;
const NO_TEXT = /^\s*(pago al retirar|no,? pago al retirar)[\s.!]*$/i;

function idFromText(text) {
  if (YES_TEXT.test(String(text || ''))) return YES;
  if (NO_TEXT.test(String(text || ''))) return NO;
  return null;
}

// Devuelve true si el mensaje era de este modulo (y ya se contesto).
async function handleReply(phone, idOrText, deps = defaultDeps(), settings = getSettings(), now = new Date()) {
  const id = idOrText === YES || idOrText === NO ? idOrText : idFromText(idOrText);
  if (!id) return false;
  const session = getSession(phone);
  if (!sameSale(session) || session.prepay.status !== 'offered') return idOrText === YES || idOrText === NO;
  if (id === YES) {
    setStatus(phone, 'awaiting_payment', { chosenAt: now.toISOString() });
    await say(phone, `¡Genial! 🙌 Estos son los datos para pagar el envío (${shippingAmountText(settings.prepayShippingAmount)}):\n\n${String(settings.prepayPaymentInfo).trim()}\n\nCuando pagues, mándame la captura por aquí y te confirmamos el descuento.`, deps);
  } else {
    setStatus(phone, 'declined', { chosenAt: now.toISOString(), decidedBy: 'cliente' });
    await say(phone, 'Perfecto 👍 Pagas todo al retirar en la agencia, como siempre.', deps);
    deps.maybeCreate(phone);
  }
  return true;
}

// Captura del pago (imagen) mientras se espera el pago. true si se atendio.
async function handleReceipt(phone, { mediaUrl = null } = {}, deps = defaultDeps(), now = new Date()) {
  const session = getSession(phone);
  if (!sameSale(session) || session.prepay.status !== 'awaiting_payment') return false;
  setStatus(phone, 'receipt_sent', { receiptAt: now.toISOString(), receiptUrl: mediaUrl });
  await say(phone, '¡Recibido! 🙌 Verificamos el pago y te confirmamos el descuento en breve.', deps);
  try {
    const nombre = session.card?.nombre || session.name || `…${String(phone).slice(-4)}`;
    const p = deps.notifyAdmin('Pago de envío por confirmar', `${nombre} mandó la captura del pago del envío. Confírmalo en el panel (Configuración → Pago del envío por adelantado).`);
    if (p && p.catch) p.catch(() => {});
  } catch (err) { /* push opcional */ }
  return true;
}

// Panel: Jere confirma o rechaza el pago.
async function decide(phone, paid, deps = defaultDeps(), now = new Date()) {
  const session = getSession(phone);
  if (!sameSale(session) || !['awaiting_payment', 'receipt_sent'].includes(session.prepay.status)) {
    return { ok: false, error: 'Ese chat no tiene un pago de envío pendiente.' };
  }
  if (paid) {
    setStatus(phone, 'paid', { paidAt: now.toISOString(), decidedBy: 'panel' });
    const total = Number(session.prepay.total) > 0 ? Number(session.prepay.total) : productTotal({ ...session, phone });
    const desc = storedDiscountBs(session, total);
    const resto = total ? `: al retirar pagas ${money(round2(total - desc))} Bs en vez de ${money(total)} Bs` : '';
    await say(phone, `✅ ¡Pago del envío recibido! Te aplicamos ${money(desc)} Bs de descuento${resto}.`, deps);
  } else {
    setStatus(phone, 'rejected', { decidedAt: now.toISOString(), decidedBy: 'panel' });
    await say(phone, 'No pudimos verificar el pago del envío, así que tu pedido queda con el pago completo al retirar en la agencia. Si ya pagaste, escríbenos y lo revisamos.', deps);
  }
  deps.maybeCreate(phone);
  return { ok: true };
}

// Para el panel: pagos esperando revision o captura.
function pending(sessions = listSessions()) {
  return sessions
    .filter((s) => sameSale(s) && ['awaiting_payment', 'receipt_sent'].includes(s.prepay.status))
    .map((s) => ({
      phone: s.phone,
      name: s.card?.nombre || s.name || '',
      status: s.prepay.status,
      percent: s.prepay.percent,
      discountBs: storedDiscountBs(s, Number(s.prepay.total) > 0 ? Number(s.prepay.total) : productTotal(s)),
      chosenAt: s.prepay.chosenAt || null,
      receiptAt: s.prepay.receiptAt || null,
      receiptUrl: s.prepay.receiptUrl || null,
      total: productTotal(s),
    }))
    .sort((a, b) => String(b.receiptAt || b.chosenAt).localeCompare(String(a.receiptAt || a.chosenAt)));
}

// Para dropanasOrderAutomation: descuento a aplicar en esta venta (o 0).
// Para dropanasOrderAutomation: descuento en Bs de cada linea del pedido, o
// null si esta venta no tiene descuento. Usa lo guardado al ofrecer (lo que se
// le prometio al cliente); si las lineas cambiaron, reparte el total guardado.
function discountLinesFor(session, items) {
  if (!sameSale(session) || session.prepay.status !== 'paid') return null;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  const p = session.prepay;
  if (Array.isArray(p.lines) && p.lines.length === list.length) return p.lines.map((l) => Number(l.discountBs) || 0);
  const totals = list.map((i) => Number(i.total) || 0);
  const sum = totals.reduce((a, b) => a + b, 0);
  const desc = storedDiscountBs(session, sum);
  if (!(desc > 0) || !(sum > 0)) return null;
  return totals.map((t) => round2(desc * t / sum));
}

function discountPercentFor(session) {
  return sameSale(session) && session.prepay.status === 'paid' ? Number(session.prepay.percent) || 0 : 0;
}

// Vencimientos: oferta sin respuesta -> contra entrega; elegido sin captura
// -> contra entrega y aviso a Jere.
async function tick(now = new Date(), deps = defaultDeps(), settings = getSettings()) {
  let expired = 0;
  for (const s of deps.sessions()) {
    if (!sameSale(s)) continue;
    const p = s.prepay;
    if (p.status === 'offered') {
      const min = (now - new Date(p.offeredAt)) / 60000;
      if (min >= Number(settings.prepayOfferExpireMin ?? 120)) {
        setStatus(s.phone, 'expired', { expiredAt: now.toISOString() });
        deps.maybeCreate(s.phone);
        expired += 1;
      }
    } else if (p.status === 'awaiting_payment') {
      const h = (now - new Date(p.chosenAt)) / 3600000;
      if (h >= Number(settings.prepayPaymentExpireH ?? 12)) {
        setStatus(s.phone, 'expired', { expiredAt: now.toISOString() });
        try {
          const pr = deps.notifyAdmin('Pago de envío no llegó', `${s.card?.nombre || s.phone} eligió pagar el envío por adelantado pero no mandó la captura. El pedido sigue contra entrega.`);
          if (pr && pr.catch) pr.catch(() => {});
        } catch (err) { /* push opcional */ }
        deps.maybeCreate(s.phone);
        expired += 1;
      }
    }
  }
  return { expired };
}

// Bloque para el prompt de la IA, asi no contradice el estado de la oferta.
function promptBlock(session) {
  if (!sameSale(session)) return '';
  const st = session.prepay.status;
  if (st === 'offered') return '\n  DATO YA CONFIRMADO, PAGO DEL ENVIO POR ADELANTADO: ya se le ofrecio al cliente (con botones) un descuento si paga el envio por adelantado. NO se lo vuelvas a ofrecer ni inventes montos. Si pregunta, dile que toque el boton "Sí, quiero descuento" o "Pago al retirar".\n';
  if (st === 'awaiting_payment') return '\n  DATO YA CONFIRMADO, PAGO DEL ENVIO POR ADELANTADO: el cliente eligio pagar el envio por adelantado y ya se le mandaron los datos de pago movil. Si pregunta, recuerdale que mande la captura del pago por aqui. NUNCA confirmes un pago ni des montos: eso lo confirma una persona del equipo.\n';
  if (st === 'receipt_sent') return '\n  DATO YA CONFIRMADO, PAGO DEL ENVIO POR ADELANTADO: el cliente ya mando la captura del pago del envio y una persona del equipo la esta verificando. NO confirmes el pago vos ni des montos; di que lo estan verificando.\n';
  if (st === 'paid') return '\n  DATO YA CONFIRMADO, PAGO DEL ENVIO POR ADELANTADO: el pago del envio ya fue confirmado y tiene el descuento aplicado. No le vuelvas a pedir el pago del envio.\n';
  return '';
}

function start() {
  if (timer) return false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    tick().catch((err) => console.error('prepay:', err.message)).finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
  return true;
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  YES, NO, OFFER_BUTTONS, isConfigured, gate, offerAfterClose, handleReply, handleReceipt, decide, pending,
  discountPercentFor, discountLinesFor, computeDiscount, ruleFor, tick, promptBlock, start, stop, discounted, idFromText,
};

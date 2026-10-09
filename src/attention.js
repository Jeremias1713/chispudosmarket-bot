'use strict';

// "Necesita atencion": cuando un cliente se queja (no le funciona, le llego
// mal, le cobraron doble, pide hablar con una persona...) el bot se apaga en
// ese chat y se lo deja a un humano.
//
// Bug real que corrige: antes la etapa "necesita_atencion" solo la podia poner
// el clasificador por IA, y la regla de "nunca retroceder" la bloqueaba en
// cualquier chat que ya tuviera una venta (vendido, en camino, esperando
// retiro...). Justo ahi es donde aparecen los reclamos, asi que casi nunca se
// marcaba, y aunque se marcara el bot seguia contestando solo.
//
// Como queda:
//  - Deteccion por reglas (palabras claras de reclamo) ANTES de que conteste la
//    IA, y ademas el clasificador por IA como red de seguridad.
//  - Se marca session.attention = { open, at, reason, source, text,
//    previousStage }, se pausa el bot en ese chat y se avisa a Jere por push.
//  - Si el chat todavia no tiene un pedido en curso, la etapa pasa a
//    "necesita_atencion". Si ya tiene un pedido (en camino, esperando retiro,
//    entregado...), la etapa logistica NO se toca: DroPanas, el reconciliador
//    y las metricas de ventas dependen de ella. Igual aparece en el panel
//    "Necesita atencion".
//  - Mientras esta abierto no sale nada automatico de marketing ni
//    recordatorios (outboundGuard). Los avisos de envio/llegada si.
//  - Jere lo cierra desde el panel ("Resuelto"), y ahi el bot vuelve a
//    contestar.
const { logisticRank } = require('./stageRules');

const REASONS = {
  cobro_doble: 'Pago o cobro doble',
  llego_mal: 'Le llegó mal o incompleto',
  no_funciona: 'Dice que no le funciona',
  estafa: 'Habla de estafa o fraude',
  reembolso: 'Pide su dinero de vuelta',
  pide_humano: 'Pide hablar con una persona',
  reclamo: 'Queja o reclamo',
  ia: 'La IA detectó un reclamo',
};

function fold(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Reglas que solo tienen sentido si el cliente ya compro (un interesado que
// pregunta "¿y si no me funciona?" no esta reclamando).
const AFTER_SALE_RULES = [
  ['cobro_doble', /\b(pague|pago|pagamos|cobraron|cobro|cobran|descontaron|transferi|debitaron)\b.{0,30}\b(doble|dos veces|2 veces|de mas)\b|\b(doble|dos) (cobros?|pagos?|cargos?)\b/],
  ['llego_mal', /\b(llego|llegaron|vino|vinieron|recibi|me entregaron)\b.{0,30}\b(mal|roto|rota|rotos|danad[oa]s?|abiert[oa]s?|incomplet[oa]s?|vacio|vacia|equivocad[oa]s?|vencid[oa]s?|derramad[oa]|partid[oa])\b|\bno (era|es) lo que (pedi|compre)\b|\bme (mandaron|enviaron|llego) (otro|otra) (producto|cosa|frasco)\b|\b(falto|faltaba|faltan|falta) (un|una|uno|el|la|producto|frasco|pote)\b/],
  ['no_funciona', /\bno (me )?(funciona|funciono|sirve|sirvio|hizo efecto|hace efecto|hace nada|ha hecho (nada|efecto)|resulto|veo (ningun |los )?resultados?)\b|\bno (he|e) (visto|notado|sentido) (ningun|ninguna|nada)\b/],
  ['estafa', /\b(estafa|estafaron|estafador|estafadores|me robaron|fraude|denuncia|denunciar|demanda)\b/],
  ['reembolso', /\b(reembolso|reembolsen|devuelvan (el|mi) (dinero|plata|pago)|devolucion (de|del) (mi )?(dinero|pago))\b/],
];

// Reglas que valen en cualquier momento de la charla.
const ANY_TIME_RULES = [
  ['pide_humano', /\b(hablar|comunicarme|conversar|contactar(me)?) con (una persona|un humano|alguien (real|de verdad)|el encargado|la encargada|un asesor|una asesora|el dueno|la duena|el gerente|un supervisor|un agente)\b|\b(quiero|necesito|pasame|paseme) (a |con )?(una persona|un humano|un asesor|una asesora|un agente)\b/],
  ['reclamo', /\b(quiero (hacer|poner) (un|una) (reclamo|queja)|tengo (un|una) (reclamo|queja)|quiero quejarme|pesimo servicio|muy mal servicio|que falta de respeto|estoy (muy )?(molest[oa]|indignad[oa]|arrech[oa]))\b/],
];

// "¿y si no me funciona?" / "que pasa si llega roto" son dudas, no reclamos.
const HYPOTHETICAL = /\b(y si|que pasa si|que tal si|en caso de que|si llega|si no)\b/;

function hasOrder(session) {
  return session?.orderClosed === true || logisticRank(session?.stage) >= 1 || ['entregado', 'devolucion'].includes(session?.stage);
}

// Devuelve { reason, label } o null.
function detectComplaint(text, session) {
  const t = fold(text);
  if (t.length < 4) return null;
  for (const [reason, re] of ANY_TIME_RULES) {
    if (re.test(t)) return { reason, label: REASONS[reason] };
  }
  if (!hasOrder(session) || HYPOTHETICAL.test(t)) return null;
  for (const [reason, re] of AFTER_SALE_RULES) {
    if (re.test(t)) return { reason, label: REASONS[reason] };
  }
  return null;
}

function isOpen(session) {
  return session?.attention?.open === true;
}

// Patch para abrir la atencion. No pisa una atencion ya abierta.
function openPatch(session, { reason, source, text, now = new Date() }) {
  const nowIso = now.toISOString();
  const patch = {
    attention: {
      open: true,
      at: nowIso,
      reason: reason || 'reclamo',
      label: REASONS[reason] || REASONS.reclamo,
      source: source || 'regla',
      text: String(text || '').slice(0, 300),
      previousStage: session?.stage || 'nuevo',
    },
    paused: true,
    pausedReason: 'necesita_atencion',
  };
  // Sin pedido en curso: la etapa pasa a necesita_atencion. Con pedido, la
  // etapa logistica se conserva (ver arriba).
  if (logisticRank(session?.stage) < 1 && !['entregado', 'devolucion'].includes(session?.stage)) {
    Object.assign(patch, {
      stage: 'necesita_atencion',
      stageReason: `Necesita atención: ${patch.attention.label}`,
      stageSource: 'atencion',
      stageUpdatedAt: nowIso,
    });
  }
  return patch;
}

// Abre la atencion: guarda, pausa y avisa a Jere. deps para tests.
function open(phone, session, info, deps = {}) {
  if (isOpen(session)) return null;
  const update = deps.updateSession || require('./state').updateSession;
  const patch = openPatch(session, info);
  const saved = update(phone, patch);
  try {
    const notify = deps.notifyAdmin || ((title, body) => require('./push').notifyAdmin(title, body));
    const nombre = session?.card?.nombre || session?.name || `…${String(phone).slice(-4)}`;
    const snippet = String(info.text || '').slice(0, 120);
    const p = notify('Cliente necesita atención', `${nombre}: ${patch.attention.label}${snippet ? ` — "${snippet}"` : ''}. El bot quedó en pausa en ese chat.`);
    if (p && p.catch) p.catch(() => {});
  } catch (err) {
    console.error('No se pudo avisar la atencion:', err.message);
  }
  return saved;
}

// Patch para cerrar (Resuelto). reactivate=false deja el bot en pausa.
function resolvePatch(session, { reactivate = true, now = new Date() } = {}) {
  const att = session?.attention || {};
  const patch = {
    attention: { ...att, open: false, resolvedAt: now.toISOString() },
  };
  if (reactivate) Object.assign(patch, { paused: false, pausedReason: null });
  if (session?.stage === 'necesita_atencion') {
    const prev = att.previousStage && att.previousStage !== 'necesita_atencion' ? att.previousStage : 'interesado';
    Object.assign(patch, { stage: prev, stageLocked: false, stageReason: 'Atención resuelta', stageSource: 'panel', stageUpdatedAt: now.toISOString() });
  }
  return patch;
}

// Chats para el panel "Necesita atención": abiertos por el bot, o que tienen
// la etapa puesta (a mano o por la IA).
function list(sessions) {
  return (sessions || [])
    .filter((s) => isOpen(s) || s.stage === 'necesita_atencion')
    .map((s) => {
      const history = Array.isArray(s.history) ? s.history : [];
      const last = history[history.length - 1];
      const lastUser = [...history].reverse().find((m) => m && m.role === 'user');
      return {
        phone: s.phone,
        name: s.card?.nombre || s.name || '',
        stage: s.stage || 'nuevo',
        reason: s.attention?.label || (s.stage === 'necesita_atencion' ? 'Marcado como necesita atención' : ''),
        source: s.attention?.source || null,
        text: s.attention?.text || '',
        at: s.attention?.at || s.stageUpdatedAt || null,
        paused: Boolean(s.paused),
        producto: s.card?.producto || '',
        guia: s.card?.guia || '',
        lastMessage: last ? String(last.content || '').slice(0, 160) : '',
        lastMessageAt: last?.at || null,
        lastFromClient: Boolean(last && last.role === 'user'),
        lastClientAt: lastUser?.at || null,
      };
    })
    .sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
}

module.exports = { detectComplaint, isOpen, openPatch, open, resolvePatch, list, REASONS };

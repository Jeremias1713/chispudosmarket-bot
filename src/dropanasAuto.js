'use strict';

// Envio completamente automatico de etiquetas nuevas detectadas por el
// monitor de Dropanas. Permanece apagado salvo que se active expresamente
// en Render. Para evitar avisar a la persona equivocada, el modo automatico
// exige una coincidencia UNICA: primero por TELEFONO (evidencia mas
// fuerte), y si el telefono no matchea (por ejemplo, un numero cargado con
// algun digito distinto en Dropanas respecto al que quedo guardado en la
// conversacion), se acepta tambien una coincidencia por NOMBRE, pero solo
// si es 'exacto' segun el mismo criterio estricto de nameMatch.js (nombre
// completo igual, o el mas chico -2+ palabras- contenido entero en el mas
// grande) Y ademas es la UNICA conversacion candidata. Un parecido parcial
// (una sola palabra en comun, como "Ana" contra "Ana Maria") nunca alcanza
// para el modo automatico: esas siguen quedando para revision manual en el
// panel, igual que antes.
const dropanas = require('./dropanas');
const dropanasGuide = require('./dropanasGuide');
const { getSession, updateSession, listSessions } = require('./state');
const { mediaUrl } = require('./flow');
const { detectOrderConflict, buildGuiaPatch } = require('./orderGuard');
const { foldName, compareNames } = require('./nameMatch');
const shipping = require('./shipping');
const { matchOrder } = require('./orderMatch');
const { logisticRank, hasDropanasLink } = require('./stageRules');

// Cola en serie. Antes, si entraba un cambio mientras otro se estaba
// procesando, el segundo llamado devolvia el resultado del PRIMERO y su propio
// cambio nunca se procesaba (pasaba cuando DroPanas manda varios "Entregado"
// o "En oficina" juntos). Ahora cada llamado espera su turno y procesa lo suyo.
let queue = Promise.resolve();
let active = 0;

function configFromEnv(env = process.env) {
  return { enabled: String(env.DROPANAS_AUTO_SEND_ENABLED || '').toLowerCase() === 'true' };
}

function status() {
  const config = configFromEnv();
  const validatedGuideCount = listSessions().filter((session) => (
    session.shippingNotifiedAt && session.card?.guia && session.card?.guiaImageUrl
  )).length;
  return {
    enabled: config.enabled,
    running: active > 0,
    validatedGuideCount,
    realGuideValidated: validatedGuideCount > 0,
  };
}

function foldStatus(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

// DroPanas primero numera la guia de un pedido como "DP<numero de orden>" y
// despues, cuando la transportadora la procesa, la reemplaza por la guia real
// (por ejemplo Tealca 848xxxxx). El bot guardaba la primera y exigia que la
// guia del aviso fuera identica, asi que todos los avisos siguientes del MISMO
// pedido (llegada a oficina, entregado, novedad, devolucion) se descartaban en
// silencio con "guia_no_coincide". Aca se reconoce que son el mismo pedido
// usando el numero de orden de DroPanas, nunca el nombre ni la posicion.
const DP_GUIDE = /^DP\d+$/i;

function guideRelation(session, row) {
  const current = String(session?.card?.guia || '').trim();
  const incoming = String(row?.guia || '').trim();
  const orderId = String(row?.dropanasId || '').trim();
  if (!current) return { kind: 'none' };
  if (!incoming || current.toUpperCase() === incoming.toUpperCase()) return { kind: 'same' };
  const sameOrder = Boolean(orderId) && (
    current.toUpperCase() === `DP${orderId}`
    || String(session?.card?.dropanasId || '') === orderId
    || String(session?.dropanasOrder?.id || '') === orderId
  );
  // Una guia distinta sin prueba de que sea la misma orden puede ser OTRA
  // compra del mismo cliente: eso sigue quedando para revision manual.
  if (!sameOrder) return { kind: 'different' };
  // Nunca se "baja" de la guia real de la transportadora a la interna DP.
  if (DP_GUIDE.test(incoming)) return { kind: 'same' };
  return { kind: 'upgrade', from: current, to: incoming };
}

function upgradeGuidePatch(session, relation, row) {
  const card = { ...(session?.card || {}) };
  card.guia = relation.to;
  if (!card.guiaDropanas && DP_GUIDE.test(relation.from)) card.guiaDropanas = relation.from;
  card.dropanasId = String(row.dropanasId);
  return { card };
}

// Aplica la guia real sobre la sesion (si corresponde) y devuelve la sesion
// que hay que usar para armar el aviso, o el motivo por el que no se avisa.
function resolveGuide(deps, phone, session, row) {
  const relation = guideRelation(session, row);
  // Chat sin guia cargada (pedido subido a mano, o aviso de guia que fallo): el
  // evento trae la guia real, se completa antes de avisar para que el mensaje
  // lleve el numero. Antes todos los eventos de ese chat se descartaban.
  if (relation.kind === 'none' && String(row?.guia || '').trim()) {
    const patch = deps.buildGuiaPatch({
      session,
      guia: row.guia,
      agencia: row.bodegaDestino || row.ciudad || row.tipoEntrega || row.carrier || '-',
      isNewOrder: false,
    });
    if (row.dropanasId) patch.card.dropanasId = String(row.dropanasId);
    const saved = deps.updateSession(phone, patch);
    return { session: saved && saved.card ? saved : { ...session, ...patch }, relation: { kind: 'completed' } };
  }
  if (relation.kind === 'none' || relation.kind === 'different') return { reason: 'guia_no_coincide' };
  if (relation.kind !== 'upgrade') return { session, relation };
  const patch = upgradeGuidePatch(session, relation, row);
  const saved = deps.updateSession(phone, patch);
  return { session: saved && saved.card ? saved : { ...session, ...patch }, relation };
}

// Estados en los que NO corresponde mandar "tu paquete fue despachado",
// aunque el evento traiga una guia: el pedido se cancelo, se esta devolviendo
// o ya termino. Antes cualquiera de estos caia en el aviso de despacho.
const NO_SHIPPING_NOTICE = new Set([
  'cancelado', 'cancelada', 'anulado', 'anulada', 'rechazado', 'rechazada',
  'devuelto', 'devuelta', 'devolucion', 'en devolucion', 'pagado', 'pagada',
  'entregado', 'entregada',
]);

function isArrival(row) {
  return ['en oficina', 'en agencia', 'listo para retirar'].includes(foldStatus(row?.estadoPedido));
}

function statusAction(row) {
  const value = foldStatus(row?.estadoPedido);
  if (value === 'entregado') return { stage: 'entregado', notify: 'maybeNotifyDelivered' };
  // En DroPanas/Tealca "En novedad" casi siempre significa que el paquete YA esta
  // en la oficina y el cliente no fue contactado o no lo retiro: se le avisa la
  // llegada (en vez de la plantilla de novedad) y el chat pasa a esperando_retiro,
  // para que tambien entre en los recordatorios de retiro.
  if (['en novedad', 'novedad'].includes(value)) return { stage: 'esperando_retiro', notify: 'maybeNotifyArrival', source: 'novedad' };
  if (['pendiente devolucion', 'pendiente de devolucion'].includes(value)) {
    return { stage: 'pendiente_devolucion', notify: 'maybeNotifyReturnPending' };
  }
  return null;
}

// Cruce pedido -> conversacion: un solo algoritmo compartido con dropanas.js
// (orderMatch.js): orden, referencia, guia, telefono (incluido el que el
// cliente dio en el chat), cedula y nombre. Solo un match 'exacto' avanza; lo
// ambiguo queda para revision manual y se avisa por push (una vez por pedido).
function matchOrderToSession(row, sessions) {
  const m = matchOrder(row, sessions);
  if (m.matchType === 'exacto') return { phone: m.phone, session: m.session, evidence: m.evidence };
  return { reason: 'requiere_revision', ambiguous: m.matchType === 'ambiguo', candidates: m.candidates };
}

// Un chat puede recibir eventos de DroPanas si ya esta en una etapa logistica
// (rango >= 1) o, aunque la etapa sea conversacional, si el pedido esta cerrado
// o vinculado a DroPanas (pedido que el bot nunca marco como vendido).
function hasClosedOrder(session) {
  return session?.orderClosed === true || hasDropanasLink(session);
}
const FINISHED_STAGES = ['entregado', 'devolucion'];

// Novedades ya avisadas por push (en memoria): una vez por pedido.
const noveltyAlerted = new Set();

function alertNovelty(deps, row, session, notified) {
  const id = String(row?.dropanasId || row?.guia || '');
  if (!id || noveltyAlerted.has(id)) return;
  noveltyAlerted.add(id);
  try {
    const notify = deps.notifyAdmin || ((title, body) => require('./push').notifyAdmin(title, body));
    const nombre = session?.card?.nombre || session?.name || row?.cliente || session?.phone || '-';
    const p = notify('Novedad en un pedido', `Novedad: ${nombre} (${row?.guia || '-'}) ya en oficina. Se le avisó: ${notified ? 'sí' : 'no'}.`);
    if (p && p.catch) p.catch(() => {});
  } catch (error) {
    console.error('No se pudo avisar la novedad:', error.message);
  }
}

// Pedidos ambiguos ya avisados (en memoria): un push por pedido de DroPanas.
const ambiguousAlerted = new Set();

function alertAmbiguous(deps, row, candidates) {
  const id = String(row?.dropanasId || row?.guia || '');
  if (!id || ambiguousAlerted.has(id) || !Array.isArray(candidates) || candidates.length < 2) return;
  ambiguousAlerted.add(id);
  try {
    const notify = deps.notifyAdmin || ((title, body) => require('./push').notifyAdmin(title, body));
    const p = notify('Pedido DroPanas sin chat claro', `Pedido DroPanas ${id} (cliente ${row.cliente || '-'}) coincide con ${candidates.length} chats, revisar en el panel.`);
    if (p && p.catch) p.catch(() => {});
  } catch (error) {
    console.error('No se pudo avisar del pedido ambiguo:', error.message);
  }
}

// Si el pedido se cruzo por algo distinto del numero de orden y la ficha no lo
// tenia, se guarda: el proximo evento de ese pedido entra directo por ID.
function withOrderId(session, row, evidence) {
  if (evidence === 'orden' || !row?.dropanasId || session?.card?.dropanasId) return {};
  return { card: { ...(session?.card || {}), dropanasId: String(row.dropanasId) } };
}

async function processChanges(changes, overrides = {}) {
  if (!configFromEnv(overrides.env || process.env).enabled) return { enabled: false, results: [], acknowledged: [] };
  const turn = queue.then(() => runChanges(changes, overrides));
  queue = turn.catch(() => {});
  return turn;
}

async function runChanges(changes, overrides = {}) {
  active += 1;
  try {
    const deps = {
      matchRows: dropanas.matchRows,
      capture: dropanasGuide.capture,
      getSession,
      updateSession,
      mediaUrl,
      detectOrderConflict,
      buildGuiaPatch,
      maybeNotifyShipping: shipping.maybeNotifyShipping,
      maybeNotifyArrival: shipping.maybeNotifyArrival,
      maybeNotifyDelivered: shipping.maybeNotifyDelivered,
      maybeNotifyNovelty: shipping.maybeNotifyNovelty,
      maybeNotifyReturnPending: shipping.maybeNotifyReturnPending,
      listSessions,
      ...overrides,
    };
    const results = [];
    const acknowledged = [];
    const rows = (Array.isArray(changes) ? changes : [])
      .filter((change) => change?.order?.guia)
      .map((change) => ({ ...change.order, _pendingKey: change.key }));

    for (const row of deps.matchRows(rows)) {
      const action = statusAction(row);
      if (action) {
        const matched = matchOrderToSession(row, deps.listSessions());
        if (!matched.session) {
          if (matched.ambiguous) alertAmbiguous(deps, row, matched.candidates);
          results.push({ orderId: row.dropanasId, sent: false, reason: matched.reason });
          continue;
        }
        const { phone } = matched;
        // DroPanas es la fuente mas fuerte: puede avanzar el chat desde cualquier
        // etapa anterior. Nunca toca una devolucion ni repite un entregado.
        const currentStage = matched.session.stage;
        if (currentStage === 'devolucion' || (currentStage === action.stage && action.stage === 'entregado')) {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'ya_finalizado' });
          if (row._pendingKey) acknowledged.push(row._pendingKey);
          continue;
        }
        if (logisticRank(currentStage) < 1 && !hasClosedOrder(matched.session)) {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'sin_pedido_cerrado' });
          continue;
        }
        const guide = resolveGuide(deps, phone, matched.session, row);
        if (!guide.session) {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: guide.reason });
          continue;
        }
        const session = guide.session;
        if (action.source === 'novedad') {
          // Novedad = el paquete ya esta en la oficina. No retrocede un chat que ya
          // termino o va de vuelta (evento tardio): se confirma y listo.
          if (['entregado', 'pendiente_devolucion'].includes(currentStage)) {
            results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'ya_finalizado' });
            if (row._pendingKey) acknowledged.push(row._pendingKey);
            continue;
          }
          try {
            // Si ya se le aviso la llegada antes, NO se reenvia.
            const notice = session.arrivalNotifiedAt ? { sent: false, reason: 'ya_avisado' } : await deps.maybeNotifyArrival(phone, session);
            if (notice?.sent || notice?.reason === 'ya_avisado') {
              const nowIso = new Date().toISOString();
              const patch = { noveltyAt: nowIso, noveltyStatus: row.estadoPedido, ...withOrderId(session, row, matched.evidence) };
              if (currentStage !== 'esperando_retiro') {
                Object.assign(patch, {
                  stage: 'esperando_retiro',
                  stageLocked: false,
                  stageSource: 'dropanas_novedad',
                  stageUpdatedAt: nowIso,
                  stageReason: notice.sent ? 'DroPanas: En novedad (aviso de llegada enviado)' : 'DroPanas: En novedad',
                });
              }
              // Dia 0 de los recordatorios 1, 3 y 5.
              if (!session.pickupReminderAnchorDate) patch.pickupReminderAnchorDate = nowIso.slice(0, 10);
              deps.updateSession(phone, patch);
              if (row._pendingKey) acknowledged.push(row._pendingKey);
              alertNovelty(deps, row, session, Boolean(notice.sent) || Boolean(session.arrivalNotifiedAt));
            }
            results.push({ orderId: row.dropanasId, phone, stage: 'esperando_retiro', sent: Boolean(notice?.sent), notice });
          } catch (error) {
            results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'error', error: error.message });
          }
          continue;
        }
        try {
          const notice = await deps[action.notify](phone, session);
          if (notice?.sent || notice?.reason === 'ya_avisado') {
            deps.updateSession(phone, {
              stage: action.stage,
              stageLocked: false,
              stageSource: 'dropanas',
              stageUpdatedAt: new Date().toISOString(),
              stageReason: `DroPanas: ${row.estadoPedido}`,
              ...withOrderId(session, row, matched.evidence),
            });
            if (row._pendingKey) acknowledged.push(row._pendingKey);
          }
          results.push({ orderId: row.dropanasId, phone, stage: action.stage, sent: Boolean(notice?.sent), notice });
        } catch (error) {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'error', error: error.message });
        }
        continue;
      }

      if (isArrival(row)) {
        const matched = matchOrderToSession(row, deps.listSessions());
        if (!matched.session) {
          if (matched.ambiguous) alertAmbiguous(deps, row, matched.candidates);
          results.push({ orderId: row.dropanasId, sent: false, reason: matched.reason });
          continue;
        }
        const { phone } = matched;
        const currentStage = matched.session.stage;
        const rank = logisticRank(currentStage);
        if (FINISHED_STAGES.includes(currentStage) || currentStage === 'pendiente_devolucion') {
          // Ya termino (o va de vuelta): no se toca y se confirma el evento para
          // que no quede reintentandose 8 veces.
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'ya_finalizado' });
          if (row._pendingKey) acknowledged.push(row._pendingKey);
          continue;
        }
        if (rank < 1 && !hasClosedOrder(matched.session)) {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'sin_pedido_cerrado' });
          continue;
        }
        const guide = resolveGuide(deps, phone, matched.session, row);
        if (!guide.session) {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: guide.reason });
          continue;
        }
        const session = guide.session;
        try {
          const notice = await deps.maybeNotifyArrival(phone, session);
          if (notice?.sent || notice?.reason === 'ya_avisado') {
            deps.updateSession(phone, {
              stage: 'esperando_retiro',
              stageLocked: false,
              stageSource: 'dropanas',
              stageUpdatedAt: new Date().toISOString(),
              stageReason: 'DroPanas: pedido en oficina',
              ...withOrderId(session, row, matched.evidence),
            });
            if (row._pendingKey) acknowledged.push(row._pendingKey);
          }
          results.push({ orderId: row.dropanasId, phone, sent: Boolean(notice?.sent), notice });
        } catch (error) {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'error', error: error.message });
        }
        continue;
      }

      if (NO_SHIPPING_NOTICE.has(foldStatus(row.estadoPedido))) {
        results.push({ orderId: row.dropanasId, sent: false, reason: 'estado_sin_aviso_de_despacho' });
        continue;
      }
      if (!['tealca', 'zoom', 'mrw'].includes(row.carrier)) {
        results.push({ orderId: row.dropanasId, sent: false, reason: 'transportista_sin_descarga_automatica' });
        continue;
      }
      // FASE 3i: antes exigia ademas row.matchEvidence === 'telefono', o sea
      // que un match por NOMBRE exacto y unico (dropanas.js ya lo calcula
      // igual de estricto que aca arriba) quedaba afuera del automatico
      // aunque fuera confiable. Ahora alcanza con matchType === 'exacto'
      // (por telefono o por nombre), manteniendo la misma exigencia de
      // unicidad que ya tenia matchRow().
      if (row.matchType !== 'exacto' || !row.phone) {
        if (row.matchType === 'ambiguo') alertAmbiguous(deps, row, row.candidates);
        results.push({ orderId: row.dropanasId, sent: false, reason: 'requiere_revision' });
        continue;
      }
      // "vendido" y "esperando_guia" son igual de validos para la primera guia
      // (mismo criterio que dropanas.js/stageRules). Antes aca se exigia
      // "esperando_guia" exacto, una etapa que solo se fija a mano, asi que
      // la mayoria de las ventas nunca recibia el aviso de despacho.
      let upgrade = null;
      if (!row.sendEligible) {
        const current = deps.getSession(row.phone);
        const relation = guideRelation(current, row);
        if (relation.kind !== 'upgrade') {
          results.push({ orderId: row.dropanasId, phone: row.phone, sent: false, reason: 'estado_no_esperando_guia' });
          continue;
        }
        // Llego la guia real de un pedido que ya estaba en camino con la guia
        // interna DP: se actualiza siempre, para que los avisos que siguen
        // muestren el numero de la transportadora. El aviso de despacho solo
        // se manda si nunca se habia mandado (no se repite).
        if (current.shippingNotifiedAt || current.stage !== 'en_camino') {
          deps.updateSession(row.phone, upgradeGuidePatch(current, relation, row));
          results.push({ orderId: row.dropanasId, phone: row.phone, sent: false, reason: 'guia_actualizada' });
          if (row._pendingKey) acknowledged.push(row._pendingKey);
          continue;
        }
        upgrade = relation;
      }

      try {
        const session = deps.getSession(row.phone);
        const conflict = upgrade ? null : deps.detectOrderConflict(session, row.guia);
        if (conflict) {
          results.push({ orderId: row.dropanasId, phone: row.phone, sent: false, reason: 'pedido_nuevo_sin_confirmar' });
          continue;
        }

        const captured = row.guideImageFilename
          ? { filename: row.guideImageFilename }
          : await deps.capture({
            orderId: row.dropanasId,
            expectedTracking: row.guia,
            expectedCarrier: row.carrier,
          });
        const guiaImageUrl = deps.mediaUrl(captured.filename);
        if (!guiaImageUrl) throw new Error('Falta configurar PUBLIC_URL');

        const patch = deps.buildGuiaPatch({
          session,
          guia: row.guia,
          guiaImageUrl,
          agencia: row.bodegaDestino || row.ciudad || row.tipoEntrega || row.carrier || '-',
          isNewOrder: false,
        });
        const card = patch.card;
        if (!card.producto && row.producto) card.producto = row.producto;
        const amount = Number(row.totalVentaBs);
        if (card.monto == null && Number.isFinite(amount) && amount > 0) card.monto = amount;
        if (upgrade && !patch.card.guiaDropanas && DP_GUIDE.test(upgrade.from)) patch.card.guiaDropanas = upgrade.from;
        // Se guarda el numero de orden: asi, cuando DroPanas cambie la guia
        // de este pedido, los avisos siguientes lo siguen reconociendo.
        // (si el cruce fue por orden ya lo tenia; si fue por telefono/nombre/etc, se aprende aqui)
        if (row.dropanasId) patch.card.dropanasId = String(row.dropanasId);
        const updated = deps.updateSession(row.phone, patch);
        const notice = await deps.maybeNotifyShipping(row.phone, updated);
        results.push({ orderId: row.dropanasId, phone: row.phone, sent: Boolean(notice?.sent), notice });
        if (notice?.sent && row._pendingKey) acknowledged.push(row._pendingKey);
      } catch (error) {
        results.push({ orderId: row.dropanasId, phone: row.phone, sent: false, reason: 'error', error: error.message });
      }
    }

    return { enabled: true, results, acknowledged };
  } finally {
    active -= 1;
  }
}

module.exports = { configFromEnv, status, processChanges, guideRelation };

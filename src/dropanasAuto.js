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
const { mediaUrl, repurchasePatch } = require('./flow');
const { detectOrderConflict, buildGuiaPatch } = require('./orderGuard');
const { foldName, compareNames } = require('./nameMatch');
const shipping = require('./shipping');
const { matchOrder } = require('./orderMatch');
const { logisticRank, hasDropanasLink, NON_LOGISTIC_STAGES } = require('./stageRules');
const { classifyStatus, isOfficeKind, recordUnknown } = require('./dropanasStatus');

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

// "Pagado" con el setting dropanasPaidMeansDelivered apagado cae como estado
// desconocido: igual NUNCA corresponde mandarle "tu paquete fue despachado".
// (El resto de los estados finales ahora tienen su propio camino, ver
// dropanasStatus.js.)
const NO_SHIPPING_NOTICE = new Set(['pagado', 'pagada']);

// Cruce pedido -> conversacion: un solo algoritmo compartido con dropanas.js
// (orderMatch.js): orden, referencia, guia, telefono (incluido el que el
// cliente dio en el chat), cedula y nombre. Solo un match 'exacto' avanza; lo
// ambiguo queda para revision manual y se avisa por push (una vez por pedido).
function matchOrderToSession(row, sessions) {
  const m = matchOrder(row, sessions);
  if (m.matchType === 'exacto') return { phone: m.phone, session: m.session, evidence: m.evidence };
  return { reason: 'requiere_revision', ambiguous: m.matchType === 'ambiguo', candidates: m.candidates };
}

// S4, bug real: un pedido subido a mano a DroPanas, o un chat que quedo en
// negociando/interesado (la validacion "no marcar vendido sin datos" lo deja
// asi), nunca recibia la guia (estado_no_esperando_guia), nunca pasaba a
// en_camino y despues la llegada se bloqueaba con sin_pedido_cerrado. Si
// DroPanas tiene una guia real y el cruce es por evidencia fuerte, el pedido
// ES una venta: se cierra. Con match solo por nombre o por telefono+etapa no.
const STRONG_EVIDENCE = new Set(['orden', 'referencia', 'referencia_telefono', 'guia', 'telefono', 'telefono+cedula', 'telefono+nombre', 'cedula']);

function canCloseFromDropanas(session, evidence) {
  return STRONG_EVIDENCE.has(evidence) && NON_LOGISTIC_STAGES.includes(session?.stage || 'nuevo') && !hasClosedOrder(session);
}

function closeOrderPatch(session, row) {
  const createdAt = Date.parse(row?.createdAt || '');
  return {
    orderClosed: true,
    soldAt: session?.soldAt || (Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : new Date().toISOString()),
    stage: 'vendido',
    stageLocked: false,
    stageSource: 'dropanas',
    stageUpdatedAt: new Date().toISOString(),
    stageReason: 'DroPanas: hay guia real, el pedido se cierra aunque el chat no haya quedado en vendido',
  };
}

// S5, bug real: las marcas de aviso son por chat. En la segunda compra del
// mismo cliente, guideRelation daba 'different' (otra guia, otro pedido) y
// todo se descartaba con guia_no_coincide; y aunque pasara, las marcas del
// pedido anterior hacian que maybeNotify* respondiera ya_avisado. Ahora, con
// evidencia fuerte, si el pedido anterior termino (o el nuevo es el que subio
// el bot para la recompra) se archiva el anterior y se sigue con el nuevo.
const FINISHED_STAGES = ['entregado', 'devolucion'];

function isNewOrderForSession(session, row) {
  if (row?.dropanasId && String(session?.dropanasOrder?.id || '') === String(row.dropanasId)) return true;
  return FINISHED_STAGES.includes(session?.stage);
}

function startNewOrder(deps, phone, session, row) {
  const nowIso = new Date().toISOString();
  const uploadedIsNew = row?.dropanasId && String(session?.dropanasOrder?.id || '') === String(row.dropanasId);
  // Si el dropanasOrder del chat ES el pedido nuevo, no se archiva como viejo.
  const base = uploadedIsNew ? { ...session, dropanasOrder: null } : session;
  const patch = deps.repurchasePatch(base, nowIso);
  if (uploadedIsNew) patch.dropanasOrder = session.dropanasOrder;
  const createdAt = Date.parse(row?.createdAt || '');
  if (Number.isFinite(createdAt)) patch.soldAt = new Date(createdAt).toISOString();
  Object.assign(patch, {
    stageSource: 'dropanas',
    stageReason: 'DroPanas: pedido nuevo del mismo cliente (el anterior quedó archivado)',
    notifiedForOrderId: null,
    notifiedForGuia: null,
    notifyFailed: null,
    notifyRetries: null,
  });
  const saved = deps.updateSession(phone, patch);
  return saved && saved.card ? saved : { ...session, ...patch };
}


function alertTwoOpen(deps, session, row) {
  const key = `${session?.phone}:${row?.dropanasId || row?.guia}`;
  if (!alertOnce(deps, 'twoOpen', key)) return;
  try {
    const notify = deps.notifyAdmin || ((title, body) => require('./push').notifyAdmin(title, body));
    const nombre = session?.card?.nombre || session?.name || session?.phone || '-';
    const p = notify('Cliente con dos pedidos abiertos', `Cliente ${nombre} tiene dos pedidos abiertos (guías ${session?.card?.guia || '-'} y ${row?.guia || '-'}), revisar.`);
    if (p && p.catch) p.catch(() => {});
  } catch (error) {
    console.error('No se pudo avisar los dos pedidos abiertos:', error.message);
  }
}

// Un chat puede recibir eventos de DroPanas si ya esta en una etapa logistica
// (rango >= 1) o, aunque la etapa sea conversacional, si el pedido esta cerrado
// o vinculado a DroPanas (pedido que el bot nunca marco como vendido).
function hasClosedOrder(session) {
  return session?.orderClosed === true || hasDropanasLink(session);
}

// S7: los pushes ya enviados se guardan en dropanas-api-state.json (antes en
// memoria: con cada reinicio de Render se repetian).
function alertOnce(deps, kind, id) {
  if (!id) return false;
  const store = deps.alertStore || require('./dropanasMonitor');
  if (store.wasAlerted(kind, id)) return false;
  store.markAlerted(kind, id);
  return true;
}

function alertNovelty(deps, row, session, notified) {
  const id = String(row?.dropanasId || row?.guia || '');
  if (!alertOnce(deps, 'novelty', id)) return;
  try {
    const notify = deps.notifyAdmin || ((title, body) => require('./push').notifyAdmin(title, body));
    const nombre = session?.card?.nombre || session?.name || row?.cliente || session?.phone || '-';
    const p = notify('Novedad en un pedido', `Novedad: ${nombre} (${row?.guia || '-'}) ya en oficina. Se le avisó: ${notified ? 'sí' : 'no'}.`);
    if (p && p.catch) p.catch(() => {});
  } catch (error) {
    console.error('No se pudo avisar la novedad:', error.message);
  }
}


function alertAmbiguous(deps, row, candidates) {
  const id = String(row?.dropanasId || row?.guia || '');
  if (!Array.isArray(candidates) || candidates.length < 2 || !alertOnce(deps, 'ambiguous', id)) return;
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

const STATUS_KINDS = new Set(['delivered', 'returned', 'return_pending', 'in_office', 'novelty']);


// Cancelado/anulado/rechazado: no se cambia la etapa sola (puede ser un error
// de carga que se corrige), se le avisa a Jere una vez y se confirma el evento.
function handleCancelled(deps, row, results, acknowledged) {
  const matched = matchOrderToSession(row, deps.listSessions());
  const id = String(row?.dropanasId || row?.guia || '');
  if (alertOnce(deps, 'cancelled', id)) {
    try {
      const notify = deps.notifyAdmin || ((title, body) => require('./push').notifyAdmin(title, body));
      const nombre = matched.session?.card?.nombre || matched.session?.name || row?.cliente || '-';
      const p = notify('Pedido DroPanas cancelado', `El pedido ${id} de ${nombre} quedó "${row.estadoPedido}" en DroPanas. Revisa el chat.`);
      if (p && p.catch) p.catch(() => {});
    } catch (error) {
      console.error('No se pudo avisar el pedido cancelado:', error.message);
    }
  }
  results.push({ orderId: row.dropanasId, phone: matched.phone || null, sent: false, reason: 'cancelado' });
  if (row._pendingKey) acknowledged.push(row._pendingKey);
}

function stagePatch(stage, reason, extra = {}) {
  return {
    stage,
    stageLocked: false,
    stageSource: 'dropanas',
    stageUpdatedAt: new Date().toISOString(),
    stageReason: reason,
    ...extra,
  };
}

// Estados que mueven la etapa del chat: entregado/pagado, devuelto, pendiente
// de devolucion, en oficina y en novedad.
async function handleStatus(deps, row, st, results, acknowledged) {
  const matched = matchOrderToSession(row, deps.listSessions());
  if (!matched.session) {
    if (matched.ambiguous) alertAmbiguous(deps, row, matched.candidates);
    results.push({ orderId: row.dropanasId, sent: false, reason: matched.reason });
    return;
  }
  const { phone } = matched;
  let baseSession = matched.session;
  if (guideRelation(baseSession, row).kind === 'different' && STRONG_EVIDENCE.has(matched.evidence)) {
    if (!isNewOrderForSession(baseSession, row)) {
      alertTwoOpen(deps, baseSession, row);
      results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'dos_pedidos_abiertos' });
      return;
    }
    baseSession = startNewOrder(deps, phone, baseSession, row);
  }
  const currentStage = baseSession.stage;
  const ack = () => { if (row._pendingKey) acknowledged.push(row._pendingKey); };
  // Ya termino (o va de vuelta): no se toca y se confirma el evento. Un
  // "Devuelto" si se aplica sobre un entregado (devolucion tardia).
  const finished = st.kind === 'returned'
    ? currentStage === 'devolucion'
    : currentStage === 'devolucion'
      || (st.kind === 'delivered' && currentStage === 'entregado')
      || (isOfficeKind(st.kind) && ['entregado', 'pendiente_devolucion'].includes(currentStage));
  if (finished) {
    results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'ya_finalizado' });
    ack();
    return;
  }
  if (logisticRank(currentStage) < 1 && !hasClosedOrder(baseSession)) {
    if (!canCloseFromDropanas(baseSession, matched.evidence)) {
      results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'sin_pedido_cerrado' });
      return;
    }
    const closePatch = closeOrderPatch(baseSession, row);
    const saved = deps.updateSession(phone, closePatch);
    baseSession = saved && saved.card ? saved : { ...baseSession, ...closePatch };
  }
  const guide = resolveGuide(deps, phone, baseSession, row);
  if (!guide.session) {
    results.push({ orderId: row.dropanasId, phone, sent: false, reason: guide.reason });
    return;
  }
  const session = guide.session;
  const orderIdPatch = withOrderId(session, row, matched.evidence);

  try {
    if (st.kind === 'returned') {
      // Devuelto: sin mensaje al cliente, solo la etapa.
      deps.updateSession(phone, stagePatch('devolucion', `DroPanas: ${row.estadoPedido}`, orderIdPatch));
      results.push({ orderId: row.dropanasId, phone, stage: 'devolucion', sent: false, silent: true });
      ack();
      return;
    }
    if (st.kind === 'delivered' && st.paid) {
      // "Pagado" puede llegar dias despues del retiro: no se manda el
      // agradecimiento, solo se mueve la etapa.
      deps.updateSession(phone, stagePatch('entregado', `DroPanas: ${row.estadoPedido} (retiró y pagó)`, orderIdPatch));
      results.push({ orderId: row.dropanasId, phone, stage: 'entregado', sent: false, silent: true });
      ack();
      return;
    }
    if (st.kind === 'novelty') {
      // Novedad = el paquete ya esta en la oficina. Si ya se le aviso la
      // llegada antes, NO se reenvia.
      const notice = shipping.alreadyNotified(session, 'arrivalNotifiedAt') ? { sent: false, reason: 'ya_avisado' } : await deps.maybeNotifyArrival(phone, session);
      if (notice?.sent || notice?.reason === 'ya_avisado') {
        const nowIso = new Date().toISOString();
        const patch = { noveltyAt: nowIso, noveltyStatus: row.estadoPedido, ...orderIdPatch };
        if (currentStage !== 'esperando_retiro') {
          Object.assign(patch, stagePatch('esperando_retiro', notice.sent ? 'DroPanas: En novedad (aviso de llegada enviado)' : 'DroPanas: En novedad'), { stageSource: 'dropanas_novedad' });
        }
        // Dia 0 de los recordatorios 1, 3 y 5.
        if (!session.pickupReminderAnchorDate) patch.pickupReminderAnchorDate = nowIso.slice(0, 10);
        deps.updateSession(phone, patch);
        ack();
        alertNovelty(deps, row, session, Boolean(notice.sent) || shipping.alreadyNotified(session, 'arrivalNotifiedAt'));
      }
      results.push({ orderId: row.dropanasId, phone, stage: 'esperando_retiro', sent: Boolean(notice?.sent), notice });
      return;
    }
    const plan = st.kind === 'in_office'
      ? { notify: 'maybeNotifyArrival', stage: 'esperando_retiro', reason: 'DroPanas: pedido en oficina' }
      : st.kind === 'delivered'
        ? { notify: 'maybeNotifyDelivered', stage: 'entregado', reason: `DroPanas: ${row.estadoPedido}` }
        : { notify: 'maybeNotifyReturnPending', stage: 'pendiente_devolucion', reason: `DroPanas: ${row.estadoPedido}` };
    const notice = await deps[plan.notify](phone, session);
    if (notice?.sent || notice?.reason === 'ya_avisado') {
      deps.updateSession(phone, stagePatch(plan.stage, plan.reason, orderIdPatch));
      ack();
    }
    results.push({ orderId: row.dropanasId, phone, stage: plan.stage, sent: Boolean(notice?.sent), notice });
  } catch (error) {
    results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'error', error: error.message });
  }
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
      recordUnknown,
      repurchasePatch,
      ...overrides,
    };
    const results = [];
    const acknowledged = [];
    const closedNow = new Map();
    const rows = (Array.isArray(changes) ? changes : [])
      .filter((change) => change?.order?.guia)
      .map((change) => ({ ...change.order, _pendingKey: change.key }));

    for (const row of deps.matchRows(rows)) {
      const st = classifyStatus(row.estadoPedido, deps.settings);
      if (st.kind === 'cancelled') {
        handleCancelled(deps, row, results, acknowledged);
        continue;
      }
      if (STATUS_KINDS.has(st.kind)) {
        await handleStatus(deps, row, st, results, acknowledged);
        continue;
      }
      if (st.kind === 'unknown' && String(row.estadoPedido || '').trim()) deps.recordUnknown(row.estadoPedido, row.dropanasId);

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
      // S5: dropanas.matchRow no mira chats "entregado" (para no mezclar
      // guias viejas). Si no hubo cruce, se prueba contra todos los chats: una
      // recompra de un cliente con el pedido anterior entregado si es valida.
      if (row.matchType !== 'exacto' || !row.phone) {
        const retry = matchOrderToSession(row, deps.listSessions());
        if (retry.session && STRONG_EVIDENCE.has(retry.evidence) && FINISHED_STAGES.includes(retry.session.stage)
          && guideRelation(retry.session, row).kind === 'different') {
          Object.assign(row, { matchType: 'exacto', matchEvidence: retry.evidence, phone: retry.phone, sendEligible: false });
        }
      }
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
      let eligible = row.sendEligible;
      if (STRONG_EVIDENCE.has(row.matchEvidence)) {
        const before = deps.getSession(row.phone);
        const relation = guideRelation(before, row);
        if (relation.kind === 'different') {
          if (!isNewOrderForSession(before, row)) {
            alertTwoOpen(deps, before, row);
            results.push({ orderId: row.dropanasId, phone: row.phone, sent: false, reason: 'dos_pedidos_abiertos' });
            continue;
          }
          const fresh = startNewOrder(deps, row.phone, before, row);
          closedNow.set(row.phone, { stage: fresh.stage, orderClosed: true, card: fresh.card, shippingNotifiedAt: null, arrivalNotifiedAt: null });
          eligible = true;
        }
      }
      if (!eligible) {
        const before = deps.getSession(row.phone);
        if (canCloseFromDropanas(before, row.matchEvidence)) {
          const closePatch = closeOrderPatch(before, row);
          const saved = deps.updateSession(row.phone, closePatch);
          // Por si getSession no refleja todavia el cierre recien guardado.
          if (!(saved && saved.card)) closedNow.set(row.phone, closePatch);
          eligible = true;
        }
      }
      if (!eligible) {
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
        const session = { ...deps.getSession(row.phone), ...(closedNow.get(row.phone) || {}) };
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
        // S7: un aviso de guia que ya se habia mandado tambien se confirma (antes
        // quedaba reintentandose en la cola).
        if ((notice?.sent || notice?.reason === 'ya_avisado') && row._pendingKey) acknowledged.push(row._pendingKey);
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

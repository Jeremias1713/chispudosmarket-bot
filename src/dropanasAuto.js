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

let running = null;

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
    running: Boolean(running),
    validatedGuideCount,
    realGuideValidated: validatedGuideCount > 0,
  };
}

function foldStatus(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function isArrival(row) {
  return ['en oficina', 'en agencia', 'listo para retirar'].includes(foldStatus(row?.estadoPedido));
}

function statusAction(row) {
  const value = foldStatus(row?.estadoPedido);
  if (value === 'entregado') return { stage: 'entregado', notify: 'maybeNotifyDelivered' };
  if (['en novedad', 'novedad'].includes(value)) return { stage: 'novedad', notify: 'maybeNotifyNovelty' };
  if (['pendiente devolucion', 'pendiente de devolucion'].includes(value)) {
    return { stage: 'pendiente_devolucion', notify: 'maybeNotifyReturnPending' };
  }
  return null;
}

// FASE 3i: antes se llamaba matchArrivalByPhone y solo miraba telefono. Se
// le agrego el mismo respaldo por nombre exacto/unico que ya tenia el aviso
// de guia nueva mas abajo (ver comentario del encabezado del archivo).
function matchOrderToSession(row, sessions) {
  const phone = require('./dropanasApi').normalizePhone(row?.telefono);
  if (phone) {
    const byPhone = sessions.filter((session) => {
      const candidate = require('./dropanasApi').normalizePhone(session.phone || session.card?.telefono);
      return candidate && candidate === phone;
    });
    if (byPhone.length === 1) return { phone: byPhone[0].phone, session: byPhone[0] };
    if (byPhone.length > 1) return { reason: 'requiere_revision' };
  }
  const target = foldName(row?.cliente);
  if (!target) return { reason: 'requiere_revision' };
  const exactas = sessions.filter((session) => {
    const nombre = session.card?.nombre || session.name || '';
    return foldName(nombre) && compareNames(nombre, row.cliente) === 'exacto';
  });
  if (exactas.length !== 1) return { reason: 'requiere_revision' };
  return { phone: exactas[0].phone, session: exactas[0] };
}

async function processChanges(changes, overrides = {}) {
  if (!configFromEnv(overrides.env || process.env).enabled) return { enabled: false, results: [], acknowledged: [] };
  if (running) return running;

  running = (async () => {
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
          results.push({ orderId: row.dropanasId, sent: false, reason: matched.reason });
          continue;
        }
        const { phone, session } = matched;
        if (!['en_camino', 'esperando_retiro', 'novedad', 'pendiente_devolucion'].includes(session.stage)) {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'estado_logistico_invalido' });
          continue;
        }
        if (!session.card?.guia || (row.guia && String(session.card.guia) !== String(row.guia))) {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'guia_no_coincide' });
          continue;
        }
        try {
          const notice = await deps[action.notify](phone, session);
          if (notice?.sent || notice?.reason === 'ya_avisado') {
            deps.updateSession(phone, {
              stage: action.stage,
              stageLocked: true,
              stageReason: `DroPanas: ${row.estadoPedido}`,
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
          results.push({ orderId: row.dropanasId, sent: false, reason: matched.reason });
          continue;
        }
        const { phone, session } = matched;
        if (session.stage !== 'en_camino') {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'estado_no_en_camino' });
          continue;
        }
        if (!session.card?.guia || (row.guia && String(session.card.guia) !== String(row.guia))) {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'guia_no_coincide' });
          continue;
        }
        try {
          const notice = await deps.maybeNotifyArrival(phone, session);
          if (notice?.sent || notice?.reason === 'ya_avisado') {
            deps.updateSession(phone, {
              stage: 'esperando_retiro',
              stageLocked: true,
              stageReason: 'DroPanas: pedido en oficina',
            });
            if (row._pendingKey) acknowledged.push(row._pendingKey);
          }
          results.push({ orderId: row.dropanasId, phone, sent: Boolean(notice?.sent), notice });
        } catch (error) {
          results.push({ orderId: row.dropanasId, phone, sent: false, reason: 'error', error: error.message });
        }
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
        results.push({ orderId: row.dropanasId, sent: false, reason: 'requiere_revision' });
        continue;
      }
      if (!row.sendEligible || row.shippingStage !== 'esperando_guia') {
        results.push({ orderId: row.dropanasId, phone: row.phone, sent: false, reason: 'estado_no_esperando_guia' });
        continue;
      }

      try {
        const session = deps.getSession(row.phone);
        const conflict = deps.detectOrderConflict(session, row.guia);
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
        const updated = deps.updateSession(row.phone, patch);
        const notice = await deps.maybeNotifyShipping(row.phone, updated);
        results.push({ orderId: row.dropanasId, phone: row.phone, sent: Boolean(notice?.sent), notice });
        if (notice?.sent && row._pendingKey) acknowledged.push(row._pendingKey);
      } catch (error) {
        results.push({ orderId: row.dropanasId, phone: row.phone, sent: false, reason: 'error', error: error.message });
      }
    }

    return { enabled: true, results, acknowledged };
  })();

  try {
    return await running;
  } finally {
    running = null;
  }
}

module.exports = { configFromEnv, status, processChanges };

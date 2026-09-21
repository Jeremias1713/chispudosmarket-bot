'use strict';

// Envio completamente automatico de etiquetas nuevas detectadas por el
// monitor de Dropanas. Permanece apagado salvo que se active expresamente
// en Render. Para evitar avisar a la persona equivocada, el modo automatico
// solo acepta una coincidencia unica por TELEFONO; las coincidencias por
// nombre siguen apareciendo en el panel para revision manual.
const dropanas = require('./dropanas');
const dropanasGuide = require('./dropanasGuide');
const { getSession, updateSession } = require('./state');
const { mediaUrl } = require('./flow');
const { detectOrderConflict, buildGuiaPatch } = require('./orderGuard');
const shipping = require('./shipping');

let running = null;

function configFromEnv(env = process.env) {
  return { enabled: String(env.DROPANAS_AUTO_SEND_ENABLED || '').toLowerCase() === 'true' };
}

function status() {
  const config = configFromEnv();
  return { enabled: config.enabled, running: Boolean(running) };
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
      ...overrides,
    };
    const results = [];
    const acknowledged = [];
    const rows = (Array.isArray(changes) ? changes : [])
      .filter((change) => change?.order?.guia)
      .map((change) => ({ ...change.order, _pendingKey: change.key }));

    for (const row of deps.matchRows(rows)) {
      if (!['tealca', 'zoom', 'mrw'].includes(row.carrier)) {
        results.push({ orderId: row.dropanasId, sent: false, reason: 'transportista_sin_descarga_automatica' });
        continue;
      }
      if (row.matchType !== 'exacto' || row.matchEvidence !== 'telefono' || !row.phone) {
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

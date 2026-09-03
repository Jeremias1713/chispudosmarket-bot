// Seguimiento diario del pedido con el Excel que exporta Dropanas (el mismo
// que ya se usa para cargar numeros de guia, ver dropanas.js — este modulo
// SOLO agrega la parte de "actualizar etapas y avisar que ya se puede
// retirar", reusando el mismo cruce por nombre de cliente).
//
// Idea: el negocio sube el Excel una vez al dia. Segun la columna "Estado
// Pedido" de cada fila:
//   - "En oficina"  -> el pedido ya esta en la agencia: se pasa la
//     conversacion a la etapa "esperando_retiro" Y se manda la plantilla de
//     "ya podes retirarlo" (pedido_ha_llegado_a_tealca), con nombre,
//     producto, numero de guia y monto sacados DIRECTO de esa misma fila.
//   - "En camino" / "En transito" -> etapa "en_camino", sin mandar nada.
//   - "Entregado" -> etapa "entregado", sin mandar nada.
//   - Cualquier otro estado (Pagado, Cancelado, En novedad, Pendiente
//     devolucion, Devolucion, Generada, Pendiente...) -> no se toca nada
//     todavia (no hay una regla confirmada para esos), se lista aparte en
//     el panel como "sin accion, revisar si queres".
//
// Nunca manda ni cambia nada por su cuenta: arma la lista completa para que
// el negocio la revise en el panel y recien mande/actualice lo que confirme
// (ver /api/seguimiento/preview y /api/seguimiento/confirm en panel.js).
const { listSessions, updateSession } = require('./state');
const { SOLD_STAGES } = require('./flow');
const { sendTemplate } = require('./whatsapp');
const { getSettings } = require('./settings');

function foldName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Mismo criterio que dropanas.js: conversaciones ya vendidas y que todavia
// no estan "entregado" son las candidatas a que este cruce las actualice
// (una vez entregado, no hace falta seguir tocandolas desde aca).
function candidateSessions() {
  return listSessions().filter((s) => SOLD_STAGES.includes(s.stage || 'nuevo') && s.stage !== 'entregado');
}

function matchCliente(clienteRaw) {
  const target = foldName(clienteRaw);
  if (!target) return { matchType: 'sin_match', candidates: [] };
  const candidates = candidateSessions().filter((s) => {
    const nombre = foldName(s.card?.nombre || s.name || '');
    return nombre && (nombre === target || nombre.includes(target) || target.includes(nombre));
  });
  if (candidates.length === 1) return { matchType: 'exacto', candidates };
  if (candidates.length > 1) return { matchType: 'ambiguo', candidates };
  return { matchType: 'sin_match', candidates: [] };
}

// Mapeo confirmado con el negocio (ver conversacion): solo estos tres
// estados tienen una regla clara hoy. Todo lo demas queda sin tocar.
const ESTADO_A_ETAPA = {
  'en oficina': 'esperando_retiro',
  'en camino': 'en_camino',
  'en transito': 'en_camino', // por si Dropanas lo manda sin tilde
  entregado: 'entregado',
};

function firstName(full) {
  return String(full || '').trim().split(/\s+/)[0] || '';
}

// Ej. 34900 -> "34900bs" (mismo formato que usan las plantillas ya
// aprobadas). Si el numero tiene decimales reales los conserva.
function formatMonto(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  const texto = Number.isInteger(num) ? String(num) : num.toFixed(2);
  return texto + 'bs';
}

// rows: la salida de dropanas.parseExportBuffer (ya trae guia, cliente,
// ciudad, producto, estadoPedido, totalVentaBs, bodegaDestino).
function buildPreview(rows) {
  return rows.map((row) => {
    const estadoFold = foldName(row.estadoPedido);
    const etapaNueva = ESTADO_A_ETAPA[estadoFold] || null;
    const enviarPlantilla = etapaNueva === 'esperando_retiro';
    const { matchType, candidates } = matchCliente(row.cliente);

    return {
      guia: row.guia,
      cliente: row.cliente,
      ciudad: row.ciudad,
      producto: row.producto,
      estadoPedido: row.estadoPedido,
      etapaNueva,
      enviarPlantilla,
      matchType,
      candidates: candidates.map((s) => ({ phone: s.phone, nombre: s.card?.nombre || s.name || '', stage: s.stage })),
      phone: matchType === 'exacto' ? candidates[0].phone : null,
      plantillaVars: enviarPlantilla
        ? {
            nombre: firstName(row.cliente),
            producto: row.producto,
            guia: row.guia,
            monto: formatMonto(row.totalVentaBs),
          }
        : null,
    };
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DELAY_MS = 1200;

// items: los que el negocio reviso y marco en el panel, cada uno con
// { phone, etapaNueva, enviarPlantilla, plantillaVars }. Actualiza la etapa
// (si corresponde) y manda la plantilla (si corresponde), uno por uno.
async function applyItems(items) {
  const settings = getSettings();
  const templateName = settings.pickupTemplateName || 'pedido_ha_llegado_a_tealca';
  const languageCode = settings.pickupTemplateLanguage || 'es';

  const results = [];
  for (const item of items) {
    if (!item.phone) {
      results.push({ phone: item.phone, ok: false, error: 'Sin conversacion elegida' });
      continue;
    }
    try {
      if (item.etapaNueva) {
        updateSession(item.phone, { stage: item.etapaNueva });
      }
      if (item.enviarPlantilla && item.plantillaVars) {
        await sendTemplate(item.phone, templateName, languageCode, [
          item.plantillaVars.nombre,
          item.plantillaVars.producto,
          item.plantillaVars.guia,
          item.plantillaVars.monto,
        ]);
      }
      results.push({ phone: item.phone, ok: true });
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      results.push({ phone: item.phone, ok: false, error: detail });
    }
    await sleep(DELAY_MS);
  }
  return results;
}

module.exports = { buildPreview, applyItems };

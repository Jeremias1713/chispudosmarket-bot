'use strict';

// Tabla UNICA de estados de DroPanas, usada por dropanasAuto, el reconciliador,
// pickupReminders y lastNotice. Bug real que corrige: cada modulo tenia su
// propia lista suelta y "Pagado", "Devuelto" y "En devolucion" caian en
// "estado_sin_aviso_de_despacho" sin mover la etapa. En este negocio "Pagado"
// quiere decir que el cliente retiro y pago, asi que esos chats quedaban para
// siempre en esperando_retiro/en_camino, entraban en "Llamar hoy" y
// ensuciaban el reporte de devoluciones.

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DELIVERED = new Set(['entregado', 'entregada']);
const PAID = new Set(['pagado', 'pagada']);
const IN_OFFICE = new Set(['en oficina', 'en agencia', 'listo para retirar']);
const NOVELTY = new Set(['en novedad', 'novedad']);
const RETURN_PENDING = new Set(['pendiente devolucion', 'pendiente de devolucion']);
const RETURNED = new Set(['devuelto', 'devuelta', 'devolucion', 'en devolucion']);
const CANCELLED = new Set(['cancelado', 'cancelada', 'anulado', 'anulada', 'rechazado', 'rechazada']);
const SHIPPED = new Set(['en transito', 'en camino', 'despachado', 'despachada', 'guia generada', 'en ruta', 'recolectado', 'recolectada']);

// Rango para no reemplazar un evento mas avanzado por uno mas viejo (S3).
const KIND_RANK = { unknown: 0, shipped: 1, in_office: 2, novelty: 2, return_pending: 3, delivered: 4, returned: 5, cancelled: 5 };

function paidMeansDelivered(settings) {
  try {
    const s = settings || require('./settings').getSettings();
    return s.dropanasPaidMeansDelivered !== false;
  } catch (err) {
    return true;
  }
}

// Devuelve { kind, stage, paid?, value } a partir del texto de estado de
// DroPanas. kind: shipped | in_office | novelty | delivered | return_pending |
// returned | cancelled | unknown. stage: etapa del chat que le corresponde, o
// null si el estado no mueve la etapa solo.
function classifyStatus(estadoPedido, settings) {
  const value = fold(estadoPedido);
  if (DELIVERED.has(value)) return { kind: 'delivered', stage: 'entregado', paid: false, value };
  if (PAID.has(value)) {
    return paidMeansDelivered(settings)
      ? { kind: 'delivered', stage: 'entregado', paid: true, value }
      : { kind: 'unknown', stage: null, value };
  }
  if (IN_OFFICE.has(value)) return { kind: 'in_office', stage: 'esperando_retiro', value };
  // Mismo criterio de la Fase 5: "En novedad" = el paquete ya esta en la oficina.
  if (NOVELTY.has(value)) return { kind: 'novelty', stage: 'esperando_retiro', value };
  if (RETURN_PENDING.has(value)) return { kind: 'return_pending', stage: 'pendiente_devolucion', value };
  if (RETURNED.has(value)) return { kind: 'returned', stage: 'devolucion', value };
  if (CANCELLED.has(value)) return { kind: 'cancelled', stage: null, value };
  if (SHIPPED.has(value)) return { kind: 'shipped', stage: 'en_camino', value };
  return { kind: 'unknown', stage: null, value };
}

function statusRank(estadoOrKind) {
  if (Object.prototype.hasOwnProperty.call(KIND_RANK, estadoOrKind)) return KIND_RANK[estadoOrKind];
  return KIND_RANK[classifyStatus(estadoOrKind).kind] || 0;
}

function isOfficeKind(kind) {
  return kind === 'in_office' || kind === 'novelty';
}

// Estados que la tabla no conoce: se loguean una vez por valor (por proceso) y
// se guardan en dropanas-api-state.json -> unknownStatuses, para que Jere vea
// en el panel que estados nuevos aparecen y decida que significan.
const loggedUnknown = new Set();

function recordUnknown(estadoPedido, orderId, deps = {}) {
  const raw = String(estadoPedido || '').trim();
  if (!raw) return false;
  if (!loggedUnknown.has(raw)) {
    loggedUnknown.add(raw);
    console.warn('Estado DroPanas no mapeado:', raw);
  }
  try {
    const monitor = deps.monitor || require('./dropanasMonitor');
    const state = monitor.loadState();
    state.unknownStatuses = state.unknownStatuses || {};
    const row = state.unknownStatuses[raw] || { count: 0, lastAt: null, ejemploOrderId: null };
    row.count += 1;
    row.lastAt = new Date().toISOString();
    if (!row.ejemploOrderId && orderId != null) row.ejemploOrderId = String(orderId);
    state.unknownStatuses[raw] = row;
    monitor.saveState(state);
    return true;
  } catch (err) {
    console.error('No se pudo guardar el estado DroPanas no mapeado:', err.message);
    return false;
  }
}

module.exports = { fold, classifyStatus, statusRank, isOfficeKind, recordUnknown, KIND_RANK };

// Fase 7E: reporte de devoluciones. Solo lectura. Cohorte = ventas cerradas
// dentro del rango [from, to] (fechas YYYY-MM-DD de Caracas). Un pedido
// "en curso" (ni entregado ni devuelto todavia) NO entra en la tasa: contarlo
// como "no devuelto" haria parecer mejor el resultado de lo que es.
const { getSettings } = require('./settings');
const calendar = require('./calendar');

function outcomeOf(s) {
  if (s.stage === 'pendiente_devolucion') return 'devuelto';
  if (s.stage === 'entregado') return 'entregado';
  return 'en_curso';
}

function confirmationOf(s) {
  const oc = s.orderConfirm;
  if (!oc) return 'sin_dato';
  if (oc.status === 'confirmed') return `confirmado_${String(oc.confirmedBy || '').replace(/^cliente_|^panel_/, '') || 'si'}`;
  return 'sin_confirmar';
}

function officeDays(s) {
  if (!s.arrivalNotifiedAt) return null;
  const end = s.deliveredNotifiedAt || s.returnPendingNotifiedAt || new Date().toISOString();
  const a = calendar.localParts(s.arrivalNotifiedAt)?.ymd;
  const b = calendar.localParts(end)?.ymd;
  return a && b ? calendar.daysBetween(a, b) : null;
}

function bucket(days) {
  if (days === null) return 'sin_dato';
  if (days <= 1) return '0-1 dias';
  if (days <= 3) return '2-3 dias';
  return '4+ dias';
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function tally(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r) || 'sin_dato';
    if (!map.has(k)) map.set(k, { key: k, total: 0, entregado: 0, devuelto: 0, en_curso: 0 });
    const row = map.get(k);
    row.total += 1;
    row[r.outcome] += 1;
  }
  return [...map.values()].map((r) => {
    const closed = r.entregado + r.devuelto;
    return { ...r, returnRate: closed ? Math.round((r.devuelto / closed) * 1000) / 10 : null };
  }).sort((a, b) => b.total - a.total);
}

function compute(sessions, { from, to } = {}, settings = getSettings(), loader) {
  const rows = [];
  for (const s of sessions || []) {
    if (!s?.soldAt) continue;
    const day = calendar.localParts(s.soldAt)?.ymd;
    if (!day || (from && day < from) || (to && day > to)) continue;
    rows.push({
      s,
      outcome: outcomeOf(s),
      producto: s.card?.producto || null,
      region: calendar.regionForAgency(s.card?.agencia, loader),
      adCode: s.adCode || null,
      confirmation: confirmationOf(s),
      officeBucket: bucket(officeDays(s)),
      coupon: s.quickPickupCoupon ? 'con_cupon' : 'sin_cupon',
      lastNotice: s.lastNoticeAnswer || (s.lastNoticeSentAt ? 'sin_respuesta' : 'sin_aviso'),
    });
  }
  const closeToDispatchH = rows
    .filter((r) => r.s.shippingNotifiedAt)
    .map((r) => (new Date(r.s.shippingNotifiedAt) - new Date(r.s.soldAt)) / 3600000)
    .filter((h) => h >= 0);
  const reasons = {};
  for (const r of rows) if (r.s.returnReason) reasons[r.s.returnReason] = (reasons[r.s.returnReason] || 0) + 1;
  const closed = rows.filter((r) => r.outcome !== 'en_curso').length;
  const returned = rows.filter((r) => r.outcome === 'devuelto').length;
  return {
    from: from || null, to: to || null,
    totals: {
      orders: rows.length, entregado: rows.filter((r) => r.outcome === 'entregado').length, devuelto: returned,
      en_curso: rows.filter((r) => r.outcome === 'en_curso').length,
      returnRate: closed ? Math.round((returned / closed) * 1000) / 10 : null,
    },
    medianCloseToDispatchHours: median(closeToDispatchH) === null ? null : Math.round(median(closeToDispatchH) * 10) / 10,
    byProduct: tally(rows, (r) => r.producto),
    byRegion: tally(rows, (r) => r.region),
    byAdCode: tally(rows, (r) => r.adCode),
    byConfirmation: tally(rows, (r) => r.confirmation),
    byDaysInOffice: tally(rows, (r) => r.officeBucket),
    byCoupon: tally(rows, (r) => r.coupon),
    byLastNotice: tally(rows, (r) => r.lastNotice),
    reasons,
  };
}

function csvCell(v) {
  const t = String(v ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

// Una fila por corte: dimension, valor, total, entregado, devuelto, en_curso, tasa.
function toCsv(report) {
  const dims = [['producto', 'byProduct'], ['region', 'byRegion'], ['anuncio', 'byAdCode'], ['confirmacion', 'byConfirmation'],
    ['dias_en_oficina', 'byDaysInOffice'], ['cupon', 'byCoupon'], ['ultimo_aviso', 'byLastNotice']];
  const lines = ['dimension,valor,total,entregado,devuelto,en_curso,tasa_devolucion_pct'];
  for (const [label, key] of dims) {
    for (const r of report[key]) lines.push([label, r.key, r.total, r.entregado, r.devuelto, r.en_curso, r.returnRate ?? ''].map(csvCell).join(','));
  }
  for (const [reason, n] of Object.entries(report.reasons)) lines.push(['motivo', reason, n, '', '', '', ''].map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

module.exports = { compute, toCsv, outcomeOf };

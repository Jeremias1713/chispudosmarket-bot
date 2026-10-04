// Dias de transito reales (Fase 7B.4): para cada pedido con aviso de despacho y
// aviso de llegada, cuenta los dias habiles entre los dos y agrupa por region de
// la agencia. Solo lectura: devuelve el resultado, no guarda nada.
const calendar = require('./calendar');
const { getSettings } = require('./settings');

const MIN_SAMPLE = 5;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// sessions: array de sesiones. Devuelve { regions: [{ region, n, p25, median, p75, usesDefault }], suggested }.
function compute(sessions, settings = getSettings(), loader) {
  const byRegion = new Map();
  for (const s of sessions || []) {
    if (!s?.shippingNotifiedAt || !s?.arrivalNotifiedAt) continue;
    const from = calendar.localParts(s.shippingNotifiedAt)?.ymd;
    const to = calendar.localParts(s.arrivalNotifiedAt)?.ymd;
    if (!from || !to || to < from) continue;
    const region = calendar.regionForAgency(s.card?.agencia, loader) || 'SIN REGION';
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(calendar.businessDaysBetween(from, to, settings));
  }
  const regions = [];
  const suggested = {};
  for (const [region, days] of byRegion) {
    days.sort((a, b) => a - b);
    const p25 = percentile(days, 0.25);
    const median = percentile(days, 0.5);
    const p75 = percentile(days, 0.75);
    const usesDefault = days.length < MIN_SAMPLE || region === 'SIN REGION';
    regions.push({ region, n: days.length, p25, median, p75, usesDefault });
    if (!usesDefault) {
      const min = Math.max(1, Math.round(p25));
      suggested[region] = { min, max: Math.max(min, Math.round(p75)) };
    }
  }
  regions.sort((a, b) => b.n - a.n);
  return { regions, suggested, minSample: MIN_SAMPLE };
}

module.exports = { compute, MIN_SAMPLE };

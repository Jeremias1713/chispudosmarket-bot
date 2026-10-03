// Cruza un pedido de DroPanas (fila de la API o del Excel) con la conversacion
// del bot a la que pertenece, usando TODAS las identidades que el cliente le
// dio al bot. Bug que corrige: los matchers anteriores comparaban el telefono
// del pedido solo contra `session.phone || session.card.telefono`; como
// session.phone (el numero desde donde escribe) siempre existe, el telefono
// que el cliente le dio al bot para el pedido (card.telefono) NUNCA se
// comparaba, y el pedido se sube a DroPanas justamente con ese telefono.
// Resultado: avisos de guia, llegada, entrega... quedaban en "requiere
// revision" o se perdian cuando el cliente escribia desde un numero y daba otro.
'use strict';
const { compareNames, foldName } = require('./nameMatch');
const { SOLD_STAGES, logisticRank } = require('./stageRules');
const { normalizePhone } = require('./dropanasApi');

function candidateInfo(s) {
  return { phone: s.phone, name: s.card?.nombre || s.name || null, city: s.card?.ciudad || null, stage: s.stage };
}

const unique = (list) => [...new Set(list.filter(Boolean))];
const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

// Cedula: solo digitos (se quitan V, E, J, puntos, guiones y espacios); minimo 6.
function cedulaDigits(value) {
  const d = String(value || '').replace(/[VEJGvejg]/g, '').replace(/\D/g, '');
  return d.length >= 6 ? d : '';
}

function last10(value) {
  const d = digitsOnly(normalizePhone(value));
  return d.length >= 10 ? d.slice(-10) : '';
}

// Todas las identidades de una sesion.
function sessionIdentity(session) {
  const s = session || {};
  const card = s.card || {};
  const edit = s.dropanasOrderEdit || {};
  const history = Array.isArray(s.dropanasOrderHistory) ? s.dropanasOrderHistory : [];
  const isBsuid = require('./whatsapp').isBsuid;
  const phones = [s.phone, card.telefono, edit.telefono, s.currentOrder?.telefono]
    .filter((p) => p && !isBsuid(String(p)))
    .map((p) => normalizePhone(p));
  const editName = `${edit.nombre || ''} ${edit.apellido || ''}`.replace(/\s+/g, ' ').trim();
  return {
    orderIds: unique([s.dropanasOrder?.id, card.dropanasId, ...history.map((h) => h?.id)].map((v) => (v == null ? '' : String(v)))),
    references: unique([s.dropanasOrder?.externalReference, ...history.map((h) => h?.externalReference)].map((v) => String(v || '').trim())),
    guias: unique([card.guia, card.guiaDropanas].map((g) => String(g || '').trim().toUpperCase())),
    phones: unique(phones),
    cedulas: unique([cedulaDigits(card.cedula), cedulaDigits(edit.cedula)]),
    names: unique([card.nombre, s.name, editName].map((n) => String(n || '').trim())),
  };
}

const isSold = (s) => s.orderClosed === true || SOLD_STAGES.includes(s.stage);

const result = (matchType, evidence, sessions, session) => ({
  matchType,
  evidence: evidence || null,
  session: session || null,
  phone: session ? session.phone : null,
  candidates: sessions.map(candidateInfo),
});

// row: { dropanasId, guia, cliente, telefono, cedula?, externalReference? }
// Devuelve { matchType: 'exacto'|'ambiguo'|'sin_match', evidence, session, phone, candidates }.
// La primera regla que da EXACTAMENTE una sesion gana; si una regla da varias y
// ninguna posterior decide, el resultado es 'ambiguo'.
function matchOrder(row, sessions, options = {}) {
  const filter = options.candidateFilter;
  const pool = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.phone && (!filter || filter(s)));
  const ids = new Map(pool.map((s) => [s, sessionIdentity(s)]));
  let firstAmbiguous = null;

  const decide = (hits, evidence) => {
    if (hits.length === 1) return result('exacto', evidence, hits, hits[0]);
    if (hits.length > 1 && !firstAmbiguous) firstAmbiguous = hits;
    return null;
  };
  const where = (fn) => pool.filter((s) => fn(ids.get(s), s));

  // 1) numero de orden
  const orderId = row?.dropanasId == null ? '' : String(row.dropanasId);
  if (orderId) {
    const r = decide(where((i) => i.orderIds.includes(orderId)), 'orden');
    if (r) return r;
  }

  // 2) referencia externa (CHISPUDOS-<10 digitos>-<stamp>)
  const reference = String(row?.externalReference || '').trim();
  if (reference) {
    let r = decide(where((i) => i.references.includes(reference)), 'referencia');
    if (r) return r;
    const m = reference.match(/^CHISPUDOS-(\d{10})-/i);
    if (m) {
      r = decide(pool.filter((s) => digitsOnly(s.phone).endsWith(m[1])), 'referencia_telefono');
      if (r) return r;
    }
  }

  // 3) guia
  const guia = String(row?.guia || '').trim().toUpperCase();
  if (guia) {
    const dp = guia.match(/^DP(\d+)$/);
    const r = decide(where((i) => i.guias.includes(guia) || (dp && i.orderIds.includes(dp[1]))), 'guia');
    if (r) return r;
  }

  // 4) telefono (ultimos 10 digitos), con desempate
  const rowPhone = last10(row?.telefono);
  if (rowPhone) {
    const hits = where((i) => i.phones.some((p) => last10(p) === rowPhone));
    if (hits.length === 1) return result('exacto', 'telefono', hits, hits[0]);
    if (hits.length > 1) {
      const rowCedula = cedulaDigits(row?.cedula);
      const byCedula = rowCedula ? hits.filter((s) => ids.get(s).cedulas.includes(rowCedula)) : [];
      if (byCedula.length === 1) return result('exacto', 'telefono+cedula', hits, byCedula[0]);
      const byName = row?.cliente ? hits.filter((s) => ids.get(s).names.some((n) => compareNames(n, row.cliente) === 'exacto')) : [];
      if (byName.length === 1) return result('exacto', 'telefono+nombre', hits, byName[0]);
      const byStage = hits.filter((s) => logisticRank(s.stage) >= 1 && logisticRank(s.stage) <= 3 || s.orderClosed === true);
      if (byStage.length === 1) return result('exacto', 'telefono+etapa', hits, byStage[0]);
      return result('ambiguo', 'telefono_duplicado', hits, null);
    }
  }

  // 5) cedula
  const rowCedula = cedulaDigits(row?.cedula);
  if (rowCedula) {
    const r = decide(where((i) => i.cedulas.includes(rowCedula)), 'cedula');
    if (r) return r;
  }

  // 6) nombre: solo entre pedidos cerrados (un nombre suelto de un lead no es evidencia)
  if (foldName(row?.cliente)) {
    const sold = pool.filter(isSold);
    const exact = sold.filter((s) => ids.get(s).names.some((n) => compareNames(n, row.cliente) === 'exacto'));
    if (exact.length === 1) return result('exacto', 'nombre', exact, exact[0]);
    if (exact.length > 1) return result('ambiguo', 'nombre', exact, null);
    const partial = sold.filter((s) => ids.get(s).names.some((n) => compareNames(n, row.cliente) === 'parcial'));
    if (partial.length) return result('ambiguo', 'nombre_parcial', partial, null);
  }

  if (firstAmbiguous) return result('ambiguo', 'varios', firstAmbiguous, null);
  return result('sin_match', null, [], null);
}

module.exports = { matchOrder, sessionIdentity, candidateInfo, cedulaDigits };

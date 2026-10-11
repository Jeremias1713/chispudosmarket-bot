// Calendario de despacho y llegada (Fase 7B). TODA fecha que el bot le dice al
// cliente sale de aqui, calculada por codigo: la IA nunca calcula fechas.
//
// Zona horaria: Caracas es UTC-4 todo el ano (sin horario de verano), asi que
// se trabaja con un "reloj local" = UTC - 4 h y fechas como cadenas YYYY-MM-DD.
// No depende del locale ni de la zona del servidor.
const { getSettings } = require('./settings');

const OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// { ymd, hour, minute, dow } en hora de Caracas.
function localParts(value) {
  const d = toDate(value);
  if (!d) return null;
  const l = new Date(d.getTime() - OFFSET_MS);
  const ymd = `${l.getUTCFullYear()}-${String(l.getUTCMonth() + 1).padStart(2, '0')}-${String(l.getUTCDate()).padStart(2, '0')}`;
  return { ymd, hour: l.getUTCHours(), minute: l.getUTCMinutes(), dow: l.getUTCDay() };
}

function ymdToUtc(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function dowOf(ymd) {
  return new Date(ymdToUtc(ymd)).getUTCDay();
}

function addDays(ymd, n) {
  const d = new Date(ymdToUtc(ymd) + n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((ymdToUtc(toYmd) - ymdToUtc(fromYmd)) / 86400000);
}

// El calendario solo se usa si esta prendido Y Jere cargo la hora de corte y
// si se despacha el sabado: sin esos datos se prefiere no dar fechas a darlas mal.
function isConfigured(settings = getSettings()) {
  return settings.calendarEnabled === true
    && Number.isFinite(Number(settings.dispatchCutoffHour)) && settings.dispatchCutoffHour !== null
    && typeof settings.dispatchOnSaturday === 'boolean';
}

// Feriados nacionales de fecha fija de Venezuela (MM-DD). Van fijos en el
// codigo: antes solo estaban en la lista editable del panel y, si esa lista se
// guardaba vacia, el calendario los perdia. En el panel solo van los movibles.
const FIXED_HOLIDAYS = ['01-01', '04-19', '05-01', '06-24', '07-05', '07-24', '10-12', '12-24', '12-25', '12-31'];

// ymd: cadena YYYY-MM-DD.
function isBusinessDay(ymd, settings = getSettings()) {
  const dow = dowOf(ymd);
  if (dow === 0) return false;
  if (dow === 6 && settings.dispatchOnSaturday === false) return false;
  if (FIXED_HOLIDAYS.includes(String(ymd).slice(5))) return false;
  if ((settings.holidays || []).includes(ymd)) return false;
  return true;
}

function nextBusinessDay(ymd, settings = getSettings()) {
  let cur = addDays(ymd, 1);
  for (let i = 0; i < 40 && !isBusinessDay(cur, settings); i += 1) cur = addDays(cur, 1);
  return cur;
}

function addBusinessDays(ymd, n, settings = getSettings()) {
  let cur = ymd;
  for (let i = 0; i < Number(n || 0); i += 1) cur = nextBusinessDay(cur, settings);
  return cur;
}

// Dias habiles entre dos fechas (cuenta los dias despues de `from` hasta `to` inclusive).
function businessDaysBetween(fromYmd, toYmd, settings = getSettings()) {
  let n = 0;
  let cur = fromYmd;
  for (let i = 0; i < 400 && cur < toYmd; i += 1) {
    cur = addDays(cur, 1);
    if (isBusinessDay(cur, settings)) n += 1;
  }
  return n;
}

function cutoffMinutes(settings) {
  return Number(settings.dispatchCutoffHour) * 60 + Number(settings.dispatchCutoffMinute || 0);
}

// Minutos que faltan para el corte de HOY (negativo si ya paso o hoy no es dia habil).
function minutesToCutoff(now = new Date(), settings = getSettings()) {
  const p = localParts(now);
  if (!p || !isConfigured(settings) || !isBusinessDay(p.ymd, settings)) return -1;
  return cutoffMinutes(settings) - (p.hour * 60 + p.minute);
}

// Dia (YYYY-MM-DD) en que sale el pedido confirmado en `confirmedAt`.
function dispatchDate(confirmedAt, settings = getSettings()) {
  const p = localParts(confirmedAt);
  if (!p) return null;
  if (isBusinessDay(p.ymd, settings) && p.hour * 60 + p.minute < cutoffMinutes(settings)) return p.ymd;
  return nextBusinessDay(p.ymd, settings);
}

function transitFor(region, settings = getSettings()) {
  const byRegion = settings.transitDaysByRegion || {};
  const row = region ? byRegion[String(region).toUpperCase()] : null;
  const def = settings.transitDaysDefault || { min: 2, max: 3 };
  const r = row && Number.isFinite(Number(row.min)) && Number.isFinite(Number(row.max)) ? row : def;
  const min = Math.max(1, Math.round(Number(r.min)));
  return { min, max: Math.max(min, Math.round(Number(r.max))) };
}

function arrivalRange(dispatch, region, settings = getSettings()) {
  const t = transitFor(region, settings);
  return { from: addBusinessDays(dispatch, t.min, settings), to: addBusinessDays(dispatch, t.max, settings) };
}

function fold(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Region de la agencia (columna region de data/agencies.csv) o null. El texto
// de la ficha suele ser "Tealca SABANA GRANDE" o solo el nombre; se busca la
// agencia de nombre mas largo contenida en el texto.
function regionForAgency(agencyName, loader) {
  const text = fold(agencyName);
  if (!text) return null;
  let list = [];
  try {
    list = (loader || require('./agencies').loadAgencies)();
  } catch (err) {
    return null;
  }
  let best = null;
  for (const a of list) {
    const name = fold(a.name);
    if (!name || !a.region) continue;
    if (text.includes(name) && (!best || name.length > best.len)) best = { len: name.length, region: String(a.region).toUpperCase() };
  }
  return best ? best.region : null;
}

function dayMonth(ymd) {
  const d = new Date(ymdToUtc(ymd));
  return { day: d.getUTCDate(), month: MONTH_NAMES[d.getUTCMonth()], dow: DAY_NAMES[d.getUTCDay()] };
}

// "hoy", "mañana" o "el lunes 20 de octubre".
function formatDispatch(dispatchYmd, now = new Date()) {
  const today = localParts(now)?.ymd;
  if (dispatchYmd === today) return 'hoy';
  if (today && dispatchYmd === addDays(today, 1)) return 'mañana';
  const p = dayMonth(dispatchYmd);
  return `el ${p.dow} ${p.day} de ${p.month}`;
}

// "el 22 o 23 de octubre", "el 31 de octubre o 1 de noviembre", "el 22 de octubre".
function formatRange(range) {
  const a = dayMonth(range.from);
  if (range.from === range.to) return `el ${a.day} de ${a.month}`;
  const b = dayMonth(range.to);
  if (a.month === b.month) return `el ${a.day} o ${b.day} de ${a.month}`;
  return `el ${a.day} de ${a.month} o ${b.day} de ${b.month}`;
}

// Fecha corta para recordatorios/cupones: "jueves 23".
function formatDayShort(ymd) {
  const p = dayMonth(ymd);
  return `${p.dow} ${p.day} de ${p.month}`;
}

// Todo lo que el bot dice sobre fechas de UN pedido. null si el calendario no
// esta configurado o no se conoce la agencia (no se inventan fechas).
// Region para el transito. BUG REAL que corrige esto: antes se exigia
// card.agencia, pero ese campo SOLO se llena cuando DroPanas manda la guia
// (buildGuiaPatch). Durante la venta y en el mensaje de cierre siempre estaba
// vacio, asi que el bot nunca decia cuando llegaba el pedido. Ahora se usa,
// en orden: la agencia de la ficha, la agencia confirmada en el chat (el
// resumen del cierre "Agencia: X"), la ciudad de la ficha y, si nada de eso
// da una region, el transito por defecto (transitDaysDefault).
function agencyFromChat(session) {
  try {
    const facts = require('./dropanasOrderAutomation').historyOrderFacts(session.history || []);
    return facts.agency || null;
  } catch (err) {
    return null;
  }
}

function regionForCity(city, loader) {
  const text = fold(city);
  if (text.length < 3) return null;
  let list = [];
  try {
    list = (loader || require('./agencies').loadAgencies)();
  } catch (err) {
    return null;
  }
  const regions = new Set();
  for (const a of list) {
    if (!a.region) continue;
    const hay = ` ${fold(a.name)} ${fold(a.city)} ${fold(a.address)} ${fold(a.region)} `;
    if (hay.includes(` ${text} `)) regions.add(String(a.region).toUpperCase());
  }
  // Solo si la ciudad apunta a una unica region (si no, mejor el default).
  return regions.size === 1 ? [...regions][0] : null;
}

function regionForSession(session, loader) {
  const card = session.card || {};
  const candidates = [card.agencia, card.agenciaConfirmadaEnChat];
  for (const c of candidates) {
    const r = String(c || '').trim() ? regionForAgency(c, loader) : null;
    if (r) return r;
  }
  const chatAgency = agencyFromChat(session);
  const fromChat = chatAgency ? regionForAgency(chatAgency, loader) : null;
  if (fromChat) return fromChat;
  return regionForCity(card.ciudad, loader);
}

function datesForSession(session, now = new Date(), settings = getSettings(), loader) {
  if (!isConfigured(settings) || !session) return null;
  const region = regionForSession(session, loader);
  const dispatched = session.shippingNotifiedAt ? localParts(session.shippingNotifiedAt)?.ymd : null;
  const dispatch = dispatched || dispatchDate(now, settings);
  if (!dispatch) return null;
  const range = arrivalRange(dispatch, region, settings);
  const today = localParts(now).ymd;
  const late = session.stage === 'en_camino' && today > addBusinessDays(range.to, 1, settings);
  return {
    dispatch, range, region, late, dispatched: Boolean(dispatched),
    dispatchText: formatDispatch(dispatch, now),
    rangeText: formatRange(range),
  };
}

// Bloque que se agrega al prompt de la IA (DATO YA CONFIRMADO). '' si no hay fechas.
function promptBlock(dates) {
  if (!dates) return '';
  if (dates.late) {
    return '\n  DATO YA CONFIRMADO, FECHAS DEL ENVIO: el pedido esta tardando mas de lo estimado. Si el cliente pregunta cuando llega, di que lo estas revisando con la transportadora y que le avisas apenas tengas novedad. NUNCA des una fecha ni calcules una por tu cuenta.\n';
  }
  const salida = dates.dispatched ? `salio ${dates.dispatchText === 'hoy' ? 'hoy' : dates.dispatchText}` : `sale ${dates.dispatchText}`;
  // La fecha del cierre la manda el CODIGO en un mensaje aparte (closeDatesText,
  // ver flow.js): antes se le pedia a la IA que la agregara y la mayoria de las
  // veces no lo hacia.
  const cierre = dates.dispatched ? '' : ' CIERRE: FECHAS: NO pongas fechas en el mensaje de cierre del pedido; el sistema le manda la fecha estimada al cliente en un mensaje aparte justo despues.';
  return `\n  DATO YA CONFIRMADO, FECHAS DEL ENVIO: si el cliente pregunta cuando sale o cuando llega, responde EXACTAMENTE: ${salida} y llegaria ${dates.rangeText} (estimado). Nunca des otra fecha ni calcules por tu cuenta. Si es fin de semana o feriado, explica que el despacho sale el siguiente dia habil.${cierre}\n`;
}

// Mensaje fijo con la fecha estimada, para mandar apenas se cierra la venta.
function closeDatesText(dates) {
  if (!dates || dates.late) return null;
  const salida = dates.dispatched ? `salió ${dates.dispatchText}` : `sale ${dates.dispatchText}`;
  return `🚚 Tu pedido ${salida} y llegaría a la agencia ${dates.rangeText} (estimado). Te avisamos apenas llegue.`;
}

module.exports = {
  closeDatesText,
  businessDaysBetween, localParts, addDays, daysBetween, isConfigured, isBusinessDay, nextBusinessDay, addBusinessDays,
  minutesToCutoff, dispatchDate, transitFor, arrivalRange, regionForAgency, regionForCity, regionForSession, formatDispatch, formatRange,
  formatDayShort, datesForSession, promptBlock,
};

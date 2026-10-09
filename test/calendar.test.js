const { setupTempDataDir } = require('./helpers/tempDataDir');
setupTempDataDir('calendar');
const test = require('node:test');
const assert = require('node:assert/strict');
const calendar = require('../src/calendar');
const transitStats = require('../src/transitStats');

// Caracas = UTC-4: "10:00 en Caracas" es 14:00Z.
const caracas = (ymd, hh, mm = 0) => new Date(`${ymd}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);

const base = {
  calendarEnabled: true, dispatchCutoffHour: 14, dispatchCutoffMinute: 0, dispatchOnSaturday: false,
  holidays: ['2026-10-12'], transitDaysByRegion: { 'GRAN CARACAS': { min: 1, max: 2 } }, transitDaysDefault: { min: 2, max: 3 },
};
const loader = () => [
  { name: 'Sabana Grande', region: 'GRAN CARACAS' },
  { name: 'Barquisimeto Centro', region: 'CENTRO OCCIDENTE' },
];

// 2026-10-06 martes, 09 viernes, 10 sabado, 12 lunes feriado.
test('antes del corte sale hoy, despues sale el siguiente dia habil', () => {
  assert.equal(calendar.dispatchDate(caracas('2026-10-06', 10), base), '2026-10-06');
  assert.equal(calendar.dispatchDate(caracas('2026-10-06', 15), base), '2026-10-07');
});

test('viernes tarde: sin sabado sale el lunes, con sabado sale el sabado', () => {
  assert.equal(calendar.dispatchDate(caracas('2026-10-09', 15), { ...base, holidays: [] }), '2026-10-12');
  assert.equal(calendar.dispatchDate(caracas('2026-10-09', 15), { ...base, dispatchOnSaturday: true }), '2026-10-10');
});

test('un lunes feriado se salta al martes', () => {
  assert.equal(calendar.dispatchDate(caracas('2026-10-09', 15), base), '2026-10-13');
});

test('Caracas llega en 1 a 2 dias habiles', () => {
  const r = calendar.arrivalRange('2026-10-06', 'GRAN CARACAS', base);
  assert.deepEqual(r, { from: '2026-10-07', to: '2026-10-08' });
});

test('el rango cruza fin de semana y cambio de mes', () => {
  const r = calendar.arrivalRange('2026-10-29', 'OTRA', { ...base, holidays: [] });
  assert.deepEqual(r, { from: '2026-11-02', to: '2026-11-03' });
  assert.equal(calendar.formatRange(r), 'el 2 o 3 de noviembre');
  assert.equal(calendar.formatRange({ from: '2026-10-30', to: '2026-11-02' }), 'el 30 de octubre o 2 de noviembre');
  assert.equal(calendar.formatRange({ from: '2026-10-22', to: '2026-10-22' }), 'el 22 de octubre');
});

test('formatDispatch: hoy, mañana y fecha larga', () => {
  const now = caracas('2026-10-06', 10);
  assert.equal(calendar.formatDispatch('2026-10-06', now), 'hoy');
  assert.equal(calendar.formatDispatch('2026-10-07', now), 'mañana');
  assert.equal(calendar.formatDispatch('2026-10-13', now), 'el martes 13 de octubre');
});

test('datesForSession usa la region de la agencia y arma el bloque del prompt', () => {
  const s = { stage: 'vendido', card: { agencia: 'Tealca SABANA GRANDE' } };
  const d = calendar.datesForSession(s, caracas('2026-10-06', 10), base, loader);
  assert.equal(d.dispatchText, 'hoy');
  assert.equal(d.rangeText, 'el 7 o 8 de octubre');
  const block = calendar.promptBlock(d);
  assert.match(block, /DATO YA CONFIRMADO/);
  assert.match(block, /sale hoy y llegaria el 7 o 8 de octubre \(estimado\)/);
});

test('sin configurar (o sin agencia) no hay fechas ni bloque de prompt', () => {
  const s = { stage: 'vendido', card: { agencia: 'Tealca SABANA GRANDE' } };
  const now = caracas('2026-10-06', 10);
  assert.equal(calendar.datesForSession(s, now, { ...base, dispatchCutoffHour: null }, loader), null);
  assert.equal(calendar.datesForSession(s, now, { ...base, dispatchOnSaturday: null }, loader), null);
  assert.equal(calendar.datesForSession(s, now, { ...base, calendarEnabled: false }, loader), null);
  assert.equal(calendar.promptBlock(null), '');
});

test('pedido atrasado: el bloque dice que se esta revisando y no da fecha', () => {
  const s = { stage: 'en_camino', shippingNotifiedAt: caracas('2026-10-06', 9).toISOString(), card: { agencia: 'Sabana Grande' } };
  const d = calendar.datesForSession(s, caracas('2026-10-20', 10), base, loader);
  assert.equal(d.late, true);
  const block = calendar.promptBlock(d);
  assert.match(block, /revisando/);
  assert.doesNotMatch(block, /llegaria/);
});

test('transitStats agrupa por region y usa el default con pocas muestras', () => {
  const sessions = [];
  for (let i = 0; i < 6; i += 1) {
    sessions.push({
      shippingNotifiedAt: caracas('2026-10-06', 10).toISOString(),
      arrivalNotifiedAt: caracas('2026-10-07', 10).toISOString(),
      card: { agencia: 'Sabana Grande' },
    });
  }
  sessions.push({ shippingNotifiedAt: caracas('2026-10-06', 10).toISOString(), arrivalNotifiedAt: caracas('2026-10-09', 10).toISOString(), card: { agencia: 'Barquisimeto Centro' } });
  const r = transitStats.compute(sessions, base, loader);
  const caracasRow = r.regions.find((x) => x.region === 'GRAN CARACAS');
  assert.equal(caracasRow.n, 6);
  assert.equal(caracasRow.usesDefault, false);
  assert.deepEqual(r.suggested['GRAN CARACAS'], { min: 1, max: 1 });
  assert.equal(r.regions.find((x) => x.region === 'CENTRO OCCIDENTE').usesDefault, true);
});

test('el bloque pide la fecha en el cierre solo si el pedido aun no salio', () => {
  const s = { stage: 'vendido', card: { agencia: 'Tealca SABANA GRANDE' } };
  const d = calendar.datesForSession(s, caracas('2026-10-06', 10), base, loader);
  const block = calendar.promptBlock(d);
  assert.match(block, /CIERRE: FECHAS/);
  assert.match(block, /Tu pedido sale hoy y llegaria el 7 o 8 de octubre \(estimado\)/);
  const enviado = { stage: 'en_camino', shippingNotifiedAt: caracas('2026-10-06', 9).toISOString(), card: { agencia: 'Sabana Grande' } };
  const d2 = calendar.datesForSession(enviado, caracas('2026-10-07', 10), base, loader);
  assert.doesNotMatch(calendar.promptBlock(d2), /CIERRE: FECHAS/);
});

test('el prompt de la IA incluye la fecha en el cierre solo con calendario configurado', () => {
  const ai = require('../src/ai');
  const s = { stage: 'vendido', card: { agencia: 'Tealca SABANA GRANDE' } };
  const d = calendar.datesForSession(s, caracas('2026-10-06', 10), base, loader);
  const con = ai.buildSystemPrompt('', '', false, false, null, null, d);
  const sin = ai.buildSystemPrompt('', '', false, false, null, null, null);
  assert.match(con, /CIERRE: FECHAS/);
  assert.doesNotMatch(sin, /CIERRE: FECHAS\: cuando/);
});

// Bug real: card.agencia solo se llena cuando llega la guia, asi que durante
// la venta el bot nunca decia cuando llegaba el pedido.
test('sin agencia en la ficha usa la del resumen del chat, la ciudad o el default', () => {
  const now = caracas('2026-10-06', 10);
  const chat = { stage: 'vendido', card: {}, history: [
    { role: 'assistant', content: 'Resumen de tu pedido:\n- Producto: Shilajit x1\n- Agencia: Sabana Grande\nPago contra entrega.' },
  ] };
  const d1 = calendar.datesForSession(chat, now, base, loader);
  assert.equal(d1.region, 'GRAN CARACAS');
  assert.equal(d1.rangeText, 'el 7 o 8 de octubre');
  const ciudad = { stage: 'negociando', card: { ciudad: 'Barquisimeto' } };
  assert.equal(calendar.datesForSession(ciudad, now, base, loader).region, 'CENTRO OCCIDENTE');
  const nada = calendar.datesForSession({ stage: 'negociando', card: {} }, now, base, loader);
  assert.equal(nada.region, null);
  assert.equal(nada.rangeText, 'el 8 o 9 de octubre');
  assert.match(calendar.promptBlock(nada), /CIERRE: FECHAS/);
});

'use strict';
// Fase 7E: reporte de devoluciones con 10 pedidos de prueba.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('returns-report');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const report = require('../src/returnsReport');

after(() => cleanup(dataDir));

const loader = () => [{ name: 'Sabana Grande', region: 'GRAN CARACAS' }, { name: 'Barquisimeto Centro', region: 'CENTRO OCCIDENTE' }];
const o = (n, extra) => ({
  phone: `5841200000${n}`, soldAt: `2026-10-0${1 + (n % 5)}T15:00:00.000Z`, stage: 'entregado',
  card: { producto: 'Shilajit', agencia: 'Sabana Grande' }, adCode: 'A1B2', ...extra,
});
const sessions = [
  o(1, { orderConfirm: { status: 'confirmed', confirmedBy: 'cliente_boton' }, shippingNotifiedAt: '2026-10-02T21:00:00.000Z' }),
  o(2, { orderConfirm: { status: 'confirmed', confirmedBy: 'cliente_boton' } }),
  o(3, { orderConfirm: { status: 'confirmed', confirmedBy: 'panel_telefono' } }),
  o(4, { stage: 'pendiente_devolucion', orderConfirm: { status: 'sent' }, returnReason: 'precio', lastNoticeSentAt: 'x', lastNoticeAnswer: 'cancel' }),
  o(5, { stage: 'pendiente_devolucion', card: { producto: 'Maca', agencia: 'Barquisimeto Centro' }, adCode: 'C3D4', returnReason: 'demora', lastNoticeSentAt: 'x' }),
  o(6, { stage: 'esperando_retiro' }),
  o(7, { stage: 'en_camino', card: { producto: 'Maca', agencia: 'Barquisimeto Centro' } }),
  o(8, { quickPickupCoupon: { code: 'RETIRO-AAAAAA' } }),
  o(9, { card: { producto: 'Maca', agencia: 'Barquisimeto Centro' }, adCode: 'C3D4' }),
  o(10, { soldAt: '2026-09-01T15:00:00.000Z' }), // fuera de rango
];

test('totales: los pedidos en curso no entran en la tasa', () => {
  const r = report.compute(sessions, { from: '2026-10-01', to: '2026-10-31' }, {}, loader);
  assert.equal(r.totals.orders, 9);
  assert.equal(r.totals.devuelto, 2);
  assert.equal(r.totals.en_curso, 2);
  assert.equal(r.totals.entregado, 5);
  assert.equal(r.totals.returnRate, 28.6); // 2 de 7 cerrados
});

test('cortes por producto, region, anuncio, confirmacion, cupon y ultimo aviso', () => {
  const r = report.compute(sessions, { from: '2026-10-01', to: '2026-10-31' }, {}, loader);
  const maca = r.byProduct.find((x) => x.key === 'Maca');
  assert.deepEqual([maca.total, maca.devuelto, maca.entregado, maca.en_curso], [3, 1, 1, 1]);
  assert.equal(r.byRegion.find((x) => x.key === 'CENTRO OCCIDENTE').total, 3);
  assert.equal(r.byAdCode.find((x) => x.key === 'C3D4').devuelto, 1);
  assert.equal(r.byConfirmation.find((x) => x.key === 'confirmado_boton').total, 2);
  assert.equal(r.byConfirmation.find((x) => x.key === 'sin_confirmar').devuelto, 1);
  assert.equal(r.byCoupon.find((x) => x.key === 'con_cupon').total, 1);
  assert.equal(r.byLastNotice.find((x) => x.key === 'cancel').devuelto, 1);
  assert.equal(r.byLastNotice.find((x) => x.key === 'sin_respuesta').total, 1);
});

test('motivos agrupados y mediana de horas entre cierre y despacho', () => {
  const r = report.compute(sessions, { from: '2026-10-01', to: '2026-10-31' }, {}, loader);
  assert.deepEqual(r.reasons, { precio: 1, demora: 1 });
  assert.equal(r.medianCloseToDispatchHours, 6); // cerrado 15:00Z, despacho 21:00Z
});

test('CSV: encabezado, filas por corte y motivos', () => {
  const csv = report.toCsv(report.compute(sessions, { from: '2026-10-01', to: '2026-10-31' }, {}, loader));
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'dimension,valor,total,entregado,devuelto,en_curso,tasa_devolucion_pct');
  assert.ok(lines.includes('producto,Maca,3,1,1,1,50'));
  assert.ok(lines.includes('motivo,precio,1,,,,'));
});

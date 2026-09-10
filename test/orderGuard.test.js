// FASE 3 (H08, solucion intermedia): detecta cuando una guia nueva parece
// ser de OTRA compra del mismo cliente (en vez de sobrescribir en
// silencio), mientras no exista un modelo completo de pedidos separados.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detectOrderConflict } = require('../src/orderGuard');

test('sin guia anterior no hay conflicto (primera carga de este pedido)', () => {
  const session = { card: {} };
  assert.equal(detectOrderConflict(session, 'GU-001'), null);
});

test('misma guia que ya estaba (corregir un typo, recargar) no es conflicto', () => {
  const session = { card: { guia: 'GU-001' }, shippingNotifiedAt: '2026-08-01T00:00:00.000Z' };
  assert.equal(detectOrderConflict(session, 'GU-001'), null);
});

test('guia anterior distinta pero el aviso de esa nunca se confirmo (shippingNotifiedAt vacio) no es conflicto', () => {
  // Ejemplo: se cargo una guia con un error de tipeo y se la esta
  // corrigiendo antes de que el cliente reciba ningun aviso.
  const session = { card: { guia: 'GU-001' } };
  assert.equal(detectOrderConflict(session, 'GU-002'), null);
});

test('H08 - guia anterior distinta Y ya avisada con exito: SI es conflicto, no se sobrescribe en silencio', () => {
  const session = {
    card: { guia: 'GU-001', producto: 'Shilajit 30 caps', monto: 38900 },
    shippingNotifiedAt: '2026-08-01T00:00:00.000Z',
  };
  const conflicto = detectOrderConflict(session, 'GU-002');
  assert.ok(conflicto, 'BUG H08 si esto es null: dos pedidos distintos del mismo cliente se mezclarian en silencio');
  assert.equal(conflicto.pedidoAnterior.guia, 'GU-001');
  assert.equal(conflicto.pedidoAnterior.producto, 'Shilajit 30 caps');
  assert.equal(conflicto.pedidoAnterior.monto, 38900);
});

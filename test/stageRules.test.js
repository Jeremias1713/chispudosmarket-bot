// Pruebas de las reglas COMPARTIDAS de progresion de etapas (stageRules.js).
// Estas son las reglas que corrigen los hallazgos 1 y 2 del reporte del
// negocio: el clasificador de IA no debe poder retroceder/pisar un avance
// logistico ya confirmado, y registrar una guia valida debe poder avanzar
// aunque la etapa se haya fijado a mano.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isAllowedAutoTransition,
  canAdvanceToEnCaminoOnGuia,
  logisticRank,
  SOLD_STAGES,
} = require('../src/stageRules');

test('SOLD_STAGES no incluye devolucion (una devolucion deja de contar como venta cerrada)', () => {
  assert.ok(!SOLD_STAGES.includes('devolucion'));
});

test('isAllowedAutoTransition: desde una etapa sin avance logistico (nuevo/interesado/etc), cualquier reclasificacion se puede aplicar', () => {
  assert.equal(isAllowedAutoTransition('nuevo', 'interesado'), true);
  assert.equal(isAllowedAutoTransition('interesado', 'negociando'), true);
  assert.equal(isAllowedAutoTransition('negociando', 'vendido'), true);
});

test('isAllowedAutoTransition: avanzar de rango (vendido -> en_camino -> esperando_retiro -> entregado) siempre se permite', () => {
  assert.equal(isAllowedAutoTransition('vendido', 'en_camino'), true);
  assert.equal(isAllowedAutoTransition('en_camino', 'esperando_retiro'), true);
  assert.equal(isAllowedAutoTransition('esperando_retiro', 'entregado'), true);
  assert.equal(isAllowedAutoTransition('vendido', 'entregado'), true);
});

test('isAllowedAutoTransition: NUNCA retrocede un rango logistico ya alcanzado (bug reportado: "gracias" no debe degradar esperando_retiro)', () => {
  assert.equal(isAllowedAutoTransition('esperando_retiro', 'en_camino'), false);
  assert.equal(isAllowedAutoTransition('esperando_retiro', 'vendido'), false);
  assert.equal(isAllowedAutoTransition('entregado', 'esperando_retiro'), false);
  assert.equal(isAllowedAutoTransition('en_camino', 'vendido'), false);
});

test('isAllowedAutoTransition: una etapa puramente conversacional nunca "desvende" un pedido ya cerrado', () => {
  assert.equal(isAllowedAutoTransition('esperando_retiro', 'nuevo'), false);
  assert.equal(isAllowedAutoTransition('vendido', 'interesado'), false);
  assert.equal(isAllowedAutoTransition('en_camino', 'necesita_atencion'), false);
});

test('isAllowedAutoTransition: "devolucion" siempre se permite, sin importar el rango logistico actual', () => {
  assert.equal(isAllowedAutoTransition('entregado', 'devolucion'), true);
  assert.equal(isAllowedAutoTransition('esperando_retiro', 'devolucion'), true);
  assert.equal(isAllowedAutoTransition('vendido', 'devolucion'), true);
});

test('isAllowedAutoTransition: quedarse en la misma etapa siempre se permite', () => {
  for (const stage of ['vendido', 'en_camino', 'esperando_retiro', 'entregado', 'tienda_maracaibo']) {
    assert.equal(isAllowedAutoTransition(stage, stage), true, stage);
  }
});

test('canAdvanceToEnCaminoOnGuia: vendido/esperando_guia siempre pueden avanzar a en_camino al cargar guia', () => {
  assert.equal(canAdvanceToEnCaminoOnGuia('vendido', false), true);
  assert.equal(canAdvanceToEnCaminoOnGuia('esperando_guia', false), true);
});

test('canAdvanceToEnCaminoOnGuia: NUNCA retrocede esperando_retiro/entregado salvo que sea un pedido nuevo confirmado', () => {
  assert.equal(canAdvanceToEnCaminoOnGuia('esperando_retiro', false), false);
  assert.equal(canAdvanceToEnCaminoOnGuia('entregado', false), false);
  assert.equal(canAdvanceToEnCaminoOnGuia('esperando_retiro', true), true);
  assert.equal(canAdvanceToEnCaminoOnGuia('entregado', true), true);
});

test('logisticRank: tienda_maracaibo comparte rango con vendido/esperando_guia (rama alternativa sin guia)', () => {
  assert.equal(logisticRank('tienda_maracaibo'), logisticRank('vendido'));
  assert.equal(logisticRank('tienda_maracaibo'), logisticRank('esperando_guia'));
});

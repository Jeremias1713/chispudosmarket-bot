'use strict';
// La IA no puede poner una etapa de envio si todavia no hay guia.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifierStageWithoutGuide, stageGuessedWithoutGuide } = require('../src/stageRules');

test('sin guia, esperando_retiro desde negociando queda en vendido', () => {
  assert.equal(classifierStageWithoutGuide({ stage: 'negociando', card: {} }, 'esperando_retiro'), 'vendido');
});

test('sin guia, una venta se queda en su etapa', () => {
  assert.equal(classifierStageWithoutGuide({ stage: 'vendido', card: {} }, 'en_camino'), 'vendido');
  assert.equal(classifierStageWithoutGuide({ stage: 'vendido_fecha_futura', card: {} }, 'esperando_retiro'), 'vendido_fecha_futura');
});

test('con guia o con otras etapas no cambia nada', () => {
  assert.equal(classifierStageWithoutGuide({ stage: 'en_camino', card: { guia: '84943668' } }, 'esperando_retiro'), 'esperando_retiro');
  assert.equal(classifierStageWithoutGuide({ stage: 'negociando', card: {} }, 'vendido'), 'vendido');
  assert.equal(classifierStageWithoutGuide({ stage: 'negociando', card: {} }, 'interesado'), 'interesado');
});

test('stageGuessedWithoutGuide', () => {
  assert.equal(stageGuessedWithoutGuide({ stage: 'esperando_retiro', card: {} }), true);
  assert.equal(stageGuessedWithoutGuide({ stage: 'esperando_retiro', card: { guia: '1' } }), false);
  assert.equal(stageGuessedWithoutGuide({ stage: 'en_camino', card: {}, shippingNotifiedAt: 'x' }), false);
  assert.equal(stageGuessedWithoutGuide({ stage: 'vendido', card: {} }), false);
});

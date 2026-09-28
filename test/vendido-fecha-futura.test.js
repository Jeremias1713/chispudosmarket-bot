// Nueva etapa pedida por el negocio: "Vendido - fecha futura"
// (vendido_fecha_futura). Es un pedido YA cerrado (mismo caso que
// "vendido"), pero el despacho/la entrega se pospusieron A PROPOSITO para
// mas adelante porque el cliente pidio una fecha puntual futura. Se
// comporta igual que "vendido"/"esperando_guia" en todo el pipeline
// (cuenta como venta cerrada, mismo rango logistico, puede avanzar a
// en_camino si llega una guia real), pero es de uso MANUAL: el clasificador
// de IA nunca la elige sola (mismo criterio que "esperando_guia"), para no
// confundirla con "escribir_mas_tarde" (esa es para un pedido que TODAVIA
// no se cerro).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { STAGES } = require('../src/classifier');
const {
  SOLD_STAGES,
  LOGISTIC_RANK,
  logisticRank,
  isAllowedAutoTransition,
  canAdvanceToEnCaminoOnGuia,
} = require('../src/stageRules');
const { buildSystemPrompt } = require('../src/ai');

test('STAGES incluye "vendido_fecha_futura"', () => {
  assert.ok(STAGES.includes('vendido_fecha_futura'));
});

test('el clasificador de IA nunca la elige sola: no aparece en el prompt (igual que esperando_guia)', () => {
  const classifierSrc = fs.readFileSync(require.resolve('../src/classifier.js'), 'utf8');
  const promptStart = classifierSrc.indexOf('const CLASSIFIER_PROMPT');
  const promptEnd = classifierSrc.indexOf('async function classifyConversation');
  const prompt = classifierSrc.slice(promptStart, promptEnd);
  assert.doesNotMatch(prompt, /vendido_fecha_futura/);
  // esperando_guia tampoco esta, como referencia del mismo patron.
  assert.doesNotMatch(prompt, /esperando_guia/);
});

test('cuenta como venta cerrada (SOLD_STAGES) igual que "vendido"', () => {
  assert.ok(SOLD_STAGES.includes('vendido_fecha_futura'));
});

test('comparte el mismo rango logistico que "vendido"/"esperando_guia" (recien cerrado, sin despachar)', () => {
  assert.equal(logisticRank('vendido_fecha_futura'), logisticRank('vendido'));
  assert.equal(logisticRank('vendido_fecha_futura'), logisticRank('esperando_guia'));
  assert.equal(LOGISTIC_RANK.vendido_fecha_futura, 1);
});

test('una reclasificacion automatica nunca puede "desvender" un pedido en vendido_fecha_futura', () => {
  assert.equal(isAllowedAutoTransition('vendido_fecha_futura', 'interesado'), false);
  assert.equal(isAllowedAutoTransition('vendido_fecha_futura', 'nuevo'), false);
  // Pero si avanza de verdad (llego una guia y se reclasifico), se permite.
  assert.equal(isAllowedAutoTransition('vendido_fecha_futura', 'en_camino'), true);
});

test('cargar una guia real puede avanzarlo a en_camino, igual que vendido/esperando_guia', () => {
  assert.equal(canAdvanceToEnCaminoOnGuia('vendido_fecha_futura', false), true);
});

test('el panel tiene una etiqueta en español para mostrarla', () => {
  const panelSrc = fs.readFileSync(require.resolve('../src/web/panel.js'), 'utf8');
  assert.match(panelSrc, /vendido_fecha_futura:\s*'Vendido - fecha futura'/);
});

test('buildSystemPrompt: con shippingStage vendido_fecha_futura, avisa que la demora es intencional (no que "se esta preparando")', () => {
  const prompt = buildSystemPrompt(null, 'Turkesterone', true, true, 'vendido_fecha_futura', null);
  assert.match(prompt, /A PROPOSITO/);
  assert.match(prompt, /pospuestos/);
});

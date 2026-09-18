// Hallazgo 2 del reporte: las definiciones de "esperando_retiro" y
// "en_camino" en classifier.js contradecian a src/ai.js (SHIPPING_STAGE_TEXT).
// No se puede probar el prompt en si (es texto para el modelo de IA), pero
// esto confirma que el texto del prompt quedo unificado con el significado
// real que usa el resto del sistema (seguimiento.js, shipping.js, ai.js):
// en_camino = despacho todavia sin llegar; esperando_retiro = ya llego.
// La proteccion robusta de verdad contra una mala clasificacion vive en
// stageRules.isAllowedAutoTransition (ver stageRules.test.js), que no
// depende de que el modelo entienda bien el prompt.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const classifierSrc = fs.readFileSync(require.resolve('../src/classifier.js'), 'utf8');

// El prompt no se exporta desde classifier.js, pero alcanza con leer el
// archivo fuente como texto (no hace falta evaluarlo) para confirmar que las
// definiciones quedaron unificadas.
function extractPrompt() {
  return classifierSrc;
}

test('STAGES incluye las etapas logisticas esperadas, en el orden documentado', () => {
  const { STAGES } = require('../src/classifier');
  for (const s of ['vendido', 'esperando_guia', 'tienda_maracaibo', 'en_camino', 'esperando_retiro', 'entregado', 'devolucion']) {
    assert.ok(STAGES.includes(s), `falta la etapa "${s}" en STAGES`);
  }
});

test('el prompt describe "en_camino" como despachado pero SIN llegar todavia (unificado con ai.js)', () => {
  const src = extractPrompt();
  const bloque = src.slice(src.indexOf('- en_camino:'), src.indexOf('- esperando_retiro:'));
  assert.match(bloque, /TODAVIA NO llego/i);
  assert.doesNotMatch(bloque, /ya\s*llego\s*a\s*la\s*agencia\s*y\s*esta\s*listo/i, 'en_camino no debe describirse como "ya llego" (eso es esperando_retiro)');
});

test('el prompt describe "esperando_retiro" como YA LLEGO a la agencia (unificado con ai.js)', () => {
  const src = extractPrompt();
  const bloque = src.slice(src.indexOf('- esperando_retiro:'), src.indexOf('- entregado:'));
  assert.match(bloque, /YA LLEGO/i);
});

test('el prompt le prohibe explicitamente al clasificador inferir la llegada solo por tener guia', () => {
  const src = extractPrompt();
  assert.match(src, /JAMAS uses eso para inferir que el pedido YA LLEGO/i);
});

test('el prompt le prohibe marcar "entregado" solo por el paso del tiempo', () => {
  const src = extractPrompt();
  const bloque = src.slice(src.indexOf('- entregado:'), src.indexOf('Ademas de la etapa'));
  assert.match(bloque, /NUNCA marques "entregado" solo/i);
  assert.match(bloque, /paso del tiempo|nunca "entregado" por el solo paso del tiempo/i);
});

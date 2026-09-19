// Punto 2 del pedido: el negocio reporto encontrar, en las plantillas de
// PRODUCTO configuradas a mano en el panel, frases como "la energia se
// siente en los primeros dias" y "con uno solo te quedas a medio camino".
// Esas plantillas viven en products.json en el disco de produccion (fuera
// de este repositorio: no hay archivo adjunto ni acceso a ese disco desde
// aca, ver el informe para el detalle de este bloqueo real). Como
// correccion de CODIGO (separada de la correccion de CONFIGURACION que
// sigue pendiente, ver informe), se agrega un filtro deterministico que
// saca esas afirmaciones de CUALQUIER respuesta final, venga de donde venga
// (prompt de producto, base de conocimiento, o el modelo por su cuenta).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scrubUnverifiedResultClaims } = require('../src/ai');

test('saca la promesa de resultado "en los primeros dias" y conserva el resto del mensaje', () => {
  const original = 'Hola! La energia se siente en los primeros dias de tomarlo. Es un shilajit puro.';
  const resultado = scrubUnverifiedResultClaims(original);
  assert.ok(!/primeros d[ií]as/i.test(resultado), 'la promesa de plazo no puede seguir en el texto final');
  assert.match(resultado, /shilajit puro/i, 'el resto del mensaje, sin la promesa, se tiene que conservar');
});

test('saca la insinuacion de "a medio camino" y conserva el resto de la oracion (nivel clausula, no oracion completa)', () => {
  const original = 'Con uno solo te quedas a medio camino, mejor llevate dos.';
  const resultado = scrubUnverifiedResultClaims(original);
  assert.ok(!/medio camino/i.test(resultado));
  assert.match(resultado, /llevate dos/i, 'la clausula sin la promesa se conserva, no hace falta tirar toda la oracion');
});

test('si la respuesta ENTERA es la promesa no sostenible, manda un mensaje de repuesto (nunca la promesa ni un mensaje vacio)', () => {
  const resultado = scrubUnverifiedResultClaims('A medio camino.');
  assert.ok(!/medio camino/i.test(resultado));
  assert.ok(resultado.trim().length > 0, 'nunca se manda un mensaje vacio');
});

test('variante "resultados visibles desde el primer dia" tambien se detecta', () => {
  const resultado = scrubUnverifiedResultClaims('Los resultados son visibles desde el primer dia, es muy potente.');
  assert.ok(!/primer d[ií]a/i.test(resultado));
  assert.match(resultado, /muy potente/i);
});

test('un texto sin ninguna promesa no sostenible queda exactamente igual', () => {
  const original = 'El precio es 25 dolares y viene en presentacion de 60 capsulas.';
  assert.equal(scrubUnverifiedResultClaims(original), original);
});

test('no confunde una mencion legitima de "primeros dias" sin promesa de efecto/resultado (falso positivo evitado)', () => {
  // Ejemplo: hablar de los primeros dias del mes, o de entrega, no de un
  // efecto/resultado del producto -- esto NO tiene que dispararse.
  const original = 'Los pedidos de los primeros dias del mes se despachan mas rapido.';
  assert.equal(scrubUnverifiedResultClaims(original), original, 'esto no es una promesa de resultado del producto, no deberia tocarse');
});

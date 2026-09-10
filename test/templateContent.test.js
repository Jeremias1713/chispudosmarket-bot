// FASE 2/5 (H06 + H17): contrato para src/templateContent.js -- la funcion
// unica que va a reemplazar la logica hoy duplicada en broadcasts.js,
// personalizedBroadcast.js, seguimiento.js y shipping.js para armar el
// contenido final de una plantilla (texto con variables reemplazadas,
// header, footer, botones), y que el panel va a usar tanto para
// previsualizar como para probar como para el envio real (mismo camino,
// sin diferencias de nombre/producto/monto/imagen entre los tres).
//
// Estos tests estan escritos ANTES de la implementacion (todavia tira
// "TODO" a proposito) para dejar fijado el contrato esperado. Fallan hoy
// a proposito; van a pasar cuando se implemente H06/H17.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePlaceholders, buildTemplateContent } = require('../src/templateContent');

test('H06 - resolvePlaceholders reemplaza {{1}}, {{2}} en orden por los values dados', () => {
  const resultado = resolvePlaceholders('Hola {{1}}, tu pedido de {{2}} ya salio.', ['Juan', 'Shilajit']);
  assert.equal(resultado, 'Hola Juan, tu pedido de Shilajit ya salio.');
});

test('H06 - resolvePlaceholders no rompe si faltan values para algun placeholder', () => {
  assert.doesNotThrow(() => resolvePlaceholders('Hola {{1}}, monto {{2}}', ['Juan']));
});

test('H17 - buildTemplateContent arma header de imagen, body con variables, footer y botones', () => {
  const components = [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Hola {{1}}, tu guia de {{2}} es {{3}}.' },
    { type: 'FOOTER', text: 'Gracias por tu compra' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Ver estado' }] },
  ];
  const resultado = buildTemplateContent({
    components,
    values: ['Juan', 'Shilajit', 'ABC123'],
    headerImageUrl: 'https://cdn.example.com/guia.jpg',
  });
  assert.equal(resultado.bodyText, 'Hola Juan, tu guia de Shilajit es ABC123.');
  assert.equal(resultado.footerText, 'Gracias por tu compra');
  assert.equal(resultado.headerImageUrl, 'https://cdn.example.com/guia.jpg');
  assert.deepEqual(resultado.buttons, [{ type: 'QUICK_REPLY', text: 'Ver estado' }]);
});

test('H17 - buildTemplateContent devuelve null en los campos que la plantilla no tiene (sin inventar)', () => {
  const components = [{ type: 'BODY', text: 'Hola {{1}}.' }];
  const resultado = buildTemplateContent({ components, values: ['Juan'] });
  assert.equal(resultado.footerText, null);
  assert.equal(resultado.headerImageUrl, null);
  assert.deepEqual(resultado.buttons, null);
});

test('H06/H17 - preview, prueba y envio real deben poder llamar a buildTemplateContent con los mismos argumentos (mismo resultado)', () => {
  const components = [{ type: 'BODY', text: 'Hola {{1}}, monto {{2}}.' }];
  const args = { components, values: ['Juan', '34900bs'] };
  const preview = buildTemplateContent(args);
  const prueba = buildTemplateContent(args);
  const envioReal = buildTemplateContent(args);
  assert.deepEqual(preview, prueba);
  assert.deepEqual(prueba, envioReal);
});

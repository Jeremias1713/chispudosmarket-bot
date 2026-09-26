'use strict';
// La agencia del pedido se toma del resumen confirmado ("Agencia: X") y nunca
// de frases como "dentro de los 5 dias habiles" o "la oficina mas cercana".
// Caso real: Alexis Garcia, San Fernando de Apure. Datos simulados, sin red.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-order-agencia-historial');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const automation = require('../src/dropanasOrderAutomation');

after(() => cleanup(dataDir));

test('usa la agencia del resumen y no la pisa con "dentro de los 5 dias habiles"', () => {
  const facts = automation.historyOrderFacts([
    { role: 'assistant', content: '🚚 Enviaremos tu pedido GRATIS por Tealca a la oficina más cercana.' },
    { role: 'assistant', content: '- **Producto:** 2 frascos de Shilajit\n- **Nombre:** Alexis García\n- **Agencia:** San Fernando De Apure' },
    { role: 'assistant', content: 'El pago se hace contra entrega en la agencia. Recuerda que tendrás 5 días hábiles para pasar a retirarlo y pagarlo.' },
    { role: 'assistant', content: '¿Confirmas que podrás retirar y pagar en la agencia dentro de los 5 días hábiles?' },
    { role: 'assistant', content: '- **2 frascos de Shilajit**\n- **Agencia:** San Fernando De Apure\n- **Pago:** Contra entrega' },
  ]);
  assert.equal(facts.agency, 'San Fernando De Apure');
});

test('frases que no son una sucursal no cuentan como agencia', () => {
  for (const phrase of [
    'dentro de los 5 días hábiles', 'más cercana', 'la más cercana', 'TEALCA más cercana',
    'al momento de retirar', 'al momento de retirar tu pedido', 'cuando llegues a Barquisimeto', 'Tealca',
  ]) {
    assert.equal(automation.cleanAgency(phrase), null, phrase);
  }
});

test('los nombres reales de sucursal se conservan', () => {
  assert.equal(automation.cleanAgency('**Tealca de Carupano**'), 'Tealca de Carupano');
  assert.equal(automation.cleanAgency('Nueva Barcelona'), 'Nueva Barcelona');
  assert.equal(automation.cleanAgency('Los Guayos'), 'Los Guayos');
  assert.equal(automation.cleanAgency('La Fría'), 'La Fría');
  assert.equal(automation.cleanAgency('1. El Vigía'), 'El Vigía');
  assert.equal(automation.cleanAgency('Maracaibo Sur (San Francisco) ubicada en Calle 18'), 'Maracaibo Sur (San Francisco) ubicada en Calle 18');
});

test('si solo hay frases genericas, el pedido pide confirmar la oficina en vez de inventarla', () => {
  const facts = automation.historyOrderFacts([
    { role: 'assistant', content: 'Te enviamos tu pedido para la agencia más cercana.' },
    { role: 'assistant', content: 'Recuerda retirar en la agencia al momento de retirar tu pedido.' },
  ]);
  assert.equal(facts.agency, null);
});

test('la ultima agencia confirmada es la que vale', () => {
  const facts = automation.historyOrderFacts([
    { role: 'assistant', content: 'Resumen:\n- Agencia: Valencia Norte' },
    { role: 'assistant', content: 'Listo, cambiamos tu pedido.\n- Agencia: Los Guayos' },
  ]);
  assert.equal(facts.agency, 'Los Guayos');
});

test('explica si el 403 viene de la API (codigo) o de un firewall (pagina HTML)', () => {
  const api = automation.describeApiError({ response: { status: 403, headers: { 'content-type': 'application/json' }, data: { success: false, error: { code: 'CROSS_MODE_OPERATION_FORBIDDEN', message: 'Modo cruzado' } } } });
  assert.equal(api, '403 — CROSS_MODE_OPERATION_FORBIDDEN — Modo cruzado');
  const waf = automation.describeApiError({ response: { status: 403, headers: { 'content-type': 'text/html', 'cf-ray': 'x' }, data: '<!DOCTYPE html><html>Attention Required</html>' } });
  assert.match(waf, /firewall de Cloudflare/);
  assert.equal(automation.describeApiError({ code: 'ECONNRESET' }), 'ECONNRESET');
});

test('un 422 de DroPanas muestra el codigo y los campos rechazados', () => {
  const text = automation.describeApiError({ response: { status: 422, headers: { 'content-type': 'application/json' }, data: {
    message: 'Datos invalidos', code: 'VALIDATION_ERROR',
    errors: { 'cliente.telefono': ['El telefono debe tener 11 digitos'], 'productos.0.variante_id': ['Es obligatorio'] },
  } } });
  assert.match(text, /^422 — VALIDATION_ERROR — Datos invalidos/);
  assert.match(text, /cliente\.telefono: El telefono debe tener 11 digitos/);
  assert.match(text, /productos\.0\.variante_id: Es obligatorio/);
});

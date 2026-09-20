// Pruebas unitarias de las correcciones de src/ai.js pedidas en la
// regresion reportada en produccion (branch regresion-cierre-secuencial-
// 20260919), puntos 3, 4, 6 y 7. Reproduce primero (contra la version sin
// corregir, ver el comentario en cada test) el escenario real reportado, y
// verifica que con la correccion el resultado sea el esperado.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('ai-regresion-cierre-secuencial');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikeCustomerDataProvided,
  looksLikeAgencyConfirmation,
  looksLikeClosingSummaryText,
  looksLikeQuantityMentioned,
  evaluateOrderCompleteness,
} = require('../src/ai');

after(() => cleanup(dataDir));

// --- PUNTO 3: looksLikeCustomerDataProvided con cedula y telefono pegados ---

test('PUNTO 3 (reproduccion real): "Persona Ejemplo 12345678. 04121234567" SI se reconoce como cedula+telefono', () => {
  assert.equal(
    looksLikeCustomerDataProvided('Persona Ejemplo 12345678. 04121234567'),
    true,
    'BUG si esto es false: la cedula y el telefono, separados por ". ", se estaban fusionando en un solo bloque que no matcheaba ningun rango valido'
  );
});

test('PUNTO 3: cedula con puntos de agrupacion y telefono con guiones/espacios/+58 se siguen reconociendo', () => {
  assert.equal(looksLikeCustomerDataProvided('Jesus Gonzalez, cedula 16.626.658, telefono 0426-415-5170'), true);
  assert.equal(looksLikeCustomerDataProvided('Nombre: Ana Diaz. Cedula: 20123456. Tel: +58 412-123-4567'), true);
});

test('PUNTO 3: un telefono solo (sin cedula) nunca cuenta como cedula+telefono a la vez', () => {
  assert.equal(looksLikeCustomerDataProvided('mi telefono es 04121234567'), false);
});

test('PUNTO 3: sin ningun numero de por medio, no hay datos que reconocer', () => {
  assert.equal(looksLikeCustomerDataProvided('todavia no te pase mis datos'), false);
});

// --- PUNTO 4: looksLikeAgencyConfirmation ---

test('PUNTO 4 (reproduccion real): "Si" respondiendo a "¿Te queda bien esta agencia...?" sobre UNA sola agencia mostrada SI confirma el destino', () => {
  const botMsg = '1. Carupano — Sucre\nCalle Independencia, cruce con calle Acosta\n¿Te queda bien esta agencia para retirar tu pedido?';
  assert.equal(
    looksLikeAgencyConfirmation(botMsg, 'Si'),
    true,
    'BUG si esto es false: un "si" respondiendo a la confirmacion de UNA agencia puntual tiene que contar como destino resuelto'
  );
});

test('PUNTO 4: un "si" despues de una lista de VARIAS agencias no elige ninguna de forma arbitraria', () => {
  const botMsg = '1. Agencia Catia\n2. Agencia Chacao\n3. Agencia Petare\n¿Cual te queda bien?';
  assert.equal(
    looksLikeAgencyConfirmation(botMsg, 'Si'),
    false,
    'BUG si esto es true: con varias agencias listadas, un "si" suelto es ambiguo y no puede elegir ninguna'
  );
});

test('PUNTO 4: un "si" que en realidad es una retractacion ("no, mejor espera") no cuenta como confirmacion', () => {
  const botMsg = '1. Agencia Maracaibo Centro\n¿Te queda bien esta agencia?';
  assert.equal(looksLikeAgencyConfirmation(botMsg, 'no, mejor esperate'), false);
});

test('PUNTO 4: evaluateOrderCompleteness usa looksLikeAgencyConfirmation cuando cardAgencia no esta cargada (clasificador no la completa)', () => {
  const result = evaluateOrderCompleteness({
    text: 'Tu pedido de 2 Shilajit por 51.900 Bs queda listo, retiras en la agencia de Carupano. El pago se hace contra entrega.',
    knownCustomer: { nombre: 'Jesus Gonzalez', cedula: '16626658', telefono: '04264155170' },
    recentUserText: 'dale, esta bien',
    knownProduct: 'Shilajit',
    knownCity: 'carupano',
    cardAgencia: null, // a proposito: nadie completo este campo (ver classifier.js)
    lastAssistantText: '1. Carupano — Sucre\n¿Te queda bien esta agencia para retirar tu pedido?',
    lastUserMessage: 'Si',
  });
  assert.ok(!result.missing.includes('modalidad_destino'), `BUG si "modalidad_destino" sigue faltando: ${JSON.stringify(result.missing)}`);
});

// --- PUNTO 6: looksLikeClosingSummaryText ---

test('PUNTO 6 (reproduccion real): una pregunta de cortesia al FINAL de un cierre real no anula la deteccion', () => {
  const texto = 'Tu pedido de 2 Frascos por 51.900 Bs queda asi: retiro en la agencia de Carupano. El pago se hace contra entrega. ¡Listo! ¿Hay algo más en lo que te pueda ayudar?';
  assert.equal(
    looksLikeClosingSummaryText(texto),
    true,
    'BUG si esto es false: antes CUALQUIER "?" en el texto (incluida una cortesia al final) descartaba el cierre entero'
  );
});

test('PUNTO 6 (reproduccion real): una pregunta que SI es parte del cierre en si (no cortesia) sigue bloqueando la deteccion', () => {
  const texto = 'Tu pedido de 2 Frascos por 51.900 Bs queda asi, pago contra entrega, ¿confirmas que asi esta bien?';
  assert.equal(looksLikeClosingSummaryText(texto), false, 'una pregunta que es PARTE del cierre (no una cortesia generica) tiene que seguir bloqueando');
});

test('PUNTO 6 (reproduccion real): una explicacion general de politica (pago contra entrega + guia) sin ningun dato puntual del pedido NO es un cierre', () => {
  const texto = 'Para Tealca el pago es contra entrega y enviamos la guia cuando despachamos.';
  assert.equal(
    looksLikeClosingSummaryText(texto),
    false,
    'BUG si esto es true: mencionar pago+guia/tealca sin ningun dato puntual (cantidad o monto) es una explicacion general, no el resumen de UN pedido'
  );
});

test('PUNTO 6: un cierre real de domicilio (sin mencionar tealca/agencia/guia) con cantidad y monto SI se detecta', () => {
  const texto = 'Listo! Te llevamos 2 Shilajit (Bs 700) a tu direccion. El pago es contra entrega, en efectivo o pago movil.';
  assert.equal(looksLikeClosingSummaryText(texto), true);
});

test('PUNTO 6: "envio gratis" y "pagas al recibir" del mensaje inicial NO se confunden con un cierre (no mencionan forma de pago real ni dato puntual)', () => {
  const texto = 'ENVIO GRATIS A TODA VENEZUELA y PAGAS AL RECIBIR. Para enviarte hoy mismo, ¿cual combo prefieres?';
  assert.equal(looksLikeClosingSummaryText(texto), false);
});

// --- PUNTO 7: looksLikeQuantityMentioned ---

test('PUNTO 7 (reproduccion real): "3" respondiendo al menu de bienvenida (1 Frasco/2 Frascos/Tengo una duda) NO es una cantidad', () => {
  const menu = '1️⃣ 1 Frasco\n2️⃣ 2 Frascos (Oferta)\n3️⃣ Tengo una duda antes de pedir\n\n(Respondeme con el numero 1, 2 o 3) 👇';
  assert.equal(
    looksLikeQuantityMentioned('3', menu),
    false,
    'BUG si esto es true: "3" respondiendo a ese menu especifico significa "tengo una duda", no una cantidad de 3 unidades'
  );
});

test('PUNTO 7: el mismo "3" SIN el contexto del menu de bienvenida SI cuenta como cantidad (respuesta directa a "cuantos queres")', () => {
  assert.equal(looksLikeQuantityMentioned('3', '¿Cuantos frascos queres pedir?'), true);
  assert.equal(looksLikeQuantityMentioned('3', null), true);
});

test('PUNTO 7 (reproduccion real): "Dos" aislado (una sola palabra, sin "frasco" al lado) SI se reconoce como cantidad', () => {
  assert.equal(
    looksLikeQuantityMentioned('Dos'),
    true,
    'BUG si esto es false: antes solo se reconocia la palabra de cantidad si aparecia junto a "frasco"/"unidad"'
  );
});

test('PUNTO 7: "El Combo Dos" (con contexto alrededor) sigue reconociendose igual que antes', () => {
  assert.equal(looksLikeQuantityMentioned('El Combo Dos'), true);
});

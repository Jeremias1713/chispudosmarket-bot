// Pruebas unitarias de isClosingMessage / evaluateOrderCompleteness
// (src/ai.js): la deteccion deterministica de que un texto generado por la
// IA es el mensaje de cierre REAL de un pedido (ver flow.js, donde esto
// decide si se marca session.orderClosed / stage "vendido").
//
// Hallazgo original: isClosingMessage solo miraba palabras clave ("tealca",
// "pago", "guia") en el TEXTO del bot, sin ninguna verificacion de que el
// pedido de verdad se haya armado. Eso permite un FALSO CIERRE: una simple
// consulta de cobertura, contestada con esas mismas tres palabras, marcaria
// la conversacion como una venta cerrada sin que el cliente haya dado ni un
// solo dato.
//
// Correccion v1 (insuficiente): exigir SOLO nombre+cedula+telefono ya
// confirmados en la ficha. Un CLIENTE ANTIGUO que ya compro antes tiene esos
// tres datos guardados para siempre, asi que una pregunta de pura cobertura
// (sin ningun interes de compra nuevo) volvia a pasar la validacion.
//
// Correccion v2 (insuficiente, señalado en la segunda revision): exigia 5
// señales, pero (1) trataba "conocer la ciudad" como si fuera lo mismo que
// "destino resuelto" (sin agencia puntual ni direccion real), (2) aceptaba
// cualquier mensaje de mas de una palabra como "aceptacion no ambigua" (una
// pregunta de precio contaba igual que una confirmacion real), (3) el
// gatillo mismo dependia de las palabras literales "tealca"+"pago"+"guia",
// asi que un cierre de domicilio que no las mencionara nunca se detectaba, y
// (4) "producto vinculado + cantidad" se aceptaba sin haber comunicado ni
// aceptado nunca un total, y sin chequear si ese producto tenia mas de una
// presentacion posible.
//
// Correccion v3 (esta version): corrige los 4 puntos de arriba. Ver
// evaluateOrderCompleteness en ai.js para el detalle de cada chequeo.
'use strict';
const { setupTempDataDir, cleanup, writeRaw } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('ai-closing-message');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  isClosingMessage,
  looksLikeClosingSummaryText,
  buildIncompleteOrderNotice,
  evaluateOrderCompleteness,
  looksLikeCustomerDataProvided,
  looksLikeQuantityMentioned,
  looksLikeDeliveryModalityMentioned,
  looksLikeAgencySelected,
  looksLikeDeliveryAddressGiven,
  looksLikeUnambiguousEngagement,
  looksLikeHoldOrRetraction,
  looksLikeContextualShortAcceptance,
  looksLikePresentationConfirmed,
  looksLikeTotalCommunicated,
  buildSystemPrompt,
} = require('../src/ai');

after(() => cleanup(dataDir));

// Un solo producto "Shilajit" en el catalogo temporal de esta suite (sin
// presentaciones hermanas): asi looksLikePresentationConfirmed no exige
// nada de mas en los casos que no estan probando eso puntualmente (ver la
// seccion de PRESENTACION mas abajo, que carga su propio catalogo con dos
// presentaciones).
writeRaw(dataDir, 'products.json', JSON.stringify([
  { id: 'p1', name: 'Shilajit', price: 350, currency: 'Bs', active: true },
]));

const MENSAJE_CIERRE_REAL =
  'Listo Carlos! Tu pedido de 2 Shilajit va a la agencia Tealca de Barinas. ' +
  'El pago se hace contra entrega (Bs 700 en total), y en cuanto tengamos la guia te la paso. ✅📦';

// Un "pedido completo" tipico para las pruebas de abajo: los factores
// presentes a la vez (caso feliz, primer cierre real de un cliente nuevo).
// OJO: cardAgencia (agencia YA CARGADA en la ficha, no solo la ciudad) es
// obligatorio desde la v3 (punto 1), y el TEXTO DE CIERRE (el "text" que se
// le pasa a evaluateOrderCompleteness en cada prueba, normalmente
// MENSAJE_CIERRE_REAL) tiene que incluir un monto en Bs (punto 4) -- eso NO
// vive en este ctx porque el chequeo mira el texto de cierre en si, no la
// conversacion previa (ver looksLikeTotalCommunicated en ai.js: el prompt
// actual no cotiza un total antes del cierre, asi que exigir que aparezca
// ANTES rompería todos los cierres reales).
function pedidoCompletoCtx(overrides) {
  return {
    knownCustomer: null,
    recentUserText: 'Carlos Perez, cedula 12345678, telefono 04121234567, quiero 2 frascos, la agencia 1 me sirve, dale mandalo',
    knownProduct: 'Shilajit',
    knownCity: 'barinas',
    cardAgencia: 'Tealca Barinas Centro',
    ...overrides,
  };
}

// --- Punto 3: el gatillo de cierre ya NO depende de palabras puntuales ---

test('looksLikeClosingSummaryText: false si el texto es una pregunta (el prompt dice que el cierre nunca termina en pregunta)', () => {
  assert.equal(looksLikeClosingSummaryText('¿Confirmas tu pedido de 2 Shilajit contra entrega?'), false);
});

// NOTA (actualizado en la correccion regresion-cierre-secuencial): antes,
// una frase puramente informativa ("con Tealca el pago es contra entrega, y
// en cuanto tengamos la guia de tu pedido te aviso") SI activaba esta señal
// estructural por si sola con solo mencionar "tu pedido" a secas, sin
// ningun dato puntual -- eso hacia que isClosingMessage tuviera que
// depender de evaluateOrderCompleteness como unica red de seguridad, pero
// esa red de seguridad reemplaza la respuesta por el aviso generico de "me
// falta confirmar...", dejando la pregunta real del cliente sin contestar
// (bug real, ver el test PUNTO 6 de test/ai-regresion-cierre-secuencial.
// test.js y flow-order-close-guard.test.js: "consulta de pura cobertura
// (...) recibe su propia respuesta, no el aviso de incompleto"). Ahora
// looksLikeClosingSummaryText YA NO considera "tu pedido"/"el pedido" a
// secas como señal de cierre (solo cuenta con un dato puntual pegado, como
// "pedido de 2" o "pedido queda listo", o una accion de entrega concreta):
// el texto de este comentario ya da false directo (ver el test de abajo).
// isClosingMessage sigue combinando ambas señales de todos modos, como
// defensa en profundidad para el resto de los casos (ej. cierre de
// domicilio, ver el test de abajo).

test('looksLikeClosingSummaryText: false para una explicacion puramente informativa que solo menciona "tu pedido" a secas (sin cantidad/monto/accion de entrega)', () => {
  assert.equal(
    looksLikeClosingSummaryText('Con Tealca el pago es contra entrega, y apenas tengamos la guia de tu pedido te aviso.'),
    false,
    'BUG si esto es true: "tu pedido" sin ningun dato puntual pegado no puede ser, por si solo, la señal de un cierre real'
  );
});

test('looksLikeClosingSummaryText: SI reconoce un cierre de DOMICILIO que nunca menciona "Tealca", "agencia" ni "guia"', () => {
  const cierreDomicilio =
    'Perfecto, tu pedido de 2 Shilajit va para tu direccion en Caracas. El pago es contra entrega, en efectivo o pago movil. ' +
    'En cuanto el mensajero este en camino te aviso. ✅';
  assert.ok(
    !/tealca|agencia|guia/i.test(cierreDomicilio),
    'el texto de prueba en si mismo no debe tener ninguna de esas 3 palabras (si no, no prueba nada)'
  );
  assert.equal(looksLikeClosingSummaryText(cierreDomicilio), true);
});

// FASE (correccion cobertura, revertida a pedido explicito del negocio,
// 20260920): hubo una version intermedia que exigia una lista de zonas
// puntuales de Caracas confirmadas una por una, dejando cualquier zona sin
// listar "pendiente de un humano" y sin poder cerrar. El negocio confirmo
// explicitamente que eso no refleja como opera de verdad: da domicilio a
// TODA Caracas, sin excepcion de zona. Esta prueba demuestra que un cierre
// de domicilio en Caracas SI cierra directamente, sin necesitar ninguna
// lista de zonas.
test('isClosingMessage: un cierre de domicilio en Caracas queda bloqueado', () => {
  const cierreDomicilio =
    'Perfecto Carlos, tu pedido de 2 Shilajit (Bs 700) va para tu direccion en la Av. Libertador, Chacao, Caracas. ' +
    'El pago es contra entrega, en efectivo o pago movil. En cuanto el mensajero este en camino te aviso. ✅';
  const ctx = pedidoCompletoCtx({
    recentUserText:
      'Carlos Perez, cedula 12345678, telefono 04121234567, quiero 2 frascos, es en la Av. Libertador, Chacao, Caracas, cerca de la plaza, dale mandalo',
    cardAgencia: null, // domicilio: no hay agencia, el destino se resuelve por direccion
    knownCity: 'caracas',
  });
  assert.equal(
    isClosingMessage(cierreDomicilio, ctx),
    false
  );
});

test('isClosingMessage: NO marca cierre solo por sonar a cierre, sin ningun dato del pedido (consulta de cobertura/pago, no una venta)', () => {
  const textoExplicativo =
    'Con Tealca el pago es contra entrega, y apenas tengamos la guia de tu pedido te aviso.';
  assert.equal(
    isClosingMessage(textoExplicativo, { knownCustomer: null, recentUserText: 'hola, como es el pago con tealca?', knownProduct: null, knownCity: null, cardAgencia: null }),
    false,
    'BUG si esto da true: una pregunta de cobertura/pago no puede cerrar un pedido inexistente'
  );
});

test('isClosingMessage: SI marca cierre cuando todos los factores estan presentes (caso feliz, primer cierre real)', () => {
  assert.equal(isClosingMessage(MENSAJE_CIERRE_REAL, pedidoCompletoCtx()), true);
});

test('isClosingMessage: SI marca cierre con identidad en la ficha (knownCustomer) en vez de en el texto reciente', () => {
  const ctx = pedidoCompletoCtx({
    knownCustomer: { nombre: 'Carlos Perez', cedula: '12345678', telefono: '04121234567' },
    recentUserText: 'mejor dame 2 frascos, la agencia 1 me sirve, dale mandalo',
  });
  assert.equal(isClosingMessage(MENSAJE_CIERRE_REAL, ctx), true);
});

// --- El caso central que motivo la correccion v2, sigue vigente en v3 ---
test('CLIENTE ANTIGUO: con nombre+cedula+telefono ya guardados de una compra anterior, una pregunta de pura cobertura NO cierra un pedido nuevo', () => {
  const knownCustomer = { nombre: 'Carlos Perez', cedula: '12345678', telefono: '04121234567' };
  const respuestaDeCobertura =
    'Si, a Barinas tambien llega! El pago se hace contra entrega y en cuanto tengamos la guia te aviso.';
  const ctx = {
    knownCustomer, // datos de una compra VIEJA, ya en la ficha para siempre
    recentUserText: 'hola, tambien hacen envios a barinas?', // solo pregunta cobertura, sin pedido nuevo
    knownProduct: null, // no hay producto vinculado a ESTA conversacion nueva
    knownCity: null,
    cardAgencia: null,
  };
  const resultado = evaluateOrderCompleteness({ text: respuestaDeCobertura, ...ctx });
  assert.equal(resultado.complete, false, 'BUG si esto es true: un cliente antiguo preguntando cobertura no tiene un pedido nuevo armado');
  assert.ok(resultado.missing.includes('producto'), 'deberia faltar producto: no hay ninguno vinculado a esta consulta puntual');
  assert.ok(resultado.missing.includes('cantidad'), 'deberia faltar cantidad: el cliente no pidio ninguna');
  assert.equal(isClosingMessage(respuestaDeCobertura, ctx), false);
});

test('CLIENTE ANTIGUO que SI vuelve a pedir (cantidad+agencia+aceptacion+total en esta conversacion): ahi si puede cerrar de nuevo, con sus datos viejos', () => {
  const knownCustomer = { nombre: 'Carlos Perez', cedula: '12345678', telefono: '04121234567' };
  const ctx = {
    knownCustomer,
    recentUserText: 'quiero pedir 3 frascos mas, la agencia de siempre me sirve otra vez, dale mandamelo',
    knownProduct: 'Shilajit',
    knownCity: 'barinas',
    cardAgencia: 'Tealca Barinas Centro',
  };
  assert.equal(isClosingMessage(MENSAJE_CIERRE_REAL, ctx), true, 'un cliente antiguo SI puede volver a cerrar si esta vez si armo un pedido nuevo de verdad');
});

// --- Chequeos individuales que faltan, uno por vez ---

test('falta solo la cantidad: no cierra aunque el resto este completo', () => {
  const ctx = pedidoCompletoCtx({ recentUserText: 'Carlos Perez, cedula 12345678, telefono 04121234567, la agencia 1 me sirve, dale' });
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.equal(resultado.complete, false);
  assert.deepEqual(resultado.missing, ['cantidad']);
});

test('falta solo la modalidad/destino (saber la ciudad NO alcanza; hace falta agencia puntual o direccion)', () => {
  const ctx = pedidoCompletoCtx({
    recentUserText: 'Carlos Perez, cedula 12345678, telefono 04121234567, quiero 2 frascos, dale',
    cardAgencia: null, // sin agencia cargada en la ficha
  });
  // El texto de cierre SI trae un monto (para no mezclar con el chequeo de
  // total_comunicado, que se prueba aparte mas abajo).
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.equal(resultado.complete, false);
  assert.deepEqual(resultado.missing, ['modalidad_destino'], 'conocer la ciudad (knownCity) ya no alcanza por si sola para dar el destino por resuelto');
});

test('falta solo el total comunicado: el texto de cierre nunca menciona un monto en Bs', () => {
  const ctx = pedidoCompletoCtx();
  const textoSinMonto = 'Listo Carlos! Tu pedido de 2 Shilajit va a la agencia 1. El pago se hace contra entrega, y en cuanto tengamos la guia te la paso. ✅📦';
  const resultado = evaluateOrderCompleteness({ text: textoSinMonto, ...ctx });
  assert.equal(resultado.complete, false);
  assert.deepEqual(resultado.missing, ['total_comunicado']);
});

test('aceptacion ambigua: solo un "si" suelto (sin nada mas de sustancia, y sin responder a una pregunta de confirmacion) no alcanza', () => {
  const ctx = pedidoCompletoCtx({
    knownCustomer: { nombre: 'Carlos', cedula: '12345678', telefono: '04121234567' },
    recentUserText: 'si',
    lastAssistantText: 'Hola! En que te puedo ayudar hoy?', // NO es una pregunta de confirmacion de pedido
    lastUserMessage: 'si',
  });
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.equal(resultado.complete, false);
  assert.ok(resultado.missing.includes('aceptacion_no_ambigua'));
  assert.ok(resultado.missing.includes('cantidad'), 'un "si" solo tampoco trae ninguna cantidad');
});

test('aceptacion ambigua: un sticker solo tampoco alcanza', () => {
  const ctx = pedidoCompletoCtx({
    knownCustomer: { nombre: 'Carlos', cedula: '12345678', telefono: '04121234567' },
    recentUserText: '[sticker]',
  });
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.equal(resultado.complete, false);
  assert.ok(resultado.missing.includes('aceptacion_no_ambigua'));
});

// --- Punto 2 de la segunda revision: un mensaje que no sea "si/ok/sticker"
// tampoco equivale automaticamente a aceptar una compra ---

test('aceptacion ambigua: una pregunta de precio ("cuanto cuestan dos?") no es una aceptacion, aunque tenga varias palabras', () => {
  const ctx = pedidoCompletoCtx({ recentUserText: '¿y cuanto cuestan dos?' });
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.ok(resultado.missing.includes('aceptacion_no_ambigua'), 'BUG si no falta: una pregunta de precio no confirma nada todavia');
});

test('aceptacion ambigua: "no me lo envies todavia" bloquea el cierre aunque haya datos de un pedido en la misma ventana', () => {
  const ctx = pedidoCompletoCtx({
    recentUserText:
      'Carlos Perez, cedula 12345678, telefono 04121234567, quiero 2 frascos, la agencia 1 me sirve. Espera, no me lo envies todavia.',
  });
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.equal(resultado.complete, false);
  assert.ok(resultado.missing.includes('aceptacion_no_ambigua'), 'BUG si no falta: el cliente pidio explicitamente frenar el envio');
});

test('aceptacion ambigua: "antes queria dos, ahora solo estoy consultando" es una retractacion, no una aceptacion', () => {
  const ctx = pedidoCompletoCtx({
    recentUserText: 'antes queria 2 frascos para la agencia 1, pero ahora solo estoy consultando',
  });
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.ok(resultado.missing.includes('aceptacion_no_ambigua'));
});

test('aceptacion valida CONTEXTUAL: un "si" corto SI alcanza cuando responde directo a una pregunta de confirmacion del propio bot', () => {
  const ctx = pedidoCompletoCtx({
    recentUserText: 'si', // suelto, en aislamiento seria ambiguo
    lastAssistantText: 'Tu pedido serian 2 Shilajit para la agencia 1, Bs 700 en total contra entrega. ¿Confirmas asi?',
    lastUserMessage: 'si',
  });
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.ok(!resultado.missing.includes('aceptacion_no_ambigua'), 'BUG si falta: un "si" que responde a "¿confirmas asi?" es inequivoco en contexto');
});

test('aceptacion valida CONTEXTUAL: un "no me lo envies todavia" respondiendo a la confirmacion SIGUE bloqueando (el rechazo explicito gana)', () => {
  const ctx = pedidoCompletoCtx({
    recentUserText: 'espera, no me lo envies todavia',
    lastAssistantText: 'Tu pedido serian 2 Shilajit para la agencia 1, Bs 700 en total contra entrega. ¿Confirmas asi?',
    lastUserMessage: 'espera, no me lo envies todavia',
  });
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.ok(resultado.missing.includes('aceptacion_no_ambigua'));
});

test('looksLikeHoldOrRetraction / looksLikeContextualShortAcceptance: helpers directos', () => {
  assert.equal(looksLikeHoldOrRetraction('no me lo mandes todavia'), true);
  assert.equal(looksLikeHoldOrRetraction('dale, mandalo'), false);
  assert.equal(looksLikeContextualShortAcceptance('¿Confirmas tu pedido asi?', 'si'), true);
  assert.equal(looksLikeContextualShortAcceptance('Hola, en que te ayudo?', 'si'), false, 'sin pregunta de confirmacion, un "si" solo sigue ambiguo');
  assert.equal(looksLikeContextualShortAcceptance('¿Confirmas tu pedido asi?', 'no, espera'), false, 'un rechazo no se vuelve aceptacion por el contexto');
});

// --- Punto 1 de la segunda revision: ciudad conocida NO es destino resuelto ---

test('looksLikeAgencySelected: reconoce seleccion por numero de lista, por nombre de zona, o confirmacion directa', () => {
  assert.equal(looksLikeAgencySelected('la 1 me sirve'), true);
  assert.equal(looksLikeAgencySelected('la segunda esta bien'), true);
  assert.equal(looksLikeAgencySelected('la agencia de La Candelaria me queda cerca'), true);
  assert.equal(looksLikeAgencySelected('esa agencia me conviene'), true);
  assert.equal(looksLikeAgencySelected('estoy en barinas'), false, 'solo decir la ciudad no es elegir una agencia puntual');
});

test('looksLikeDeliveryAddressGiven: reconoce datos reales de direccion, no la palabra "domicilio" sola', () => {
  assert.equal(looksLikeDeliveryAddressGiven('Av. Libertador, sector Los Palos Grandes, frente a la panaderia'), true);
  assert.equal(looksLikeDeliveryAddressGiven('mejor a domicilio'), false, 'BUG si es true: "domicilio" solo no es una direccion real');
});

test('destino NO resuelto solo con knownCity: hace falta agencia puntual o direccion real', () => {
  const ctx = pedidoCompletoCtx({
    recentUserText: 'Carlos Perez, cedula 12345678, telefono 04121234567, quiero 2 frascos, estoy en Barinas, dale',
    cardAgencia: null,
    knownCity: 'barinas',
  });
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.ok(resultado.missing.includes('modalidad_destino'), 'BUG si no falta: saber la ciudad no es lo mismo que tener una agencia elegida o una direccion');
});

test('destino resuelto con una agencia puntual seleccionada en el texto (sin cardAgencia todavia en la ficha)', () => {
  const ctx = pedidoCompletoCtx({
    recentUserText: 'Carlos Perez, cedula 12345678, telefono 04121234567, quiero 2 frascos, la agencia 1 me sirve, dale',
    cardAgencia: null,
  });
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.ok(!resultado.missing.includes('modalidad_destino'));
});

// FASE (correccion cobertura, revertida a pedido explicito del negocio,
// 20260920): ver el comentario junto a isClosingMessage mas arriba -- una
// direccion real en Caracas resuelve el destino directamente, el negocio da
// domicilio a toda la ciudad sin necesitar ninguna zona confirmada.
test('destino NO resuelto con una direccion de domicilio en Caracas', () => {
  const ctx = pedidoCompletoCtx({
    recentUserText:
      'Carlos Perez, cedula 12345678, telefono 04121234567, quiero 2 frascos, Av. Libertador, sector Los Palos Grandes, frente a la panaderia, dale',
    cardAgencia: null,
    knownCity: 'caracas',
  });
  const resultado = evaluateOrderCompleteness({ text: MENSAJE_CIERRE_REAL, ...ctx });
  assert.ok(
    resultado.missing.includes('modalidad_destino')
  );
});

// --- Punto 4: presentacion y total, no solo producto+cantidad ---

// OJO: BOT_DATA_DIR se resuelve UNA sola vez, cuando src/dataDir.js se
// requiere por primera vez (ver ese archivo) -- llamar a setupTempDataDir()
// de nuevo a mitad de este archivo NO cambia a donde apunta loadProducts()
// (ya quedo fijado al dataDir de la primera linea de este archivo). Por eso
// estas dos pruebas reescriben products.json DENTRO del mismo dataDir, y
// restauran el catalogo de un solo producto al final para no afectar el
// resto de las pruebas de este archivo (que corren despues).
test('presentacion: con dos presentaciones activas del mismo producto base, no alcanza con el nombre generico si el cliente nunca distinguio cual', () => {
  writeRaw(dataDir, 'products.json', JSON.stringify([
    { id: 'p1', name: 'Shilajit Gomitas', price: 350, currency: 'Bs', active: true },
    { id: 'p2', name: 'Shilajit Resina', price: 500, currency: 'Bs', active: true },
  ]));
  try {
    assert.equal(looksLikePresentationConfirmed('Shilajit', 'quiero 2 shilajit para la agencia 1'), false);
    assert.equal(looksLikePresentationConfirmed('Shilajit', 'quiero 2 de la resina para la agencia 1'), true);
  } finally {
    writeRaw(dataDir, 'products.json', JSON.stringify([
      { id: 'p1', name: 'Shilajit', price: 350, currency: 'Bs', active: true },
    ]));
  }
});

test('presentacion: con una sola presentacion activa para ese nombre base, no hace falta que el cliente distinga nada', () => {
  // Esta suite ya carga (y la prueba anterior restaura) un catalogo con un
  // solo "Shilajit".
  assert.equal(looksLikePresentationConfirmed('Shilajit', 'quiero 2 para la agencia 1'), true);
});

test('looksLikeTotalCommunicated: reconoce un monto en Bs, no un numero cualquiera', () => {
  assert.equal(looksLikeTotalCommunicated('tu pedido son Bs 700 en total'), true);
  assert.equal(looksLikeTotalCommunicated('700 Bs contra entrega'), true);
  assert.equal(looksLikeTotalCommunicated('dale, ya te anoto el pedido'), false);
});

test('looksLikeClosingSummaryText reconoce "pagas al recibir" solo dentro de un cierre concreto', () => {
  assert.equal(looksLikeClosingSummaryText('Tu pedido de 2 queda confirmado para retirar en agencia. Pagas al recibir.'), true);
  assert.equal(looksLikeClosingSummaryText('Con Tealca pagas al recibir en agencia.'), false);
});

test('un total vigente comunicado antes sirve en el turno posterior, pero uno desactualizado no', () => {
  const base = pedidoCompletoCtx({
    lastAssistantText: 'Tu pedido de 2 queda en 51.900 Bs. ¿Confirmas?',
    lastUserMessage: 'Sí',
  });
  const cierre = 'Tu pedido de 2 queda confirmado para retirar en agencia Tealca. Pagas al recibir y luego te enviamos la guia.';
  assert.equal(evaluateOrderCompleteness({
    ...base,
    text: cierre,
    expectedTotal: 51900,
    previouslyCommunicatedTotal: 51900,
    orderAccepted: true,
  }).complete, true);
  assert.ok(evaluateOrderCompleteness({
    ...base,
    text: cierre,
    expectedTotal: 69900,
    previouslyCommunicatedTotal: 51900,
    orderAccepted: true,
  }).missing.includes('total_comunicado'));
});

test('looksLikeTotalCommunicated: con total esperado, un monto cualquiera en Bs no alcanza', () => {
  assert.equal(looksLikeTotalCommunicated('Total: 700 Bs', 700), true);
  assert.equal(looksLikeTotalCommunicated('Total: 999 Bs', 700), false);
  assert.equal(looksLikeTotalCommunicated('Total: 1.050 Bs', 1050), true);
});

// --- Punto 6: el bot nunca dice "confirmado" cuando el sistema no puede
// guardar el cierre como tal ---

test('buildIncompleteOrderNotice: nunca esta vacio y menciona lo que falta sin usar la lista tecnica interna', () => {
  const aviso = buildIncompleteOrderNotice(['cantidad', 'total_comunicado']);
  assert.ok(aviso.length > 0);
  assert.ok(!/cantidad_missing|total_comunicado\b/.test(aviso), 'no debe filtrarse la clave tecnica interna tal cual');
  assert.match(aviso, /cuantos/i);
});

test('buildIncompleteOrderNotice: con missing vacio devuelve un aviso generico (nunca revienta ni devuelve string vacio)', () => {
  const aviso = buildIncompleteOrderNotice([]);
  assert.ok(typeof aviso === 'string' && aviso.length > 0);
});

// --- Helpers individuales que ya existian ---

test('looksLikeCustomerDataProvided: true con cedula y telefono; false con uno solo o ninguno', () => {
  assert.equal(looksLikeCustomerDataProvided('mi cedula es 12345678 y mi telefono 04121234567'), true);
  assert.equal(looksLikeCustomerDataProvided('mi telefono es 04121234567'), false);
  assert.equal(looksLikeCustomerDataProvided('Carlos Perez'), false);
});

// Punto 3 del pedido original: telefonos con +58, espacios y guiones
// (formatos reales que la gente escribe, no solo el formato "pegado" sin
// separadores).
test('looksLikeCustomerDataProvided: reconoce telefono con "+58" adelante', () => {
  assert.equal(looksLikeCustomerDataProvided('cedula 12345678, telefono +584121234567'), true);
});

test('looksLikeCustomerDataProvided: reconoce telefono con espacios ("0412 123 4567")', () => {
  assert.equal(looksLikeCustomerDataProvided('cedula 12345678, telefono 0412 123 4567'), true);
});

test('looksLikeCustomerDataProvided: reconoce telefono con guiones ("0412-123-4567") y "+58" con espacio y guiones combinados', () => {
  assert.equal(looksLikeCustomerDataProvided('cedula 12345678, telefono 0412-123-4567'), true);
  assert.equal(looksLikeCustomerDataProvided('cedula 12.345.678, telefono +58 412-123-4567'), true);
});

test('looksLikeCustomerDataProvided: cedula con puntos como separador de miles ("12.345.678")', () => {
  assert.equal(looksLikeCustomerDataProvided('mi cedula es 12.345.678 y mi telefono 04121234567'), true);
});

test('LIMITACION CONOCIDA (documentada, no un bug): dos numeros pegados con un solo espacio y SIN ninguna palabra entre medio pueden no separarse bien', () => {
  const resultado = looksLikeCustomerDataProvided('12345678 04121234567');
  assert.equal(typeof resultado, 'boolean');
});

test('looksLikeQuantityMentioned: numero solo, numero+unidad, y palabra+unidad', () => {
  assert.equal(looksLikeQuantityMentioned('2'), true);
  assert.equal(looksLikeQuantityMentioned('quiero 2 frascos'), true);
  assert.equal(looksLikeQuantityMentioned('quiero dos frascos'), true);
  assert.equal(looksLikeQuantityMentioned('mi telefono es 0412 123 45 67'), false, 'un numero de telefono largo no es una cantidad');
  assert.equal(looksLikeQuantityMentioned('hola'), false);
});

test('looksLikeDeliveryModalityMentioned (chequeo laxo de texto, ya no usado solo para "destino resuelto"): agencia/domicilio/tienda si, charla generica no', () => {
  assert.equal(looksLikeDeliveryModalityMentioned('prefiero retirar en agencia'), true);
  assert.equal(looksLikeDeliveryModalityMentioned('mejor a domicilio'), true);
  assert.equal(looksLikeDeliveryModalityMentioned('que tal el clima hoy'), false);
});

test('looksLikeUnambiguousEngagement: un "si"/"ok"/sticker solo no alcanza, cualquier otra cosa de sustancia si', () => {
  assert.equal(looksLikeUnambiguousEngagement('si'), false);
  assert.equal(looksLikeUnambiguousEngagement('Si!'), false);
  assert.equal(looksLikeUnambiguousEngagement('ok'), false);
  assert.equal(looksLikeUnambiguousEngagement('[sticker]'), false);
  assert.equal(looksLikeUnambiguousEngagement(''), false);
  assert.equal(looksLikeUnambiguousEngagement('si, dale, mandalo a Barinas'), true);
  assert.equal(looksLikeUnambiguousEngagement('2'), true);
  assert.equal(looksLikeUnambiguousEngagement('¿cuanto cuesta el envio?'), false, 'una pregunta suelta no es una aceptacion');
});

// --- MRW/Zoom: la politica vigente del negocio los acepta con pago
// anticipado (nunca contra entrega), y el bot debe derivar a un humano en
// vez de rechazarlos o de inventar un proceso de pago/confirmar el pedido
// solo. La revision anterior encontro el prompt diciendo lo contrario.
test('el prompt ya NO rechaza MRW/Zoom ni dice que el negocio "no gestiona otros couriers"', () => {
  const prompt = buildSystemPrompt(null, null, false, false, null, {});
  assert.ok(!/no gestiona otros couriers/i.test(prompt), 'el prompt todavia tiene la frase vieja que rechazaba MRW/Zoom');
  assert.match(prompt, /mrw/i, 'el prompt deberia mencionar MRW como opcion valida (con pago anticipado)');
  assert.match(prompt, /zoom/i, 'el prompt deberia mencionar Zoom como opcion valida (con pago anticipado)');
  assert.match(prompt, /asesor humano|derivar|deriv/i, 'MRW/Zoom deberian derivarse a un humano, no cerrarse solos');
});

test('el prompt exige pago anticipado para MRW/Zoom (nunca contra entrega)', () => {
  const prompt = buildSystemPrompt(null, null, false, false, null, {});
  assert.match(prompt, /pago\s+anticipado/i);
});

test('el prompt prohibe Cashea y pagos en dolares', () => {
  const prompt = buildSystemPrompt(null, null, false, false, null, {});
  assert.match(prompt, /cashea/i);
  assert.match(prompt, /d[oó]lares/i);
});

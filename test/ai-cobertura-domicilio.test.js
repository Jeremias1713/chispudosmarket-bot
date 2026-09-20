// Pruebas de la validacion OPERATIVA de cobertura de domicilio (correccion
// prioritaria: "DELIVERY FUERA DE COBERTURA"). Politica confirmada por el
// negocio (20260920, explicita: "ofrecemos delivery a TODA CARACAS"):
//   - Domicilio DISPONIBLE en toda Caracas (Distrito Capital), sin
//     excepcion de zona/parroquia.
//   - Fuera de Caracas: retiro en agencia Tealca (o, en Maracaibo, tienda
//     propia -- eso NO es delivery).
//   - MRW/Zoom: pago anticipado + coordinacion humana, NUNCA implica
//     autorizacion de domicilio.
//   - Si la ciudad no se conoce/es ambigua, nunca se asume cobertura.
//
// NOTA HISTORICA: hubo una version intermedia que exigia una lista de
// zonas puntuales de Caracas confirmadas una por una (dejando cualquier
// zona sin listar "pendiente de un humano"). El negocio la revirtio
// explicitamente por no reflejar como opera de verdad: da domicilio a
// TODA Caracas, no zona por zona. Estas pruebas verifican la version
// vigente (toda Caracas = domicilio autorizado).
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('ai-cobertura-domicilio');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveDeliveryCoverage,
  looksLikeOffersDomicilio,
  guardAgainstUnauthorizedDelivery,
  evaluateOrderCompleteness,
} = require('../src/ai');

after(() => cleanup(dataDir));

// --- resolveDeliveryCoverage: la fuente de verdad deterministica ---

test('resolveDeliveryCoverage: Caracas tampoco autoriza domicilio', () => {
  const r = resolveDeliveryCoverage('caracas', '');
  assert.equal(r.cityKnown, true);
  assert.equal(r.domicilioAllowed, false);
});

test('resolveDeliveryCoverage: una direccion puntual en Caracas tampoco autoriza domicilio', () => {
  const r = resolveDeliveryCoverage('caracas', 'vivo en Catia, cerca del metro');
  assert.equal(r.cityKnown, true);
  assert.equal(r.domicilioAllowed, false);
});

test('resolveDeliveryCoverage: Carupano, Valencia, Barquisimeto y Maracaibo NUNCA tienen domicilio (regla definitiva)', () => {
  for (const ciudad of ['carupano', 'valencia', 'barquisimeto', 'maracaibo']) {
    const r = resolveDeliveryCoverage(ciudad, '');
    assert.equal(r.cityKnown, true, `${ciudad} tiene que reconocerse como ciudad conocida`);
    assert.equal(r.domicilioAllowed, false, `BUG si esto es true: ${ciudad} no tiene cobertura real de domicilio`);
  }
});

test('resolveDeliveryCoverage: una ciudad desconocida/ambigua NUNCA autoriza domicilio (nunca se asume cobertura por defecto)', () => {
  const r = resolveDeliveryCoverage(null, 'quedamos en un pueblito cerca de la playa');
  assert.equal(r.cityKnown, false);
  assert.equal(r.domicilioAllowed, false);
});

test('resolveDeliveryCoverage: si knownCity todavia no esta cargada, tambien busca la ciudad en el texto suelto del cliente', () => {
  const r = resolveDeliveryCoverage(null, 'te escribo desde Maracaibo');
  assert.equal(r.cityKnown, true);
  assert.equal(r.domicilioAllowed, false);
});

test('resolveDeliveryCoverage: una ciudad mencionada AHORA en el texto tiene prioridad sobre la ciudad vieja guardada en la ficha (la ficha recien se actualiza cuando el clasificador corre, DESPUES de esta respuesta)', () => {
  // Simula el caso real: knownCity todavia dice "caracas" (no se actualizo
  // todavia), pero el cliente ACABA de avisar, en el mensaje que se esta
  // evaluando ahora mismo, que en realidad esta en otra ciudad.
  const r = resolveDeliveryCoverage('caracas', 'ahora estoy en Valencia');
  assert.equal(r.cityKnown, true);
  assert.equal(
    r.domicilioAllowed,
    false,
    'BUG si esto es true: se uso la ciudad VIEJA de la ficha (Caracas) en vez de la que el cliente acaba de decir en este mismo mensaje'
  );
});

test('resolveDeliveryCoverage: cambiar a Caracas sigue sin autorizar domicilio', () => {
  const r = resolveDeliveryCoverage('valencia', 'ahora estoy en Caracas');
  assert.equal(r.cityKnown, true);
  assert.equal(
    r.domicilioAllowed,
    false
  );
});

// --- looksLikeOffersDomicilio: deteccion de una oferta/confirmacion real ---

test('looksLikeOffersDomicilio: reconoce una oferta real de domicilio', () => {
  assert.equal(looksLikeOffersDomicilio('Te lo llevamos hasta la puerta de tu casa'), true);
  assert.equal(looksLikeOffersDomicilio('Claro, hacemos entrega a domicilio sin problema'), true);
});

test('looksLikeOffersDomicilio: una NEGACION/derivacion correcta de domicilio no cuenta como oferta (no hay nada que corregir)', () => {
  assert.equal(looksLikeOffersDomicilio('Por ahora no hay entrega a domicilio, solo se retira en agencia'), false);
  assert.equal(looksLikeOffersDomicilio('Para tu zona solo se retira en agencia Tealca'), false);
});

test('looksLikeOffersDomicilio: mencionar MRW o Zoom (pago anticipado + coordinacion humana) NO implica, por si solo, una promesa de domicilio', () => {
  assert.equal(
    looksLikeOffersDomicilio('Para tu zona podemos coordinar por MRW o Zoom: pago anticipado y coordinamos el envio con un asesor.'),
    false,
    'BUG si esto es true: mencionar MRW/Zoom no es lo mismo que prometer domicilio ni pago contra entrega'
  );
});

test('looksLikeOffersDomicilio: "envio gratis"/"pagas al recibir" del mensaje de bienvenida no se confunden con una promesa de domicilio', () => {
  assert.equal(
    looksLikeOffersDomicilio('ENVIO GRATIS A TODA VENEZUELA y PAGAS AL RECIBIR. ¿Cual combo prefieres?'),
    false,
    'BUG si esto es true: esa frase generica de marketing inicial no menciona domicilio/puerta a puerta, no puede activar la correccion de cobertura'
  );
});

// --- guardAgainstUnauthorizedDelivery: la correccion antes de mandar ---

test('guardAgainstUnauthorizedDelivery: una oferta de domicilio para una ciudad SIN cobertura (fuera de Caracas) se reemplaza por la opcion real (agencia Tealca)', () => {
  const original = 'Perfecto, te lo llevamos hasta la puerta de tu casa en Carupano, sin problema.';
  const corregido = guardAgainstUnauthorizedDelivery(original, 'carupano', 'vivo en carupano');
  assert.notEqual(corregido, original, 'BUG si no cambio: se dejo pasar una promesa de domicilio fuera de cobertura');
  assert.match(corregido, /agencia tealca/i);
  assert.equal(
    looksLikeOffersDomicilio(corregido),
    false,
    'BUG si esto es true: la correccion en si misma no puede volver a leerse como una oferta/promesa de domicilio'
  );
});

test('guardAgainstUnauthorizedDelivery: una oferta de domicilio con la ciudad TODAVIA sin confirmar se reemplaza por una pregunta, nunca se asume cobertura', () => {
  const original = 'Dale, te lo enviamos a tu direccion sin problema.';
  const corregido = guardAgainstUnauthorizedDelivery(original, null, 'quiero que me lo envien a mi casa');
  assert.notEqual(corregido, original);
  assert.match(corregido, /ciudad/i, 'tiene que pedir la ciudad/zona antes de prometer cualquier modalidad');
});

test('guardAgainstUnauthorizedDelivery: una oferta de domicilio en Caracas tambien se corrige', () => {
  const original = 'Perfecto, te lo llevamos hasta la puerta de tu casa en Caracas.';
  const corregido = guardAgainstUnauthorizedDelivery(original, 'caracas', 'vivo en caracas, en la av. libertador');
  assert.notEqual(corregido, original);
  assert.match(corregido, /retiro en agencia tealca/i);
});

test('guardAgainstUnauthorizedDelivery: es idempotente -- su propio mensaje de correccion, si se le vuelve a pasar, NO se vuelve a marcar como una oferta pendiente de corregir', () => {
  const corregido1 = guardAgainstUnauthorizedDelivery(
    'Perfecto, te lo llevamos hasta la puerta de tu casa en Carupano.',
    'carupano',
    'vivo en carupano'
  );
  const corregido2 = guardAgainstUnauthorizedDelivery(corregido1, 'carupano', 'vivo en carupano');
  assert.equal(corregido2, corregido1);
});

test('guardAgainstUnauthorizedDelivery: un texto que ya NIEGA domicilio correctamente (deriva a agencia) no se toca', () => {
  const original = 'Por ahora no hay entrega a domicilio en tu zona, solo se retira en agencia Tealca. ¿Te busco la mas cercana?';
  const corregido = guardAgainstUnauthorizedDelivery(original, 'valencia', 'vivo en valencia');
  assert.equal(corregido, original);
});

test('guardAgainstUnauthorizedDelivery: mencionar MRW/Zoom (coordinacion humana) no se corrige como si fuera una promesa de domicilio', () => {
  const original = 'Para tu zona podemos coordinar por MRW: pago anticipado y coordinamos el envio con un asesor.';
  const corregido = guardAgainstUnauthorizedDelivery(original, 'barquisimeto', 'vivo en barquisimeto');
  assert.equal(corregido, original, 'BUG si cambio: esto no prometia domicilio/pago contra entrega, no hay nada que corregir');
});

// --- evaluateOrderCompleteness: el cierre tambien valida cobertura ---

test('evaluateOrderCompleteness: una direccion COMPLETA en una ciudad SIN cobertura real (fuera de Caracas) NUNCA alcanza para aprobar un cierre por domicilio', () => {
  const result = evaluateOrderCompleteness({
    text: 'Tu pedido de 2 Shilajit (Bs 700) va para tu direccion en la Av. Bolivar, cerca de la plaza, Valencia. El pago es contra entrega.',
    knownCustomer: { nombre: 'Ana Diaz', cedula: '20123456', telefono: '04121234567' },
    recentUserText: 'Ana Diaz, cedula 20123456, telefono 04121234567, quiero 2 frascos, es en la Av. Bolivar, cerca de la plaza, en Valencia, mandalo a mi casa',
    knownProduct: 'Shilajit',
    knownCity: 'valencia',
    cardAgencia: null,
  });
  assert.ok(
    result.missing.includes('modalidad_destino'),
    `BUG si "modalidad_destino" no aparece: una direccion completa fuera de Caracas no puede dar el destino por resuelto (missing=${JSON.stringify(result.missing)})`
  );
});

test('evaluateOrderCompleteness: una direccion en Caracas no sustituye una agencia', () => {
  const result = evaluateOrderCompleteness({
    text: 'Tu pedido de 2 Shilajit (Bs 700) va para tu direccion en la Av. Bolivar, cerca de la plaza, Caracas. El pago es contra entrega.',
    knownCustomer: { nombre: 'Ana Diaz', cedula: '20123456', telefono: '04121234567' },
    recentUserText: 'Ana Diaz, cedula 20123456, telefono 04121234567, quiero 2 frascos, es en la Av. Bolivar, cerca de la plaza, en Caracas, mandalo a mi casa',
    knownProduct: 'Shilajit',
    knownCity: 'caracas',
    cardAgencia: null,
  });
  assert.ok(
    result.missing.includes('modalidad_destino'),
    `missing=${JSON.stringify(result.missing)}`
  );
});

test('evaluateOrderCompleteness: una ubicacion desconocida/ambigua nunca resuelve el destino por si sola (nunca se asume cobertura)', () => {
  const result = evaluateOrderCompleteness({
    text: 'Tu pedido de 2 Shilajit (Bs 700) va para tu direccion. El pago es contra entrega.',
    knownCustomer: { nombre: 'Ana Diaz', cedula: '20123456', telefono: '04121234567' },
    recentUserText: 'Ana Diaz, cedula 20123456, telefono 04121234567, quiero 2 frascos, mandalo a mi casa',
    knownProduct: 'Shilajit',
    knownCity: null,
    cardAgencia: null,
  });
  assert.ok(result.missing.includes('modalidad_destino'), `missing=${JSON.stringify(result.missing)}`);
});

// --- Cambio de ciudad: nunca se reutiliza una autorizacion de domicilio vieja ---

test('evaluateOrderCompleteness: si el cliente HABIA dado una direccion en Caracas pero la ciudad vigente (knownCity, ya corregida) es OTRA, no se reutiliza la autorizacion vieja de domicilio', () => {
  // recentUserText incluye la direccion vieja (dada cuando el cliente decia
  // estar en Caracas), pero knownCity YA es la ciudad corregida/actualizada
  // (el cliente aviso que en realidad esta en otra ciudad). El destino
  // tiene que volver a resolverse con la ciudad VIGENTE, nunca con la
  // autorizacion que se dio bajo el supuesto (ya superado) de que estaba en
  // Caracas.
  const result = evaluateOrderCompleteness({
    text: 'Tu pedido de 2 Shilajit (Bs 700) va para tu direccion. El pago es contra entrega.',
    knownCustomer: { nombre: 'Ana Diaz', cedula: '20123456', telefono: '04121234567' },
    recentUserText:
      'Ana Diaz, cedula 20123456, telefono 04121234567, quiero 2 frascos, es en la Av. Bolivar, cerca de la plaza, mandalo a mi casa. ' +
      'Ah espera, en realidad no estoy en Caracas, estoy en Valencia',
    knownProduct: 'Shilajit',
    knownCity: 'valencia', // la ficha ya se actualizo con la ciudad real/vigente
    cardAgencia: null,
  });
  assert.ok(
    result.missing.includes('modalidad_destino'),
    `BUG si "modalidad_destino" no aparece: se reutilizo una direccion/autorizacion de domicilio que en realidad correspondia a una ciudad de Caracas ya descartada (missing=${JSON.stringify(result.missing)})`
  );
});

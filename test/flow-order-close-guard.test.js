// Prueba de integracion de flow.js: verifica, de punta a punta (via
// flow.handleIncomingMessage), que un mensaje con forma de "cierre"
// (menciona tealca/pago/guia) NO marca la conversacion como orderClosed/
// vendido salvo que haya evidencia real de un pedido armado en la
// conversacion (identidad, producto, cantidad, modalidad/destino,
// aceptacion no ambigua -- ver evaluateOrderCompleteness en src/ai.js), y
// cubre especificamente el caso de un CLIENTE ANTIGUO con datos guardados
// de una compra anterior que solo pregunta por cobertura.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const fs = require('fs');
const path = require('path');
const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('flow-order-close-guard');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const whatsapp = require('../src/whatsapp');
const ai = require('../src/ai');
const classifierMod = require('../src/classifier');
const { updateSettings } = require('../src/settings');
const { getSession } = require('../src/state');

updateSettings({ replyDelayMs: 5 });

const textosEnviados = [];
whatsapp.sendText = async (to, text) => {
  textosEnviados.push({ to, text });
  return { messages: [{ id: 'wamid.TEST' }] };
};
whatsapp.sendImageByLink = async () => ({});
whatsapp.sendAudioByLink = async () => ({});
whatsapp.downloadMedia = async () => { throw new Error('no deberia llamarse en estos tests'); };

classifierMod.classifyConversation = async () => null; // no hace falta reclasificar para estos casos

let replyToReturn = { text: '', images: [] };
ai.getAssistantReply = async () => replyToReturn;

const flow = require('../src/flow');
const push = require('../src/push');
let ventasNotificadas = 0;
push.notifySale = () => { ventasNotificadas++; };

after(() => cleanup(dataDir));

function esperarProcesamiento(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 150));
}

function sesionBase(overrides) {
  return {
    step: 'IDLE', cart: [], history: [{ role: 'user', content: 'hola', at: '2026-08-01T00:00:00.000Z' }],
    name: 'Cliente', stage: 'interesado', stageLocked: false, stageReason: null,
    paused: false, pausedReason: null,
    card: {},
    adCode: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

// Lee sessions.json directo del disco (sin pasar por getSession/el modulo
// state.js ya cargado en memoria en este proceso) para demostrar que el
// cierre/los campos realmente QUEDARON ESCRITOS en el archivo, no solo en
// una variable en memoria -- lo mas cercano a probar persistencia real de
// estados sin reiniciar el proceso de Node de verdad.
function leerSessionsDesdeDisco() {
  const raw = fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8');
  return JSON.parse(raw);
}

test('false-close: consulta de pura cobertura, sin ningun dato de pedido, NO cierra, Y el cliente recibe la respuesta REAL a su pregunta (no el aviso generico de datos incompletos)', async () => {
  const phone = '584120000901';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionBase() }));
  textosEnviados.length = 0;

  replyToReturn = {
    text: 'Con Tealca el pago se hace contra entrega, y en cuanto tengamos la guia de tu pedido te aviso.',
    images: [],
  };

  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'como es el pago con tealca?' } }, 'Cliente');
  await esperarProcesamiento();

  const session = getSession(phone);
  assert.notEqual(session.orderClosed, true, 'BUG si esto es true: una consulta de cobertura/pago no puede cerrar un pedido sin datos del cliente');
  assert.notEqual(session.stage, 'vendido', 'BUG si esto paso a vendido: no hay pedido real que cerrar');

  // FASE (correccion regresion cierre secuencial, punto 6, tercera parte):
  // bug real reproducido con este mismo texto exacto -- por mencionar "tu
  // pedido" a secas (sin ningun dato puntual), la respuesta CORRECTA a la
  // pregunta del cliente se descartaba entera y se reemplazaba por el aviso
  // generico de "me falta confirmar tu nombre, cedula...", dejando la
  // pregunta real sin contestar.
  const enviado = textosEnviados.find((m) => m.to === phone);
  assert.ok(enviado, 'tiene que haberse mandado algun mensaje');
  assert.equal(
    enviado.text,
    replyToReturn.text,
    'BUG si esto no coincide: la respuesta real a la consulta de pago/cobertura se sustituyo por otra cosa (el aviso generico de datos incompletos), en vez de contestarle de verdad al cliente'
  );
});

// --- El caso central pedido explicitamente: cliente antiguo ---
test('CLIENTE ANTIGUO: con nombre/cedula/telefono ya guardados de una compra anterior, una consulta de cobertura NO reabre/cierra un pedido nuevo', async () => {
  const phone = '584120000903';
  // Simula el estado real de un cliente que ya compro antes: sus datos
  // personales quedaron en la ficha para siempre (igual que hace
  // buildGuiaPatch en orderGuard.js cuando el operador confirma un pedido
  // NUEVO de un cliente repetido: reinicia orderClosed a false pero
  // CONSERVA nombre/cedula/telefono). No hay producto ni cantidad de
  // ESTE pedido nuevo -- la conversacion recien esta empezando.
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({
      card: { nombre: 'Maria Lopez', cedula: '87654321', telefono: '04241234567' },
      orderClosed: false,
      stage: 'nuevo',
    }),
  }));

  replyToReturn = {
    text: 'Si, a Barinas tambien llegamos! El pago se hace contra entrega y en cuanto tengamos la guia te aviso.',
    images: [],
  };

  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'hola, tambien hacen envios a barinas?' } }, 'Maria');
  await esperarProcesamiento();

  const session = getSession(phone);
  assert.notEqual(session.orderClosed, true, 'BUG si esto es true: los datos de una compra VIEJA no prueban que haya un pedido nuevo armado');
  assert.notEqual(session.stage, 'vendido');
});

test('CLIENTE ANTIGUO que SI arma un pedido nuevo de verdad (cantidad+agencia puntual+total+aceptacion en esta conversacion): ahi si cierra, sin repetirle sus datos', async () => {
  const phone = '584120000904';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({
      card: { nombre: 'Maria Lopez', cedula: '87654321', telefono: '04241234567', producto: 'Shilajit' },
      orderClosed: false,
      stage: 'nuevo',
    }),
  }));

  // El propio mensaje de cierre tiene que incluir el TOTAL (ver
  // looksLikeTotalCommunicated en ai.js, punto 4 de la segunda revision): el
  // prompt actual no cotiza un total antes del cierre, asi que el chequeo se
  // hace sobre este mismo texto final, no sobre turnos anteriores.
  replyToReturn = {
    text: 'Listo Maria! Tu pedido de 2 Shilajit (Bs 700) va a la agencia Tealca de Barinas. El pago se hace contra entrega, y en cuanto tengamos la guia te aviso. ✅',
    images: [],
  };

  await flow.handleIncomingMessage(
    phone,
    { type: 'text', text: { body: 'dale, quiero pedir 2 frascos de nuevo para Barinas, la agencia 1 me sirve' } },
    'Maria'
  );
  await esperarProcesamiento();

  const session = getSession(phone);
  assert.equal(session.orderClosed, true, 'un pedido nuevo real (con cantidad, destino, total y aceptacion) si tiene que poder cerrar, aunque los datos personales sean viejos');
  assert.equal(session.stage, 'vendido');
});

test('cierre real, primer pedido: identidad+cantidad+destino+total+aceptacion todo en el mismo turno (formato de telefono con guiones y +58)', async () => {
  const phone = '584120000902';
  // La ciudad ya se resolvio en un turno anterior (queda en card.ciudad,
  // igual que en produccion real): solo falta la identidad, la cantidad y la
  // agencia puntual en este ultimo mensaje. El total va en el propio mensaje
  // de cierre (ver comentario en el test anterior).
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ card: { producto: 'Shilajit', ciudad: 'barinas' } }),
  }));

  replyToReturn = {
    text: 'Listo! Tu pedido de 2 Shilajit (Bs 700) va a la agencia Tealca. El pago se hace contra entrega, y en cuanto tengamos la guia te aviso. ✅',
    images: [],
  };

  await flow.handleIncomingMessage(
    phone,
    { type: 'text', text: { body: 'dale, quiero 2, la agencia 1 me sirve. Carlos Perez, cedula 12.345.678, telefono +58 412-123-4567' } },
    'Cliente'
  );
  await esperarProcesamiento();

  const session = getSession(phone);
  assert.equal(session.orderClosed, true, 'BUG si esto es false: el telefono con +58/guiones/puntos tiene que reconocerse igual que el formato simple');
  assert.equal(session.stage, 'vendido');
  assert.ok(session.soldAt, 'soldAt debe quedar guardado en un cierre real');

  // Persistencia real: releer sessions.json DIRECTO DEL DISCO (no la copia
  // en memoria que devuelve getSession en este mismo proceso) confirma que
  // el cierre de verdad se escribio, no que solo "parece" cerrado en runtime.
  const desdeDisco = leerSessionsDesdeDisco();
  assert.equal(desdeDisco[phone].orderClosed, true);
  assert.equal(desdeDisco[phone].stage, 'vendido');
  assert.ok(desdeDisco[phone].soldAt);
});

test('sticker solo (sin nada mas de sustancia) NO alcanza para cerrar, aunque el resto ya este casi completo', async () => {
  const phone = '584120000905';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ card: { producto: 'Shilajit', ciudad: 'barinas', nombre: 'Carlos', cedula: '12345678', telefono: '04121234567' } }),
  }));

  replyToReturn = {
    text: 'Listo! Tu pedido va a la agencia Tealca. El pago se hace contra entrega, y en cuanto tengamos la guia te aviso. ✅',
    images: [],
  };

  await flow.handleIncomingMessage(phone, { type: 'sticker' }, 'Cliente');
  await esperarProcesamiento();

  const session = getSession(phone);
  assert.notEqual(session.orderClosed, true, 'BUG si esto es true: un sticker solo no es una aceptacion inequivoca ni trae una cantidad nueva');
});

test('delivery a domicilio en Caracas no cierra aunque tenga una direccion real', async () => {
  const phone = '584120000906';
  // REVERTIDO a pedido explicito del negocio (20260920): hubo una version
  // intermedia que exigia una lista de zonas puntuales de Caracas
  // confirmadas una por una. El negocio confirmo explicitamente que da
  // domicilio a TODA Caracas, sin excepcion de zona -- no hace falta
  // ninguna lista (ver resolveDeliveryCoverage en ai.js).
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ card: { producto: 'Shilajit', ciudad: 'caracas' } }),
  }));

  // Punto 3 de la segunda revision: un cierre de domicilio real NUNCA tiene
  // por que mencionar "Tealca", "agencia" ni "guia" (el mensajero no pasa
  // por una agencia). Este texto de prueba lo verifica a proposito.
  replyToReturn = {
    text: 'Listo! Te llevamos 3 Shilajit (Bs 1050) a tu direccion. El pago es contra entrega, en efectivo o pago movil. En cuanto el mensajero este en camino te aviso. ✅',
    images: [],
  };
  assert.ok(!/tealca|agencia|guia/i.test(replyToReturn.text), 'el texto de prueba en si no debe usar ninguna de esas 3 palabras');

  await flow.handleIncomingMessage(
    phone,
    { type: 'text', text: { body: 'dale, quiero 3 a domicilio. Carlos Perez, cedula 12345678, telefono 04121234567, Av Libertador casa 5, cerca de la plaza' } },
    'Cliente'
  );
  await esperarProcesamiento();

  const session = getSession(phone);
  assert.notEqual(session.orderClosed, true, 'ninguna ciudad permite cerrar un pedido nuevo a domicilio');
  assert.notEqual(session.stage, 'vendido');
});

test('delivery a domicilio: decir SOLO la palabra "domicilio" (sin una direccion real) NO alcanza para dar el destino por resuelto', async () => {
  const phone = '584120000908';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ card: { producto: 'Shilajit' } }),
  }));

  replyToReturn = {
    text: 'Listo! Te llevamos 3 Shilajit (Bs 1050) a domicilio. El pago es contra entrega. En cuanto el mensajero este en camino te aviso. ✅',
    images: [],
  };

  await flow.handleIncomingMessage(
    phone,
    { type: 'text', text: { body: 'dale, quiero 3 a domicilio. Carlos Perez, cedula 12345678, telefono 04121234567' } },
    'Cliente'
  );
  await esperarProcesamiento();

  const session = getSession(phone);
  assert.notEqual(
    session.orderClosed,
    true,
    'BUG si esto es true: la palabra "domicilio" sola, sin ninguna direccion real, no prueba que el destino este resuelto'
  );
});

test('modificar la cantidad de un pedido YA CERRADO no dispara un segundo aviso de venta ni pisa soldAt', async () => {
  const phone = '584120000907';
  const soldAtOriginal = '2026-08-01T05:00:00.000Z';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({
      card: { producto: 'Shilajit', ciudad: 'barinas', nombre: 'Carlos', cedula: '12345678', telefono: '04121234567' },
      stage: 'vendido',
      orderClosed: true,
      soldAt: soldAtOriginal,
    }),
  }));
  ventasNotificadas = 0;

  replyToReturn = {
    text: 'Listo, ya te actualice el pedido a 3 unidades, cualquier cosa me avisas!',
    images: [],
  };

  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'mejor cambiame a 3 frascos' } }, 'Cliente');
  await esperarProcesamiento();

  const session = getSession(phone);
  assert.equal(session.soldAt, soldAtOriginal, 'soldAt no se pisa: sigue siendo la fecha del cierre original, no la de la modificacion');
  assert.equal(ventasNotificadas, 0, 'no se manda un segundo aviso de "venta nueva" por modificar la cantidad de un pedido ya cerrado');
  assert.equal(session.stage, 'vendido', 'la etapa sigue siendo la de venta cerrada, no se reabre a un estado anterior');
});

// --- Punto 6 de la segunda revision: el bot nunca le dice "confirmado" al
// cliente cuando el sistema no puede guardar ese pedido como cerrado ---
test('el modelo redacta un resumen que SUENA a cierre (pago + resumen de pedido) pero en realidad falta un dato real: NUNCA se le manda ese texto al cliente, y el pedido NO queda cerrado', async () => {
  const phone = '584120000909';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({
      // Sin ningun turno anterior que haya comunicado un total: el modelo
      // (mockeado aca) redacta un resumen de cierre convencido de que ya
      // tiene todo, pero en la practica nunca se le dijo un monto al
      // cliente. Ver looksLikeTotalCommunicated en ai.js.
      card: { producto: 'Shilajit' },
    }),
  }));
  textosEnviados.length = 0;

  replyToReturn = {
    text: 'Listo Carlos! Tu pedido de 2 Shilajit va a la agencia Tealca. El pago se hace contra entrega, y en cuanto tengamos la guia te aviso. ✅',
    images: [],
  };

  await flow.handleIncomingMessage(
    phone,
    { type: 'text', text: { body: 'dale, quiero 2, la agencia 1 me sirve. Carlos Perez, cedula 12345678, telefono 04121234567' } },
    'Cliente'
  );
  await esperarProcesamiento();

  const session = getSession(phone);
  assert.notEqual(session.orderClosed, true, 'BUG si esto es true: nunca se le comunico un total al cliente, el pedido no puede quedar cerrado');
  assert.notEqual(session.stage, 'vendido');

  const enviado = textosEnviados.find((e) => e.to === phone);
  assert.ok(enviado, 'tiene que haberse mandado algun mensaje');
  assert.ok(
    !/pedido de \d+.*agencia tealca|contra entrega.*guia te aviso/i.test(enviado.text),
    'BUG si el texto de cierre original (con "pago contra entrega"/resumen) llego tal cual al cliente: el sistema no puede decir "confirmado" mientras no guarda el pedido como cerrado'
  );
  assert.match(enviado.text, /falta/i, 'el cliente tiene que recibir un aviso honesto de que todavia falta confirmar algo, no el resumen de cierre original');
});

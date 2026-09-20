// Pruebas de integracion de flow.js para la SEGUNDA ronda de correccion de
// cobertura de domicilio, pedida explicitamente antes de dar el trabajo por
// terminado:
//   1. La ciudad mencionada en el mensaje ACTUAL del cliente tiene efecto
//      INMEDIATO sobre la modalidad de entrega, aunque el clasificador
//      todavia no haya puesto al dia la ficha (session.card.ciudad).
//   2. Una agencia confirmada en la conversacion sigue confirmada durante
//      los turnos siguientes (pedir datos, recibir datos, preguntar plazo),
//      sin volver a pedirse.
//   3. La proteccion de cobertura cubre TODOS los caminos de envio, no solo
//      las respuestas de la IA: el mensaje inicial de producto (texto fijo
//      del negocio) y la plantilla de pedido de datos (configurable desde
//      el panel).
// Todo esto es SIMULADO (mocks locales, sin red ni WhatsApp real).
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';
// flow.js arma el intervalo entre envios fragmentados/de seguimiento
// (randomGap, usado por ej. antes de mandar el pedido de datos real cuando
// el bot "promete" un formulario) con SPLIT_GAP_MIN_MS/SPLIT_GAP_MAX_MS,
// que se leen de estas variables de entorno AL CARGAR el modulo (no de
// settings.js) -- por defecto son 6000-9500ms, pensados para simular ritmo
// humano en produccion. Si no se bajan ACA, antes de requerir flow.js, cada
// prueba que dispare ese seguimiento (ver test de la plantilla de pedido de
// datos mas abajo) queda esperando hasta 9.5s de verdad, y si esa espera
// termina despues de que el archivo de pruebas ya limpio su carpeta
// temporal (after() de mas abajo), el envio tardio explota con ENOENT al
// intentar guardar en un directorio que ya no existe.
process.env.SPLIT_GAP_MIN_MS = '5';
process.env.SPLIT_GAP_MAX_MS = '8';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('flow-cobertura-domicilio');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

writeRaw(dataDir, 'products.json', JSON.stringify([
  { id: 'p1', name: 'Shilajit', price: 350, currency: 'Bs', active: true },
]));
// La correccion de cobertura ofrece buscar la agencia real ("¿te busco la
// que te quede mejor?"), lo que dispara el seguimiento automatico real de
// looksLikePendingAgencyPromise (ver flow.js) -- ese camino lee
// agencies.csv, asi que hace falta el archivo (vacio alcanza) para que ese
// seguimiento no explote con ENOENT en este entorno de pruebas.
writeRaw(dataDir, 'agencies.csv', 'name,country,region,address,phone,lat,lon\n');

const whatsapp = require('../src/whatsapp');
const ai = require('../src/ai');
const classifierMod = require('../src/classifier');
const { updateSettings } = require('../src/settings');
const { getSession } = require('../src/state');

updateSettings({ replyDelayMs: 5, splitGapMinMs: 5, splitGapMaxMs: 8 });

const textosEnviados = [];
whatsapp.sendText = async (to, text) => {
  textosEnviados.push({ to, text });
  return { messages: [{ id: 'wamid.TEST' }] };
};
whatsapp.sendImageByLink = async () => ({});
whatsapp.sendAudioByLink = async () => ({});
whatsapp.downloadMedia = async () => { throw new Error('no deberia llamarse en estos tests'); };

let impl = async () => ({ text: '', images: [] });
ai.getAssistantReply = (...args) => impl(...args);
let classifierImpl = async () => null;
classifierMod.classifyConversation = (...args) => classifierImpl(...args);

const flow = require('../src/flow');
const push = require('../src/push');
push.notifySale = () => {};

after(() => cleanup(dataDir));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sesionBase(overrides) {
  return {
    step: 'IDLE', cart: [], history: [],
    name: 'Cliente', stage: 'interesado', stageLocked: false, stageReason: null,
    paused: false, pausedReason: null,
    card: {},
    adCode: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function textosDe(phone) {
  return textosEnviados.filter((m) => m.to === phone).map((m) => m.text);
}

// --- Item 2: cambio de ciudad con efecto INMEDIATO, sin esperar al clasificador ---

test('ficha guardada en Caracas + cliente dice "ahora estoy en Valencia": la respuesta de ESTE turno ya usa la ciudad nueva, sin esperar a que el clasificador actualice la ficha', async () => {
  const phone = '584120002001';
  // La ficha todavia dice "caracas" (el clasificador de un turno anterior
  // asi la dejo) -- session.card.ciudad NO se actualiza en este test, a
  // proposito, para simular exactamente que el clasificador "todavia no
  // corrio" sobre el mensaje de este turno.
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ card: { producto: 'Shilajit', ciudad: 'caracas' } }),
  }));

  // El mock de getAssistantReply hace lo mismo que hace ai.js de verdad
  // internamente: pasa la respuesta del "modelo" (que ofrece domicilio sin
  // condicionar nada) por guardAgainstUnauthorizedDelivery, con el knownCity
  // (de la ficha, todavia "caracas") y el userText REAL de este turno (donde
  // el cliente ya avisa que esta en otra ciudad).
  impl = async (history, userText, knownCity) => ({
    text: ai.guardAgainstUnauthorizedDelivery('Dale, te lo llevamos a tu direccion sin problema.', knownCity, userText),
    images: [],
  });

  textosEnviados.length = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'ahora estoy en Valencia, ya no en Caracas' } }, 'Cliente');
  await sleep(150);

  const textos = textosDe(phone);
  // El texto corregido es un solo mensaje logico, pero sendReply/sendSplit
  // puede partirlo en varios envios de WhatsApp (fragmentacion por frases) --
  // eso es justamente parte de lo que el punto 4 del pedido pide verificar
  // (que la proteccion de cobertura tambien cubra respuestas fragmentadas),
  // asi que se valida sobre la union de TODOS los fragmentos enviados a este
  // telefono, no solo sobre el primero.
  const textoCompleto = textos.join(' ');
  assert.doesNotMatch(
    textoCompleto,
    /te lo llevamos a tu direccion sin problema/i,
    'BUG si esto coincide: se dejo pasar la oferta de domicilio usando la ciudad VIEJA de la ficha (Caracas), en vez de la que el cliente acaba de decir'
  );
  assert.match(textoCompleto, /agencia tealca/i, 'Valencia es una negacion definitiva -- tiene que derivar a agencia, no quedar pendiente ni prometer domicilio');
  // OJO: el texto de negacion definitiva SI puede mencionar "Caracas" (es
  // politica general: "la entrega a domicilio solo esta disponible en
  // Caracas") -- eso no es un bug. Lo que si seria un bug es que la
  // respuesta trate a Valencia como si fuera una zona de Caracas pendiente
  // de confirmar (en vez de una negacion definitiva por estar fuera de
  // Caracas), asi que se verifica que NO aparezca la frase de "pendiente de
  // confirmacion" que usa ese otro camino.
  assert.doesNotMatch(
    textoCompleto,
    /todavia necesito confirmar|pendiente de confirmaci/i,
    'BUG si esto coincide: trato a Valencia como una zona de Caracas pendiente de confirmar, en vez de una negacion definitiva (Valencia esta fuera de Caracas)'
  );
});

// --- Item 3: la agencia confirmada persiste durante los turnos siguientes ---

test('ofrecer una agencia -> "Si" -> pedir datos -> recibir nombre/cedula/telefono -> preguntar plazo: la agencia sigue confirmada en TODOS esos turnos, nunca se vuelve a pedir', async () => {
  const phone = '584120002002';
  // Arranca la conversacion YA en el punto en que el bot mostro una sola
  // agencia y pregunto si le sirve (turno anterior a este test).
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({
      card: { producto: 'Shilajit' },
      lastAssistantText: '1. Carupano — Sucre\nCalle Independencia, cruce con calle Acosta\n¿Te queda bien esta agencia para retirar tu pedido?',
      history: [
        { role: 'user', content: 'hola, quiero el shilajit, soy de carupano', at: '2026-08-01T00:00:00.000Z' },
        {
          role: 'assistant',
          content: '1. Carupano — Sucre\nCalle Independencia, cruce con calle Acosta\n¿Te queda bien esta agencia para retirar tu pedido?',
          at: '2026-08-01T00:00:05.000Z',
        },
      ],
    }),
  }));

  // Turno 1: el cliente confirma la agencia con un "Si" suelto.
  impl = async () => ({
    text: 'Perfecto! Para procesar tu pedido enviame nombre y apellido, cedula y telefono.',
    images: [],
  });
  textosEnviados.length = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'Si' } }, 'Cliente');
  await sleep(150);

  let session = getSession(phone);
  assert.ok(
    session.card && session.card.agenciaConfirmadaEnChat,
    'BUG si esto no esta: la confirmacion de agencia de este turno no se guardo para los turnos siguientes'
  );

  // Turno 2: el cliente da nombre, cedula y telefono.
  impl = async () => ({
    text: 'Genial Carlos! ¿Prefieres que te lo enviemos en 2 o 3 dias?',
    images: [],
  });
  await flow.handleIncomingMessage(
    phone,
    { type: 'text', text: { body: 'Carlos Perez, cedula 12345678, telefono 04121234567' } },
    'Cliente'
  );
  await sleep(150);

  session = getSession(phone);
  assert.ok(session.card.agenciaConfirmadaEnChat, 'la agencia confirmada tiene que seguir ahi despues de dar los datos');

  // Turno 3: el cliente responde el plazo, y AHORA la IA arma el cierre real
  // (con cantidad y total, pero SIN volver a mencionar la agencia -- ya la
  // confirmo hace dos turnos).
  impl = async () => ({
    text: 'Listo! Tu pedido de 2 Shilajit (Bs 700) queda armado. El pago se hace contra entrega, y en cuanto tengamos la guia te aviso.',
    images: [],
  });
  textosEnviados.length = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'en 2 dias esta bien, quiero 2' } }, 'Cliente');
  await sleep(150);

  session = getSession(phone);
  const textos = textosDe(phone);
  assert.ok(
    !textos.some((t) => /te queda bien esta agencia|que agencia|cual agencia/i.test(t)),
    'BUG si esto aparece: se le volvio a preguntar por la agencia, aunque ya la habia confirmado varios turnos atras'
  );
  assert.equal(
    session.orderClosed,
    true,
    'BUG si esto no es true: el pedido no cerro porque la agencia confirmada hace turnos no se tuvo en cuenta (evaluateOrderCompleteness la volvio a pedir)'
  );
});

// --- Item 4: la proteccion de cobertura cubre TODOS los caminos de envio ---

test('mensaje inicial de producto (texto fijo del negocio, sin pasar por la IA): si menciona domicilio sin cobertura confirmada, tambien se corrige', async () => {
  const phone = '584120002003';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionBase() }));
  writeRaw(dataDir, 'products.json', JSON.stringify([
    {
      id: 'p1',
      name: 'Shilajit',
      price: 350,
      currency: 'Bs',
      active: true,
      triggers: ['shilajit'],
      // Mensaje inicial escrito por el negocio, a mano, que por error
      // promete domicilio sin condicionar nada.
      intro: 'Hola! Te contamos del Shilajit: te lo llevamos hasta la puerta de tu casa sin costo extra. ¿Cuantos frascos queres?',
    },
  ]));

  textosEnviados.length = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'hola, quiero info del shilajit' } }, 'Cliente');
  await sleep(150);

  const textos = textosDe(phone);
  assert.equal(textos.length, 1);
  assert.doesNotMatch(
    textos[0],
    /hasta la puerta de tu casa/i,
    'BUG si esto coincide: el mensaje inicial de producto (texto fijo, sin pasar por la IA) se mando tal cual, sin pasar por la validacion de cobertura'
  );

  // Restaura el catalogo de un solo producto sin intro riesgoso para el
  // resto de las pruebas de este archivo.
  writeRaw(dataDir, 'products.json', JSON.stringify([
    { id: 'p1', name: 'Shilajit', price: 350, currency: 'Bs', active: true },
  ]));
});

test('plantilla de pedido de datos (configurable desde el panel): si se edita para mencionar domicilio sin cobertura confirmada, tambien se corrige', async () => {
  const phone = '584120002004';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionBase({ card: { producto: 'Shilajit' } }) }));

  // El negocio edito la plantilla de pedido de datos desde el panel (por
  // defecto es segura, menciona Tealca) para prometer domicilio sin
  // condicionar nada.
  updateSettings({ dataRequestTemplate: 'Para procesar tu pedido enviame tus datos, te lo llevamos a tu direccion sin costo extra.' });
  try {
    impl = async () => ({
      text: 'Dale, en un momento te paso el formulario para tus datos.',
      images: [],
    });
    textosEnviados.length = 0;
    await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'quiero 2 frascos' } }, 'Cliente');
    await sleep(200);

    const textos = textosDe(phone);
    assert.ok(
      !textos.some((t) => /te lo llevamos a tu direccion sin costo extra/i.test(t)),
      'BUG si esto aparece: la plantilla de pedido de datos, editada desde el panel para mencionar domicilio, se mando tal cual'
    );
  } finally {
    updateSettings({ dataRequestTemplate: '' });
  }
});

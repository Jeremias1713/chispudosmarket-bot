// Pruebas de integracion de flow.js para la regresion reportada en produccion
// (branch regresion-cierre-secuencial-20260919): reproduce, contra un mock de
// getAssistantReply que CAPTURA los argumentos reales que recibio en cada
// llamada (en vez de solo devolver un texto fijo, como en los otros tests de
// esta suite), los puntos 1, 2, 8 y 9 del pedido de correccion. Todo esto es
// SIMULADO (mocks locales, sin red ni WhatsApp real, sin tocar produccion).
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('flow-regresion-secuencial');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const whatsapp = require('../src/whatsapp');
const ai = require('../src/ai');
const classifierMod = require('../src/classifier');
const { updateSettings } = require('../src/settings');
const { getSession } = require('../src/state');

// Delay de espera bien corto para que los tests corran rapido, pero se
// controla la duracion de getAssistantReply (mas abajo) para simular
// "mientras la respuesta anterior todavia se esta generando/enviando".
updateSettings({ replyDelayMs: 5, splitGapMinMs: 5, splitGapMaxMs: 8 });

const textosEnviados = [];
whatsapp.sendText = async (to, text) => {
  textosEnviados.push({ to, text });
  return { messages: [{ id: 'wamid.TEST' }] };
};
whatsapp.sendImageByLink = async () => ({});
whatsapp.sendAudioByLink = async () => ({});
whatsapp.downloadMedia = async () => { throw new Error('no deberia llamarse en estos tests'); };

// IMPORTANTE: flow.js hace `const { getAssistantReply } = require('./ai')`
// UNA sola vez, al cargarse -- reasignar ai.getAssistantReply DESPUES de
// ese require no cambia nada de lo que flow.js ya tiene enlazado. Por eso
// se define un unico mock ESTABLE (asignado una sola vez, antes del
// require de flow mas abajo) que delega a una variable mutable
// (impl/classifierImpl): los tests de este archivo cambian esa variable
// entre casos, nunca ai.getAssistantReply/classifierMod.classifyConversation
// directamente.
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

test('PUNTO 1 y 2: un mensaje nuevo que llega mientras la respuesta anterior todavia se esta generando/enviando NO dispara un segundo procesamiento en paralelo, y usa el userText real (no una burbuja del bot)', async () => {
  const phone = '584120001001';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionBase() }));

  const llamadas = [];
  let enCurso = 0;
  let maxConcurrencia = 0;
  impl = async (history, userText) => {
    enCurso++;
    maxConcurrencia = Math.max(maxConcurrencia, enCurso);
    llamadas.push({ history: history.map((m) => m.content), userText });
    // Simula una respuesta lenta (llamada real a OpenAI + varias partes
    // enviadas con pausas humanas): bastante mas larga que replyDelayMs, para
    // que un mensaje nuevo del cliente definitivamente llegue MIENTRAS esto
    // todavia esta corriendo.
    await sleep(120);
    enCurso--;
    return { text: `Respuesta a: ${userText}`, images: [] };
  };

  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'Hola, quiero info' } }, 'Cliente');
  // Mientras el primer processReply todavia esta "generando" (sleep de
  // 120ms), llega un segundo mensaje real del cliente.
  await sleep(40);
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'Dos mensajes nuevos' } }, 'Cliente');
  await sleep(20);
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'mientras la respuesta anterior se envia' } }, 'Cliente');

  // Espera a que las dos tandas terminen de procesarse del todo (la primera
  // ~120ms, la segunda arranca apenas termina la primera y tambien tarda
  // ~120ms, mas los pequenos delays de sendSplit).
  await sleep(400);

  assert.equal(maxConcurrencia, 1, 'BUG si esto es mayor a 1: dos processReply corrieron en paralelo para el MISMO numero');
  assert.equal(llamadas.length, 2, 'tienen que ser exactamente 2 llamadas: una por cada lote (el primer mensaje solo, y los otros dos juntos)');

  // PUNTO 2: la segunda llamada tiene que usar como userText el texto REAL
  // que mando el cliente en ese lote (los dos mensajes que llegaron durante
  // la primera generacion/envio), nunca una burbuja de la respuesta del bot
  // que ya se habia mandado.
  const segundaLlamada = llamadas[1];
  assert.match(segundaLlamada.userText, /Dos mensajes nuevos/, 'el userText del segundo lote tiene que incluir el segundo mensaje real del cliente');
  assert.match(segundaLlamada.userText, /mientras la respuesta anterior se envia/, 'el userText del segundo lote tiene que incluir el tercer mensaje real del cliente');
  assert.doesNotMatch(segundaLlamada.userText, /Respuesta a:/, 'BUG si el userText del segundo lote es una burbuja del propio bot, no texto del cliente');

  // El historial que se le paso a la segunda llamada tiene que incluir el
  // primer turno completo (mensaje del cliente + respuesta del bot), pero
  // NINGUNO de los mensajes del segundo lote (esos van en userText, no en
  // history, para no duplicarlos).
  assert.ok(segundaLlamada.history.some((c) => /Hola, quiero info/.test(c)), 'el historial de la segunda llamada tiene que incluir el primer mensaje del cliente');
  assert.ok(!segundaLlamada.history.some((c) => /Dos mensajes nuevos/.test(c)), 'BUG si el historial de la segunda llamada ya incluye el segundo mensaje: eso duplicaria el contexto (deberia venir solo en userText)');
});

test('PUNTO 1: clientes DISTINTOS se siguen atendiendo en paralelo, sin bloquearse entre si', async () => {
  const phoneA = '584120001002';
  const phoneB = '584120001003';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phoneA]: sesionBase(),
    [phoneB]: sesionBase(),
  }));

  let enCursoA = 0;
  let enCursoB = 0;
  let vioAmbosALaVez = false;
  impl = async (history, userText, knownCity, knownProduct, orderClosed, dataAlreadyRequested, shippingStage, knownCustomer, phone) => {
    if (userText.includes('numeroA')) enCursoA++;
    if (userText.includes('numeroB')) enCursoB++;
    if (enCursoA > 0 && enCursoB > 0) vioAmbosALaVez = true;
    await sleep(80);
    if (userText.includes('numeroA')) enCursoA--;
    if (userText.includes('numeroB')) enCursoB--;
    return { text: 'ok', images: [] };
  };

  await Promise.all([
    flow.handleIncomingMessage(phoneA, { type: 'text', text: { body: 'soy numeroA' } }, 'ClienteA'),
    flow.handleIncomingMessage(phoneB, { type: 'text', text: { body: 'soy numeroB' } }, 'ClienteB'),
  ]);
  await sleep(200);

  assert.equal(vioAmbosALaVez, true, 'BUG si esto es false: dos numeros DISTINTOS se estan bloqueando entre si, cuando el bloqueo tiene que ser SOLO por numero');
});

test('PUNTO 8: si la clasificacion posterior al envio falla, el cliente NO recibe el mensaje generico de "tuve un problema", porque su pregunta ya fue atendida bien', async () => {
  const phone = '584120001004';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionBase() }));

  impl = async () => ({ text: 'Esta es la respuesta real y correcta a tu pregunta.', images: [] });
  classifierImpl = async () => { throw new Error('fallo simulado del clasificador, despues de responder bien'); };

  textosEnviados.length = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'una pregunta cualquiera' } }, 'Cliente');
  await sleep(150);

  const textos = textosEnviados.filter((m) => m.to === phone).map((m) => m.text);
  assert.ok(textos.some((t) => /respuesta real y correcta/.test(t)), 'la respuesta real tiene que haberse mandado');
  assert.ok(!textos.some((t) => /tuve un problema/i.test(t)), 'BUG si esto aparece: el fallo del clasificador (que corre DESPUES de responder bien) no tiene que generar el mensaje generico de error, ni pedirle al cliente que repita algo que ya se le contesto');

  // Restaura el mock para el resto de los tests de este archivo.
  classifierImpl = async () => null;
});

test('PUNTO 9: isNewClose usa la respuesta FINAL (despues de las correcciones), no el texto original si termino siendo reemplazado', async () => {
  const phone = '584120001005';
  // Ficha deliberadamente incompleta (sin nombre/cedula/telefono, sin
  // cantidad ni agencia confirmada en el texto reciente): el "cierre" que
  // arma la IA en este test va a sonar a cierre por estilo de texto, pero la
  // validacion de completitud lo va a bajar a un aviso de incompleto.
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({ card: { producto: 'Shilajit' } }),
  }));

  impl = async () => ({
    text: 'Tu pedido queda listo, el pago se hace contra entrega y te aviso cuando llegue a la agencia. ¿Necesitas algo mas?',
    images: [],
  });

  textosEnviados.length = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'dale entonces' } }, 'Cliente');
  await sleep(150);

  const session = getSession(phone);
  const textos = textosEnviados.filter((m) => m.to === phone).map((m) => m.text);
  assert.notEqual(session.orderClosed, true, 'BUG si esto es true: el pedido se marco cerrado usando el texto ORIGINAL, aunque al cliente en realidad se le mando el aviso de datos incompletos');
  assert.ok(textos.some((t) => /me falta/i.test(t)), 'al cliente le tiene que haber llegado el aviso de datos incompletos, no el resumen de cierre original');
});

test('PUNTO 5: un pedido nuevo, con sus propios datos (cantidad+agencia) dados ANTES de una explicacion de politica que "suena" a cierre por estilo de texto, NO pierde esos datos -- el corte usa el ultimo cierre REALMENTE persistido (lastOrderCloseHistoryIndex), no una busqueda por estilo de texto que puede agarrar el mensaje equivocado', async () => {
  const phone = '584120001006';
  // indice 0: el pedido VIEJO. indice 1: el cierre REAL de ese pedido viejo
  // (este es el que queda en lastOrderCloseHistoryIndex=1, el indice que
  // ese mensaje de cierre ocupa en el historial). indice 2: el cliente YA
  // dio los datos del pedido NUEVO (cantidad + agencia). indice 3: el bot
  // responde una duda de POLITICA general (pago contra entrega + guia) que,
  // por puro ESTILO de texto, tambien "suena" a un resumen de cierre --
  // pero no es un cierre real, es solo la explicacion de como funciona el
  // envio. Con la busqueda vieja (por estilo, ver looksLikeClosingSummaryText
  // sobre TODO el historial de atras para adelante) este mensaje indice 3
  // seria el punto de corte elegido -- por estar MAS ADELANTE que el cierre
  // real -- y los datos del pedido nuevo (indice 2, cantidad+agencia) se
  // perderian por completo, aunque el cliente si los haya dado.
  const historial = [
    { role: 'user', content: 'Hola quiero 3 frascos de Shilajit para Barinas, la agencia 1 me sirve', at: '2026-08-01T00:00:00.000Z' },
    {
      role: 'assistant',
      content:
        'Listo! Tu pedido de 3 Shilajit (Bs 900) va a la agencia Tealca de Barinas. El pago se hace contra entrega, y en cuanto tengamos la guia te aviso.',
      at: '2026-08-01T00:00:05.000Z',
    },
    { role: 'user', content: 'Quiero pedir de nuevo, esta vez 2 frascos, misma agencia de Barinas', at: '2026-08-02T00:00:00.000Z' },
    {
      role: 'assistant',
      content: 'Para Tealca el pago es contra entrega y en cuanto tengamos la guia te aviso.',
      at: '2026-08-02T00:00:05.000Z',
    },
  ];
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionBase({
      history: historial,
      card: { nombre: 'Jesus Gonzalez', cedula: '16626658', telefono: '04264155170', producto: 'Shilajit', ciudad: 'barinas' },
      // Igual que hace buildGuiaPatch en orderGuard.js con un cliente
      // repetido: para arrancar un pedido NUEVO se reinicia orderClosed a
      // false (si no, isNewClose ni se evalua: ver la rama
      // "!orderClosed && ..." en flow.js), pero se CONSERVA
      // lastOrderCloseHistoryIndex -- el indice REAL (1) del unico cierre
      // que de verdad paso en esta conversacion.
      orderClosed: false,
      lastOrderCloseHistoryIndex: 1,
      stage: 'nuevo',
      lastAssistantText: historial[3].content,
    }),
  }));

  // El modelo (mock) cierra el pedido NUEVO sin repetir cantidad/agencia en
  // este ultimo texto (ya las dio el cliente antes, en el indice 2): si el
  // sistema no las recupera de ahi, el cierre se baja a "incompleto" aunque
  // el cliente si dio todo.
  impl = async () => ({
    text: 'Listo! Tu pedido queda armado, el pago se hace contra entrega y en cuanto tengamos la guia te aviso. Total Bs 700.',
    images: [],
  });

  textosEnviados.length = 0;
  await flow.handleIncomingMessage(phone, { type: 'text', text: { body: 'dale, confirmo eso' } }, 'Cliente');
  await sleep(150);

  const session = getSession(phone);
  const textos = textosEnviados.filter((m) => m.to === phone).map((m) => m.text);
  assert.ok(
    !textos.some((t) => /me falta/i.test(t)),
    'BUG si esto aparece: los datos del pedido NUEVO (cantidad+agencia, dados en el indice 2) se perdieron por un corte de segmento mal ubicado -- se estaria usando la busqueda vieja por estilo de texto, que agarra el mensaje de politica general (indice 3) en vez del cierre real (indice 1)'
  );
  assert.equal(session.orderClosed, true, 'el pedido nuevo si tiene todos los datos reales (cantidad+agencia del indice 2, identidad de la ficha, total en este mismo texto) y tiene que poder cerrar');
});

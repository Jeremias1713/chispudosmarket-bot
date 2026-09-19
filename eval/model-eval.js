// Evaluacion con el MODELO REAL de OpenAI (punto 7 del tercer mensaje de
// revision: "ejecuta la evaluacion con los prompts reales... no solamente
// con un producto de prueba").
//
// DIFERENCIA IMPORTANTE con los tests de test/*.test.js: esos tests corren
// contra RESPUESTAS SIMULADAS (un `replyToReturn.text` escrito a mano en el
// propio test, `ai.getAssistantReply` mockeado) -- prueban el CODIGO
// deterministico (evaluateOrderCompleteness, el guard de flow.js, etc.)
// contra cualquier texto, real o inventado. Esto de aca es lo unico en todo
// el repo que llama de verdad a `ai.getAssistantReply` (sin mockear) Y deja
// que `classifyConversation` (el clasificador de etapa/ficha, tambien un
// llamado real al modelo) corra sin mockear, para que la ficha del cliente
// se vaya completando como en produccion. Corre las conversaciones a traves
// de `flow.handleIncomingMessage`, el mismo punto de entrada que usa el
// webhook de WhatsApp real -- lo unico mockeado es el ENVIO (`whatsapp.js`)
// y la notificacion push, nunca la logica de negocio ni el modelo.
//
// QUE VERIFICA (los 2 resultados que pediste, no una lista de "checks
// varios"):
//   1. Un pedido INCOMPLETO nunca queda confirmado: ninguna de las
//      respuestas REALMENTE ENVIADAS al cliente (post-guard de flow.js)
//      puede tener forma de cierre (`looksLikeClosingSummaryText`) en un
//      turno donde la sesion no haya quedado con `orderClosed: true` en ese
//      mismo turno. Este chequeo corre en TODOS los turnos de TODOS los
//      escenarios, no solo en los que estan pensados para fallar.
//   2. Un pedido VALIDO SI se completa, sin repetir preguntas de datos que
//      el cliente ya dio: cada escenario que deberia cerrar declara
//      `debeCerrar: true` y se verifica que, al final, `orderClosed` sea
//      `true`; ademas se revisa que ningun mensaje enviado despues de que un
//      dato (identidad/cantidad/destino) ya fue dado vuelva a pedirlo.
//
// AISLAMIENTO: NUNCA importa `src/whatsapp.js` sin mockear -- `sendText` /
// `sendImageByLink` / `sendAudioByLink` / `downloadMedia` se sobreescriben
// ANTES de requerir `src/flow.js` (mismo mecanismo que
// `test/flow-order-close-guard.test.js`), asi que es fisicamente imposible
// que esto le mande un mensaje a un cliente real o toque produccion. Usa una
// carpeta de datos TEMPORAL (`BOT_DATA_DIR`, nunca `data/` del repo) con
// `agencies.csv` real (dato publico de cobertura) y un `products.json`
// aislado (de prueba, o el real que pegues en
// `eval/real-products.local.json`, que nunca se commitea). La notificacion
// push tambien se mockea (solo cuenta cuantas veces se dispararia).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!(process.env.OPENAI_API_KEY || '').trim()) {
  console.error('Falta OPENAI_API_KEY. Ver el comentario al principio de este archivo: hace falta una key de prueba con un poco de saldo antes de correr esto.');
  console.error('NUNCA se pega la key en este archivo ni en ningun archivo del repo: se pasa como variable de entorno al momento de correr, y asi nunca queda en el chat ni en git:');
  console.error('  OPENAI_API_KEY=sk-... node eval/model-eval.js');
  process.exit(1);
}

process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

// Carpeta de datos temporal y AISLADA: nunca toca data/ del repo ni ningun
// dato real de produccion. BOT_DATA_DIR tiene que fijarse ANTES de requerir
// cualquier modulo de src/ (mismo mecanismo que test/helpers/tempDataDir.js).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chispudos-eval-'));
fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
process.env.BOT_DATA_DIR = dataDir;

// Copia las agencias REALES (dato publico de cobertura, no de clientes) para
// que la herramienta buscar_agencias_por_zona tenga datos de verdad con las
// que trabajar durante la evaluacion (los escenarios de abajo usan Barinas,
// que tiene varias agencias reales en este archivo).
fs.copyFileSync(path.join(__dirname, '..', 'data', 'agencies.csv'), path.join(dataDir, 'agencies.csv'));

// Punto 7: correr esto con los PROMPTS REALES del negocio (los del
// panel/producto), no solo con un producto de prueba generico. Si existe
// eval/real-products.local.json (nunca se commitea -- ver .gitignore) se usa
// TAL CUAL como catalogo de esta corrida: es la forma de pegar el prompt
// real de un producto (texto de negocio, no un secreto) sin tocar codigo ni
// pasar por el chat. Misma forma que data/products.json (array de
// productos, con al menos name/description/price/currency/prompt). Si no
// existe, o no se puede parsear, se usa el producto de prueba generico de
// siempre (fallback seguro, nunca falla en silencio: avisa por consola cual
// de los dos catalogos se uso de verdad).
const REAL_PRODUCTS_PATH = path.join(__dirname, 'real-products.local.json');
let productosParaEsteRun;
let usandoCatalogoReal = false;
if (fs.existsSync(REAL_PRODUCTS_PATH)) {
  try {
    productosParaEsteRun = JSON.parse(fs.readFileSync(REAL_PRODUCTS_PATH, 'utf8'));
    usandoCatalogoReal = true;
    console.log(`Usando catalogo REAL pegado en ${path.relative(process.cwd(), REAL_PRODUCTS_PATH)} (${productosParaEsteRun.length} producto(s)).`);
  } catch (err) {
    console.error(`No se pudo leer/parsear ${REAL_PRODUCTS_PATH}: ${err.message}. Se usa el producto de prueba generico en su lugar.`);
    productosParaEsteRun = null;
  }
}
if (!productosParaEsteRun) {
  console.log('Usando el producto de prueba generico ("Shilajit Eval"), NO un prompt real de negocio. Para evaluar con tus prompts reales, pega el catalogo en eval/real-products.local.json.');
  productosParaEsteRun = [
    {
      id: 'eval-shilajit',
      name: 'Shilajit Eval',
      description: 'Producto de prueba para esta evaluacion (no es un producto real del negocio).',
      price: 25,
      currency: 'Bs',
      active: true,
    },
  ];
}
fs.writeFileSync(path.join(dataDir, 'products.json'), JSON.stringify(productosParaEsteRun, null, 2));
const NOMBRE_PRODUCTO = productosParaEsteRun[0].name;

// --- Mocks de ENVIO, fijados ANTES de requerir flow.js (flow.js hace
// `const { sendText, ... } = require('./whatsapp')`, una desestructuracion
// que copia la referencia en el momento del require -- si se mockea
// despues, flow.js se queda con la funcion real). El modelo (ai.js) y el
// clasificador (classifier.js) se dejan SIN mockear a proposito: son
// justamente lo que esta evaluacion tiene que ejercitar de verdad. ---
const whatsapp = require('../src/whatsapp');
const textosEnviados = []; // { to, text }
whatsapp.sendText = async (to, text) => {
  textosEnviados.push({ to, text });
  return { messages: [{ id: 'wamid.EVAL' }] };
};
whatsapp.sendImageByLink = async () => ({});
whatsapp.sendAudioByLink = async () => ({});
whatsapp.downloadMedia = async () => { throw new Error('no deberia llamarse en esta evaluacion (ningun escenario manda audio/imagen)'); };

const { updateSettings } = require('../src/settings');
updateSettings({ replyDelayMs: 30 }); // corto pero no cero: solo evita que dos mensajes seguidos del mismo turno se pisen

const ai = require('../src/ai');
const { getSession } = require('../src/state');
const flow = require('../src/flow');
const push = require('../src/push');
let notificacionesDeVenta = 0;
push.notifySale = () => { notificacionesDeVenta++; };

// --- Helpers de espera: el envio real ocurre de forma diferida
// (scheduleReply -> setTimeout -> processReply), y processReply ahora hace
// llamados REALES a OpenAI (la respuesta y, despues de mandarla, la
// reclasificacion), asi que el tiempo de espera no es fijo como en los
// tests con mocks. Se hace polling en vez de un delay fijo. ---
function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function esperarEnvio(cantidadEsperada, timeoutMs) {
  const limite = Date.now() + (timeoutMs || 45000);
  while (textosEnviados.length < cantidadEsperada) {
    if (Date.now() > limite) {
      throw new Error(`Timeout esperando el envio numero ${cantidadEsperada} (llevamos ${textosEnviados.length}).`);
    }
    await esperar(250);
  }
  // Un margen chico extra: processReply sigue corriendo la reclasificacion
  // (otro llamado real al modelo) DESPUES de mandar el mensaje, y queremos
  // que la ficha/etapa ya haya terminado de actualizarse antes de leer la
  // sesion para el chequeo de coherencia.
  await esperar(400);
}

function sesionBase(overrides) {
  const ahora = new Date().toISOString();
  return {
    step: 'IDLE', cart: [], history: [{ role: 'user', content: 'hola', at: ahora }],
    name: 'Cliente Eval', stage: 'interesado', stageLocked: false, stageReason: null,
    paused: false, pausedReason: null,
    card: {},
    adCode: null, createdAt: ahora, updatedAt: ahora,
    ...overrides,
  };
}

function escribirSesionInicial(phone, overrides) {
  const sessionsPath = path.join(dataDir, 'sessions.json');
  let actual = {};
  try { actual = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')); } catch (err) { actual = {}; }
  actual[phone] = sesionBase(overrides);
  fs.writeFileSync(sessionsPath, JSON.stringify(actual, null, 2));
}

// Patrones (heuristicos, a proposito los mismos que usa el codigo de
// produccion) para detectar si un mensaje YA ENVIADO vuelve a pedir un dato
// que la conversacion ya tenia resuelto -- el chequeo #2 ("sin repetir
// preguntas") de la seccion de arriba.
const PIDE_IDENTIDAD_RE = /nombre\s+y\s+apellido|env[ií]anos.*(nombre|c[ée]dula)|(nombre|c[ée]dula).*(env[ií]anos|necesito)/i;
const PIDE_CANTIDAD_RE = /cu[aá]nt[oa]s?\s+(unidades|frascos|quer[eé]s|quieres|vas a pedir)/i;
const PIDE_DESTINO_RE = /a\s+qu[eé]\s+(agencia|direcci[oó]n)|d[oó]nde\s+lo\s+recibes|cu[aá]l\s+agencia\s+te\s+sirve/i;

async function correrTurno(phone, mensaje, profileName) {
  const antesCount = textosEnviados.length;
  await flow.handleIncomingMessage(phone, mensaje, profileName || 'Cliente Eval');
  await esperarEnvio(antesCount + 1);
  const enviados = textosEnviados.slice(antesCount).filter((e) => e.to === phone);
  const session = getSession(phone);
  return { enviados, session };
}

// --- Escenarios ---
// Cada uno se corre en su propio numero (para no mezclar sesiones), declara
// si al final TIENE que quedar cerrado (`debeCerrar`) y trae un chequeo
// extra opcional (`chequeoExtra`) para lo que el chequeo generico de
// coherencia no cubre (ej. "no se reabre un pedido ya vendido").
const ESCENARIOS = [
  {
    nombre: '1. Conversacion LARGA con un desvio en el medio, cierre de DELIVERY al final (identidad+cantidad+direccion+aceptacion)',
    phone: '58900000001',
    sesionInicial: {},
    debeCerrar: true,
    turnos: [
      { texto: `hola, cuanto sale el ${NOMBRE_PRODUCTO}?` },
      { texto: 'quiero 2 porfa' },
      { texto: 'antes de seguir, uds envian a otros paises o solo Venezuela?' }, // desvio: no debe perder los datos ya dados
      { texto: 'bueno, entonces si, va para Venezuela: Carlos Perez, cedula 12345678, telefono 04121234567, a domicilio en Av Libertador casa 5, cerca de la plaza' },
      { texto: 'dale, asi esta bien, confirmalo' },
    ],
    prohibirRepetirDespuesDe: { turno: 3, patrones: [PIDE_IDENTIDAD_RE] },
  },
  {
    nombre: '2. CLIENTE ANTIGUO (datos ya guardados de una compra anterior): consulta de pura cobertura NO cierra',
    phone: '58900000002',
    sesionInicial: { card: { nombre: 'Maria Lopez', cedula: '87654321', telefono: '04141112233' }, orderClosed: false },
    debeCerrar: false,
    turnos: [
      { texto: 'hola, tambien hacen envios a Barinas?' },
    ],
  },
  {
    nombre: '3. CLIENTE ANTIGUO que SI arma un pedido nuevo real (agencia puntual + aceptacion), sin repetir sus datos personales',
    phone: '58900000003',
    sesionInicial: { card: { nombre: 'Maria Lopez', cedula: '87654321', telefono: '04141112233' }, orderClosed: false },
    debeCerrar: true,
    turnos: [
      { texto: `quiero pedir de nuevo, esta vez 3 del ${NOMBRE_PRODUCTO}, retiro en agencia en Barinas` },
      { texto: 'la primera agencia me sirve' },
      { texto: 'si, confirmo asi' },
    ],
    prohibirRepetirDespuesDe: { turno: 0, patrones: [PIDE_IDENTIDAD_RE] },
  },
  {
    nombre: '4. Cambio de CANTIDAD antes de cerrar: no debe cerrar con la cantidad vieja',
    phone: '58900000004',
    sesionInicial: {},
    debeCerrar: true,
    turnos: [
      { texto: `hola, quiero cotizar 2 ${NOMBRE_PRODUCTO} para Barinas, retiro en agencia` },
      { texto: 'mejor mandame 4, cambie de opinion' },
      { texto: 'la agencia 1 me sirve, soy Carlos Perez, cedula 12345678, telefono 04121234567' },
      { texto: 'si, asi confirmo, cierralo' },
    ],
  },
  {
    nombre: '5. Delivery a domicilio cuyo cierre no tiene por que mencionar Tealca/agencia/guia',
    phone: '58900000005',
    sesionInicial: {},
    debeCerrar: true,
    turnos: [
      { texto: `quiero 1 ${NOMBRE_PRODUCTO} a domicilio: Maria Lopez, cedula 87654321, telefono 04141112233, Calle Real casa 10, cerca del mercado de Barinas` },
      { texto: 'si, dale, confirmo' },
    ],
  },
  {
    nombre: '6. Pregunta de precio + retractacion explicita, ninguna de las dos cierra; el pedido real despues si',
    phone: '58900000006',
    sesionInicial: {},
    debeCerrar: true,
    turnos: [
      { texto: 'cuanto cuestan dos?' },
      { texto: 'no me lo mandes todavia, solo quiero saber el precio' },
      { texto: `bueno ya, quiero 2, la agencia 1 en Barinas, Carlos Perez, cedula 12345678, telefono 04121234567, si confirmo` },
    ],
    debeCerrarDesdeElTurno: 2, // los turnos 0 y 1 tienen que quedar SIN cerrar
  },
  {
    nombre: '7. Sticker solo (con casi todo lo demas ya en la ficha) NO alcanza para cerrar',
    phone: '58900000007',
    sesionInicial: { card: { producto: NOMBRE_PRODUCTO, ciudad: 'barinas', agencia: 'Alto Barinas', nombre: 'Carlos Perez', cedula: '12345678', telefono: '04121234567' } },
    debeCerrar: false,
    turnos: [
      { mensaje: { type: 'sticker' } },
    ],
  },
  {
    nombre: '8. Pedido YA CERRADO: cambiar la cantidad despues no reabre ni duplica el aviso de venta',
    phone: '58900000008',
    sesionInicial: {
      card: { producto: NOMBRE_PRODUCTO, ciudad: 'barinas', nombre: 'Carlos Perez', cedula: '12345678', telefono: '04121234567' },
      stage: 'vendido', orderClosed: true, soldAt: '2026-08-01T05:00:00.000Z',
    },
    debeCerrar: true, // ya estaba cerrado; tiene que SEGUIR cerrado
    noDebeNotificarVentaDeNuevo: true,
    turnos: [
      { texto: 'mejor cambiame a 3 unidades' },
    ],
  },
];

async function correrEscenario(escenario) {
  console.log(`\n=== ${escenario.nombre} ===`);
  escribirSesionInicial(escenario.phone, escenario.sesionInicial || {});
  const notificacionesAntes = notificacionesDeVenta;

  const fallos = [];
  let datoIdentidadYaDado = Boolean(
    (escenario.sesionInicial || {}).card &&
    (escenario.sesionInicial.card.nombre && escenario.sesionInicial.card.cedula && escenario.sesionInicial.card.telefono)
  );

  for (let i = 0; i < escenario.turnos.length; i++) {
    const turno = escenario.turnos[i];
    const mensaje = turno.mensaje || { type: 'text', text: { body: turno.texto } };
    let resultado;
    try {
      resultado = await correrTurno(escenario.phone, mensaje, 'Cliente Eval');
    } catch (err) {
      fallos.push(`turno ${i} (${turno.texto || turno.mensaje?.type}): ERROR llamando al modelo/flow: ${err.message}`);
      break;
    }
    const { enviados, session } = resultado;
    for (const e of enviados) {
      console.log(`  [turno ${i}] enviado: ${JSON.stringify(e.text).slice(0, 220)}`);
    }
    const textoEnviado = enviados.map((e) => e.text).join(' ');

    // Chequeo #1 (coherencia, en TODOS los turnos de TODOS los escenarios):
    // si lo que se mando de verdad tiene forma de cierre, la sesion tiene
    // que haber quedado orderClosed:true en este mismo turno.
    if (ai.looksLikeClosingSummaryText(textoEnviado) && session.orderClosed !== true) {
      fallos.push(`turno ${i}: el texto ENVIADO AL CLIENTE suena a cierre ("${textoEnviado.slice(0, 160)}...") pero la sesion NO quedo orderClosed:true -- pedido incompleto confirmado de palabra`);
    }

    // Chequeo #2 (no repetir preguntas de datos ya dados).
    if (datoIdentidadYaDado && PIDE_IDENTIDAD_RE.test(textoEnviado)) {
      fallos.push(`turno ${i}: vuelve a pedir nombre/cedula/telefono aunque ya estaban confirmados`);
    }
    if (session.card?.nombre && session.card?.cedula && session.card?.telefono) datoIdentidadYaDado = true;

    if (escenario.prohibirRepetirDespuesDe && i > escenario.prohibirRepetirDespuesDe.turno) {
      for (const patron of escenario.prohibirRepetirDespuesDe.patrones) {
        if (patron.test(textoEnviado)) {
          fallos.push(`turno ${i}: repite una pregunta de un dato que ya se dio en el turno ${escenario.prohibirRepetirDespuesDe.turno} (patron: ${patron})`);
        }
      }
    }

    if (escenario.debeCerrarDesdeElTurno !== undefined && i < escenario.debeCerrarDesdeElTurno && session.orderClosed === true) {
      fallos.push(`turno ${i}: cerro ANTES de tiempo (se esperaba que recien cerrara desde el turno ${escenario.debeCerrarDesdeElTurno})`);
    }
  }

  const sessionFinal = getSession(escenario.phone);
  if (escenario.debeCerrar && sessionFinal.orderClosed !== true) {
    fallos.push(`estado final: se esperaba orderClosed:true al terminar la conversacion, pero quedo en ${JSON.stringify(sessionFinal.orderClosed)}`);
  }
  if (escenario.debeCerrar === false && sessionFinal.orderClosed === true) {
    fallos.push(`estado final: NO se esperaba un cierre (era una consulta/dato incompleto/sticker), pero orderClosed quedo true`);
  }
  if (escenario.noDebeNotificarVentaDeNuevo && notificacionesDeVenta !== notificacionesAntes) {
    fallos.push(`se disparo una notificacion de venta nueva (${notificacionesDeVenta - notificacionesAntes}) por un pedido que ya estaba cerrado de antes`);
  }

  if (fallos.length) {
    console.log(`  RESULTADO: FAIL`);
    fallos.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`  RESULTADO: PASS (estado final: orderClosed=${sessionFinal.orderClosed === true}, stage=${sessionFinal.stage})`);
  }
  return fallos;
}

async function correr() {
  console.log(`Corriendo ${ESCENARIOS.length} escenarios de conversacion contra el modelo real (${process.env.OPENAI_MODEL || 'gpt-4o-mini (default del bot)'}).`);
  console.log(`Catalogo usado: ${usandoCatalogoReal ? 'REAL (eval/real-products.local.json)' : 'de prueba generico (Shilajit Eval)'}.`);
  console.log('Cada respuesta marcada "enviado:" de aca abajo es la respuesta REAL del modelo (post-guard de flow.js), nunca una respuesta simulada.\n');

  let totalFallos = 0;
  for (const escenario of ESCENARIOS) {
    const fallos = await correrEscenario(escenario);
    totalFallos += fallos.length ? 1 : 0;
  }

  console.log(`\n${ESCENARIOS.length - totalFallos}/${ESCENARIOS.length} escenarios OK.`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(totalFallos ? 1 : 0);
}

correr();

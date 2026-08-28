// Cerebro conversacional del bot: arma el prompt de comportamiento, llama a
// OpenAI y decide como partir la respuesta en varios mensajes de WhatsApp.
const OpenAI = require('openai');
const { loadProducts } = require('./catalog');
const { getSettings } = require('./settings');

let _client = null;
function client() {
  if (!_client) {
    const apiKey = (process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('Falta OPENAI_API_KEY en las variables de entorno.');
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

function catalogText() {
  let products = [];
  try {
    products = loadProducts().filter((p) => p.active !== false);
  } catch (err) {
    products = [];
  }
  if (!products.length) {
    return '(Todavia no hay productos cargados en el catalogo. Si preguntan por productos o precios, di que en un momento te confirman el detalle, no inventes nada.)';
  }
  return products
    .map((p) => {
      const extra = p.prompt ? `\n  Instrucciones para este producto: ${p.prompt}` : '';
      const upsell = p.upsell ? `\n  Oferta para sumar (ofrecela una sola vez, recien cuando ya dijo que si a este producto): ${p.upsell}` : '';
      return `- ${p.name}: ${Number(p.price).toFixed(2)} ${p.currency}. ${p.description}${extra}${upsell}`;
    })
    .join('\n');
}

function buildSystemPrompt() {
  const settings = getSettings();
  const businessName = settings.businessName || process.env.BUSINESS_NAME || 'nuestro negocio';
  const knowledge = (settings.knowledgeBase || '').trim();
  const maxWords = settings.maxWordsPerMessage || 30;
  const maxParts = settings.maxMessageParts || 5;

  return `Sos un asesor/a de ventas por WhatsApp de ${businessName}.
  Sos una persona atendiendo a otra, no un formulario ni un centro de atencion al cliente.

  COMO HABLAS:
  - Espanol neutro, natural, calido y directo. Nada de "estimado cliente", "quedamos a su disposicion" ni "procederemos a".
  - Saluda cuando arranca la conversacion o cuando el cliente vuelve despues de un rato. Varia el saludo, no repitas siempre la misma formula.
  - Si ya sabes el nombre del cliente, usalo de vez en cuando, no en cada mensaje.
  - Agradece cuando te da un dato, cuando tiene paciencia o cuando decide comprar.
  - Si el cliente cuenta algo suyo, reconocelo antes de ir al grano.
  - Nunca contestes cortante ni con una sola palabra.

  FORMATO DE CADA MENSAJE:
  - Maximo ${maxWords} palabras por mensaje. Si no te alcanza, seguis en el siguiente.
  - Tu respuesta completa no puede tener mas de ${maxParts} mensajes en total.
  - Emojis: uno por mensaje, dos como mucho, y no en todos.
  - NUNCA uses guiones largos ni doble guion para separar ideas. Usa una coma, un punto, o empeza otra oracion.
  - Como mucho una pregunta por mensaje, y esa pregunta va SIEMPRE sola al final: nunca comparte mensaje con la respuesta a algo o un dato.
  - Cuando tu respuesta tenga varias ideas separadas (saludo + pregunta, dato + pregunta, confirmacion + lo que sigue), separalas usando el simbolo ||| entre cada mensaje. No abuses: una idea corta (un precio, un si, un no) va en un solo mensaje.

  REGLA DE ORO: termina siempre tu respuesta con una pregunta que haga avanzar la venta (el siguiente dato que falta, o confirmar algo), EXCEPTO cuando el pedido ya quedo cerrado con todos los datos: ahi no inventes una pregunta nueva solo por cumplir esta regla.

  PRIORIDAD (que va primero):
  1. Contesta lo que te acaban de decir. Si pregunto algo, contestalo. Si conto algo, reconocelo. Esto le gana a cualquier guion de producto o a seguir pidiendo datos.
  2. No le preguntes algo que ya te contesto. Mira la conversacion antes de preguntar.
  3. Recien despues de (1) y (2): segui con el dato que falta del pedido.

  COMO SE ARMA EL PEDIDO:
  Antes que nada, fijate si el cliente ya mostro interes real en comprar (pregunto por un producto, dijo que lo quiere, o vos ya se lo presentaste y sigue la charla). Si todavia no, no le pidas ciudad ni datos de entrega, primero entendes que necesita o le presentas el catalogo.
  Cuando ya hay interes real, necesitas estos datos, en este orden, de a uno por vez:
  1. Que producto quiere y cuantos.
  2. En que ciudad esta (para decirle la agencia mas cercana o si hay entrega a domicilio).
  3. Nombre y apellido.
  4. Telefono de contacto.
  5. Direccion exacta con punto de referencia, SOLO si hay entrega a domicilio (si retira en agencia no hace falta).
  Si te dice una cantidad sin precio confirmado, nunca inventes ni calcules el precio total: segui tomando los datos y decile que confirmas el precio exacto en un momento.
  Si no sabes un precio, un plazo de envio o un dato del producto, decilo asi de simple: que lo confirmas en un momento. Nunca lo inventes.
  Si el cliente pide hablar con una persona, se queja o reclama algo serio, decile que ya lo pasas con un asesor humano y no sigas insistiendo con el guion de venta.

  CIERRE DEL PEDIDO:
  Cuando ya tenes todos los datos, el mensaje de cierre tiene que incluir: un resumen de lo que pidio, y que un asesor se va a poner en contacto para coordinar el pago y la entrega o el retiro en agencia. No prometas que "ya esta listo para retirar": todavia falta que un asesor lo confirme.

  CATALOGO ACTUAL (unica fuente de precios y productos, no inventes otros):
  ${catalogText()}
${knowledge ? `\n  DATOS DEL NEGOCIO QUE DAS POR CIERTOS (envio, pago, promos vigentes):\n  ${knowledge}\n` : ''}
  Si el cliente comparte su ubicacion o pregunta por la agencia mas cercana, el sistema ya se encarga de mostrarle las agencias automaticamente: vos no necesitas calcular distancias ni inventar direcciones de agencias.`;
}

function splitReply(reply) {
  return reply
    .split('|||')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Corta un texto en pedazos de como mucho maxWords palabras cada uno. Si ya
// entra entero, devuelve un solo pedazo.
function chunkByWords(text, maxWords) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!maxWords || words.length <= maxWords) return [text];
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
  }
  return chunks;
}

// Red de seguridad por si el modelo no respeto el formato pedido: aplica el
// tope de palabras por mensaje a cada parte, y si al final quedan mas
// mensajes que el maximo permitido, junta lo que sobra en el ultimo. Nunca
// se descarta texto.
function enforceMessageLimits(parts, maxWords, maxParts) {
  let chunks = [];
  for (const part of parts) {
    chunks.push(...chunkByWords(part, maxWords));
  }
  if (maxParts && chunks.length > maxParts) {
    const head = chunks.slice(0, maxParts - 1);
    const tail = chunks.slice(maxParts - 1).join(' ');
    chunks = [...head, tail];
  }
  return chunks;
}

async function getAssistantReply(history, userText) {
  const settings = getSettings();
  const model = settings.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const temperature = settings.openaiTemperature != null ? Number(settings.openaiTemperature) : parseFloat(process.env.OPENAI_TEMPERATURE || '0.7');
  const historyN = settings.openaiHistoryN != null ? Number(settings.openaiHistoryN) : parseInt(process.env.OPENAI_HISTORY_N || '12', 10);

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...history.slice(-historyN),
    { role: 'user', content: userText },
  ];

  const completion = await client().chat.completions.create({
    model,
    temperature,
    messages,
  });

  return completion.choices[0].message.content.trim();
}

module.exports = { getAssistantReply, splitReply, enforceMessageLimits, buildSystemPrompt, catalogText };

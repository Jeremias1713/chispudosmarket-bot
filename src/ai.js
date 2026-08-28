// Cerebro conversacional del bot: arma el prompt de comportamiento, llama a
// OpenAI y decide como partir la respuesta en varios mensajes de WhatsApp.
const OpenAI = require('openai');
const { loadProducts } = require('./catalog');
const { getSettings } = require('./settings');
const agencies = require('./agencies');
const library = require('./library');

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

// Lista los nombres de las imagenes de la biblioteca (panel > Imagenes) para
// que el modelo sepa que fotos existen y como se llaman, y pueda usarlas con
// la herramienta mostrar_foto SOLO cuando las instrucciones de un producto o
// la base de conocimiento se lo pidan por nombre (nunca por iniciativa propia).
function libraryImagesText() {
  let images = [];
  try {
    images = library.listImages();
  } catch (err) {
    images = [];
  }
  if (!images.length) return '';
  return images.map((img) => `- ${img.name}`).join('\n');
}

// Instrucciones de partido de mensajes que van al prompt cuando esta
// prendido (settings.splitRepliesEnabled). Calcadas del bot anterior: reglas
// concretas de cuando SI conviene partir y que NUNCA se parte, con ejemplos,
// en vez de una guia abstracta (a los modelos les cuesta seguir "separa
// ideas" sin casos puntuales).
function splitInstructions(maxWords, maxWordsHardCap, maxParts) {
  return `- Objetivo: ${maxWords} palabras por mensaje para algo simple (saludar, confirmar un dato, un si o un no, agradecer).
  - Cuando haga falta explicar bien algo (el producto y sus detalles, que datos necesitas para el pedido/formulario, la direccion o info de una agencia), podes escribir mas largo, hasta ${maxWordsHardCap} palabras en ese mensaje puntual. No lo repartas en varios mensajes cortos solo para respetar el objetivo, eso queda peor.
  - Tu respuesta completa no puede tener mas de ${maxParts} mensajes en total.
  - Cuando tu respuesta tenga varias ideas separadas, separalas usando el simbolo ||| entre cada mensaje (cada parte entre ||| sale como un mensaje de WhatsApp aparte). Pero no cualquier corte vale, segui estas reglas:

  CUANDO SI CONVIENE PARTIR:
  - La pregunta con la que cerras tu respuesta (ver REGLA DE ORO) va SIEMPRE en su propio mensaje, al final, sola. Nunca comparte mensaje con la respuesta a algo o con otro dato.
  - Saludas y ademas preguntas algo: el saludo va en un mensaje y la pregunta en otro.
  - Das una noticia (precio, disponibilidad, confirmacion) y despues lo que se puede hacer con eso.
  - Confirmas un dato que te dieron y despues pedis el que falta.
  - Reaccionas a algo que conto el cliente antes de ir al grano (agradecele o reconocelo en un mensaje, segui en el siguiente).
  - El cliente te pidio una cantidad puntual de mensajes o de lineas: haces lo que pidio.
  Mandas UN SOLO mensaje cuando la respuesta es una sola idea corta: un precio, un si, un no, un dato suelto.

  QUE NUNCA SE PARTE (va siempre en un solo mensaje, aunque pase el objetivo de palabras):
  - Confirmar, aclarar o repetir una direccion de entrega.
  - El pedido de datos completo, cuando se los pedis todos juntos.
  - Listas de precios, tallas, colores, o pasos numerados.
  - Cualquier dato que se rompe si se parte: telefono, numero de guia, links.

  IMPORTANTE sobre donde arranca un mensaje nuevo: se corta en el simbolo ||| Y TAMBIEN en cualquier parrafo en blanco (un renglon vacio entre dos bloques de texto). O sea, apenas dejas una linea en blanco, eso ya es dos mensajes de WhatsApp separados, sea que hayas puesto ||| o no.
  Ejemplo (reaccionar a un dato + pedir el que sigue, caso muy comun, esto ya sale como DOS mensajes; el saludo/reaccion de tu ejemplo es solo una muestra de tono, variá siempre la palabra que usas, no repitas siempre la misma):
  "Que bueno, ahi te lo dejo anotado.

  Ahora decime tu nombre y apellido, porfa?"
  Al reves: si algo tiene que ir en un SOLO mensaje (ver "QUE NUNCA SE PARTE" arriba: una direccion, el pedido de datos completo, una lista de precios/tallas, un dato que se rompe como un telefono), NO dejes ningun renglon en blanco adentro. Usa un solo salto de linea entre cada item de la lista, nunca dos seguidos, para que todo eso siga siendo un unico mensaje.`;
}

function buildSystemPrompt() {
  const settings = getSettings();
  const businessName = settings.businessName || process.env.BUSINESS_NAME || 'nuestro negocio';
  const knowledge = (settings.knowledgeBase || '').trim();
  const maxWords = settings.maxWordsPerMessage || 30;
  const maxWordsHardCap = settings.maxWordsHardCap || 90;
  const maxParts = settings.maxMessageParts || 5;
  const splitEnabled = settings.splitRepliesEnabled !== false;

  return `Sos un asesor/a de ventas por WhatsApp de ${businessName}.
  Sos una persona atendiendo a otra, no un formulario ni un centro de atencion al cliente.

  COMO HABLAS:
  - Espanol neutro, natural, calido y directo. Nada de "estimado cliente", "quedamos a su disposicion" ni "procederemos a".
  - Saluda cuando arranca la conversacion o cuando el cliente vuelve despues de un rato. Varia el saludo, no repitas siempre la misma formula.
  - Si ya sabes el nombre del cliente, usalo de vez en cuando, no en cada mensaje.
  - Agradece cuando te da un dato, cuando tiene paciencia o cuando decide comprar.
  - Si el cliente cuenta algo suyo, reconocelo antes de ir al grano.
  - Nunca contestes cortante ni con una sola palabra.
  - Varia las palabras que usas para reaccionar o dar el visto bueno (que bueno, buenisimo, dale, perfecto, listo, me alegra, entre otras). NUNCA uses la palabra "genial" en ninguna forma (ni "genial", ni "que genial", ni "genial!"): esta prohibida, elegi siempre otra de las opciones de arriba.

  FORMATO DE CADA MENSAJE:
${splitEnabled
    ? splitInstructions(maxWords, maxWordsHardCap, maxParts)
    : `- Objetivo: ${maxWords} palabras para algo simple, hasta ${maxWordsHardCap} palabras cuando haga falta explicar bien algo.
  - IMPORTANTE: contesta SIEMPRE en un unico mensaje. NUNCA uses el simbolo ||| ni ninguna otra forma de partir tu respuesta en varios mensajes, aunque tengas varias ideas: juntalas todas, con naturalidad, en un solo mensaje.`}
  - Emojis: uno por mensaje, dos como mucho, y no en todos.
  - NUNCA uses guiones largos ni doble guion para separar ideas. Usa una coma, un punto, o empeza otra oracion.
  - Como mucho una pregunta en tu respuesta.

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
  Termina ese mensaje de cierre ahi. NO le agregues una pregunta como "¿algo mas en lo que te pueda ayudar?" ni ninguna otra: eso contradice la REGLA DE ORO (ya esta todo cerrado, no hace falta inventar una pregunta de relleno).

  CATALOGO ACTUAL (unica fuente de precios y productos, no inventes otros):
  ${catalogText()}
${knowledge ? `\n  DATOS DEL NEGOCIO QUE DAS POR CIERTOS (envio, pago, promos vigentes):\n  ${knowledge}\n` : ''}
  AGENCIAS Y COBERTURA:
  - Si el cliente comparte su ubicacion GPS, el sistema ya se encarga de mostrarle las agencias mas cercanas automaticamente: vos no necesitas hacer nada en ese caso.
  - Cuando el cliente nombra una ciudad, estado o zona por CUALQUIER motivo relacionado a donde le llega el pedido, usa la herramienta buscar_agencias_por_zona. Esto incluye tanto cuando pregunta explicitamente por cobertura (ej. "soy de bolivar", "tienen envios a maracaibo?", "cual es la agencia mas cercana en tachira", "estoy en ciudad bolivar") COMO cuando te esta diciendo esa ciudad como parte de cerrar el pedido, aunque no te lo pregunte (ej. "en que ciudad esta" del paso 2 del pedido, o "me lo envias a cd bolivar", "mandalo a valencia", "vivo en la ciudad de merida"). En estos casos SIEMPRE llama a la herramienta antes de contestar: nunca digas frases como "necesito saber si hay una agencia ahi" sin haber llamado ya a la herramienta, la respuesta tiene que traer el resultado real, no una intencion de averiguarlo despues. Pasale SIEMPRE el estado de Venezuela (deducilo vos con tu conocimiento de la geografia del pais si el cliente solo nombro una ciudad), y ademas la ciudad puntual si el cliente dijo algo mas especifico que el estado. Si el cliente usa una abreviatura o forma corta (ej. "cd bolivar" = Ciudad Bolivar), reconocela igual. NO inventes direcciones de agencias, NO calcules distancias, dejale la busqueda real a la herramienta.
  - IMPORTANTE: si lo que dijo el cliente NO es un lugar real de Venezuela que reconozcas con confianza (una descripcion vaga como "un caserio alejado", "el campo", "bien lejos de todo", o cualquier cosa que no puedas ubicar en un estado concreto), NO llames a la herramienta y NO inventes ni adivines un estado al azar. En vez de eso, pedile al cliente que te confirme el nombre de su ciudad o estado para poder buscar la cobertura real.
  - NUNCA uses esa herramienta para numeros sueltos que sean cantidad de producto, telefono, respuestas de si/no, ni ningun otro dato del pedido que no sea explicitamente el nombre de un lugar. Un mensaje como "4" respondiendo cuantas unidades quiere NO es una zona.
  - Si la herramienta encuentra agencias en la ciudad puntual, presentaselas al cliente como una lista numerada (1., 2., 3., etc), cada una con nombre y direccion. Esta lista, sin importar cuantas agencias tenga, va SIEMPRE junta en un solo mensaje de WhatsApp (es un caso de "QUE NUNCA SE PARTE"): no dejes ningun renglon en blanco entre una agencia y la siguiente, usa un solo salto de linea, para que no se corte en varios mensajes.
  - Si la herramienta te avisa que en esa ciudad puntual no hay agencia pero si hay cobertura en el estado, decile al cliente claramente que a esa ciudad no llega de forma directa, pero que en el estado si hay agencias, y mostraselas numeradas igual (misma regla: todas juntas en un solo mensaje).
  - Si la herramienta no encuentra nada ni en la ciudad ni en el estado, decile que por ahora no hay cobertura confirmada ahi, sin inventar una direccion.
  - Si mas adelante el cliente se refiere a una de esas agencias por su numero o nombre (ej. "la cuatro", "la segunda", "esa de La Candelaria"), NO vuelvas a usar la herramienta: mirá la lista numerada que vos mismo mandaste antes en la conversacion, identifica cual eligio y confirmale la direccion de esa agencia puntual, preguntandole si le queda bien esa.
${libraryImagesText() ? `
  FOTOS DURANTE LA CHARLA:
  Estas son las imagenes cargadas en la biblioteca del negocio:
${libraryImagesText()}
  Podes mandar una de estas fotos en medio de la charla usando la herramienta mostrar_foto con el nombre EXACTO tal cual aparece arriba, pero SOLO cuando las instrucciones de un producto (arriba, en el catalogo) o la base de conocimiento del negocio te digan explicitamente que mandes esa foto en ese momento. Nunca la uses por iniciativa propia sin que te lo hayan indicado asi.` : ''}`;
}

// El modelo deberia usar ||| para marcar donde arranca un mensaje nuevo,
// pero en la practica (sobre todo con modelos "mini") a veces en vez de eso
// separa las ideas con un parrafo en blanco, como escribiria un humano en un
// editor de texto. Para no depender de que el modelo use el simbolo al pie
// de la letra, tratamos AMBAS cosas como limite de mensaje: ||| explicito, o
// dos o mas saltos de linea seguidos (un parrafo en blanco).
function splitReply(reply) {
  return String(reply || '')
    .split('|||')
    .flatMap((part) => part.split(/\n\s*\n+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

// Si un fragmento partido por ||| queda mas corto que minWords, no vale la
// pena mandarlo como mensaje aparte (se ve raro un WhatsApp de una sola
// palabra): se pega al fragmento de al lado. Se pega hacia el siguiente
// fragmento (para no romper un mensaje anterior ya "completo"); si es el
// ultimo fragmento, se pega hacia atras, al que ya se armo antes.
function mergeShortParts(parts, minWords) {
  if (!minWords || minWords <= 1 || parts.length <= 1) return parts;
  const merged = [];
  let carry = '';
  for (let i = 0; i < parts.length; i++) {
    const part = carry ? `${carry} ${parts[i]}`.trim() : parts[i];
    carry = '';
    const isLast = i === parts.length - 1;
    if (wordCount(part) < minWords && !isLast) {
      carry = part;
      continue;
    }
    if (wordCount(part) < minWords && isLast && merged.length) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${part}`.trim();
      continue;
    }
    merged.push(part);
  }
  if (carry) merged.push(carry);
  return merged;
}

// Aplica toda la politica de partido de mensajes (switch on/off, minimo de
// palabras, tope duro, maximo de partes) sobre el texto crudo que devolvio
// el modelo. Uso compartido por flow.js (WhatsApp real) y simulator.js (para
// que el simulador previsualice exactamente lo mismo que va a pasar de
// verdad).
function applySplitPolicy(text, settings) {
  const maxWordsHardCap = settings.maxWordsHardCap || 90;
  const maxParts = settings.maxMessageParts || 5;
  const splitEnabled = settings.splitRepliesEnabled !== false;
  const minWords = settings.splitMinWords ?? 3;

  let parts = splitReply(text);
  if (!splitEnabled) {
    parts = [parts.join(' ')];
  } else {
    parts = mergeShortParts(parts, minWords);
  }
  return enforceMessageLimits(parts, maxWordsHardCap, maxParts);
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

// Herramientas que el modelo puede invocar cuando decide, por el contexto de
// la charla, que corresponde buscar agencias o mandar una foto (nunca por su
// cuenta: el system prompt deja claro cuando usar cada una). El modelo elige
// CUANDO llamarlas; la busqueda/el envio real los hace este codigo, no el
// modelo.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_agencias_por_zona',
      description:
        'Busca agencias de envio disponibles segun el estado (y opcionalmente la ciudad puntual) que el cliente menciono porque quiere saber si hay cobertura ahi o quiere ver las agencias disponibles. No usar para cantidades, telefonos, confirmaciones ni otros datos del pedido.',
      parameters: {
        type: 'object',
        properties: {
          estado: {
            type: 'string',
            description:
              'El estado de Venezuela al que pertenece el lugar que menciono el cliente (ej. "Bolivar", "Zulia", "Tachira"). Si el cliente solo nombro una ciudad, deducilo vos con tu conocimiento de la geografia de Venezuela.',
          },
          ciudad: {
            type: 'string',
            description:
              'La ciudad, sector o zona puntual que nombro el cliente, si dijo algo mas especifico que el estado (ej. "Ciudad Bolivar", "Maracaibo"). Dejalo vacio si el cliente solo nombro el estado.',
          },
        },
        required: ['estado'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mostrar_foto',
      description:
        'Manda una foto de la biblioteca de imagenes del negocio durante la charla. Usar SOLO si las instrucciones de un producto o la base de conocimiento piden explicitamente mandar esa foto en ese momento. Nunca por iniciativa propia.',
      parameters: {
        type: 'object',
        properties: {
          nombre: {
            type: 'string',
            description: 'El nombre EXACTO de la imagen, tal cual aparece en la lista de imagenes disponibles del system prompt.',
          },
        },
        required: ['nombre'],
      },
    },
  },
];

// Busca primero por la ciudad puntual (si el cliente dijo una); si no
// encuentra nada ahi, cae al estado completo. Devuelve de donde salieron los
// resultados (scope) para que el mensaje al cliente sea preciso: no es lo
// mismo "esta es tu agencia" que "a tu ciudad no llega pero al estado si".
function searchAgenciesByZone(estado, ciudad) {
  const cityResults = ciudad ? agencies.searchByText(ciudad, 3) : [];
  if (cityResults.length) {
    return { scope: 'ciudad', results: cityResults };
  }
  const stateResults = estado ? agencies.searchByText(estado, 5) : [];
  if (stateResults.length) {
    return { scope: 'estado', results: stateResults };
  }
  return { scope: 'ninguno', results: [] };
}

// OJO: se unen con UN SOLO salto de linea entre agencia y agencia (nunca
// renglon en blanco). Esto es a proposito: el bot corta un mensaje nuevo en
// cada renglon en blanco (ver splitReply), y esta lista tiene que llegarle
// al cliente entera en un solo mensaje de WhatsApp. Si el modelo copia este
// mismo formato (sin blancos) en su respuesta final, la lista no se corta.
function formatAgencyList(results) {
  return results
    .map((a, i) => {
      const region = a.region ? ` — ${a.region}` : '';
      const phone = a.phone ? ` (Tel: ${a.phone})` : '';
      return `${i + 1}. ${a.name}${region}\n${a.address}${phone}`;
    })
    .join('\n');
}

// Arma el texto de resultado de la herramienta: lista numerada para que el
// modelo (y el propio historial de la charla) pueda despues resolver
// referencias tipo "la cuatro" sin volver a buscar. Distingue el caso
// "encontre justo en tu ciudad" del caso "en tu ciudad no, pero en tu estado
// si", que es el pedido puntual: nunca decir que no hay cobertura si el
// estado si la tiene. Todo el bloque (encabezado + lista) va con saltos de
// linea simples, nunca renglon en blanco: tiene que ser un solo mensaje.
function formatAgencyToolResult(estado, ciudad, scope, results) {
  if (scope === 'ciudad') {
    return `Agencias encontradas en "${ciudad}" (mandaselas todas juntas en un solo mensaje, sin renglones en blanco entre ellas):\n${formatAgencyList(results)}`;
  }
  if (scope === 'estado' && ciudad) {
    return (
      `No hay agencia puntual en "${ciudad}", pero si hay cobertura en el estado ${estado}. ` +
      `Decile al cliente que a esa ciudad no llega de forma directa, pero que en el estado si hay agencias, y mostraselas todas juntas en un solo mensaje (sin renglones en blanco entre ellas):\n` +
      formatAgencyList(results)
    );
  }
  if (scope === 'estado') {
    return `Agencias encontradas en el estado ${estado} (mandaselas todas juntas en un solo mensaje, sin renglones en blanco entre ellas):\n${formatAgencyList(results)}`;
  }
  const lugar = ciudad || estado;
  return `No se encontraron agencias ni en "${ciudad || ''}" ni en el estado ${estado}. Decile al cliente que por ahora no hay cobertura confirmada en ${lugar}, sin inventar una direccion.`;
}

// Busca la imagen por nombre exacto (como aparece en la biblioteca); si no
// hay match exacto, prueba una coincidencia parcial por si el modelo no
// copio el nombre letra por letra.
function findImageByName(nombre) {
  const q = String(nombre || '').trim().toLowerCase();
  if (!q) return null;
  let images = [];
  try {
    images = library.listImages();
  } catch (err) {
    images = [];
  }
  return (
    images.find((img) => String(img.name || '').trim().toLowerCase() === q) ||
    images.find((img) => String(img.name || '').trim().toLowerCase().includes(q)) ||
    null
  );
}

// Ejecuta una tool call del modelo y devuelve tanto el texto que va de vuelta
// al modelo (para que redacte la respuesta final) como, si corresponde, la
// imagen que hay que mandar de verdad por WhatsApp (eso lo hace el llamador
// de getAssistantReply: flow.js o simulator.js, no este archivo).
function runTool(call) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch (err) {
    args = {};
  }

  if (call.function.name === 'mostrar_foto') {
    const nombre = String(args.nombre || '').trim();
    const img = nombre ? findImageByName(nombre) : null;
    if (!img) {
      return { content: `No se encontro ninguna imagen llamada "${nombre}" en la biblioteca. No le digas al cliente que le mandaste una foto.`, image: null };
    }
    return { content: `Foto "${img.name}" enviada correctamente. Podes mencionarla con naturalidad si corresponde.`, image: img };
  }

  // buscar_agencias_por_zona (default: es la unica otra herramienta disponible)
  const estado = String(args.estado || '').trim();
  const ciudad = String(args.ciudad || '').trim();
  const { scope, results } = searchAgenciesByZone(estado, ciudad);
  return { content: formatAgencyToolResult(estado, ciudad, scope, results), image: null };
}

// Devuelve { text, images }: el texto que hay que mandar por WhatsApp, y la
// lista de imagenes (de la biblioteca) que el modelo decidio mandar durante
// la charla via la herramienta mostrar_foto. Quien llama a esta funcion
// (flow.js o simulator.js) es quien manda esas imagenes de verdad: este
// archivo solo decide el contenido, nunca habla directo con WhatsApp.
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
    tools: TOOLS,
  });

  const responseMessage = completion.choices[0].message;
  const toolCalls = responseMessage.tool_calls;

  if (!toolCalls || !toolCalls.length) {
    return { text: responseMessage.content.trim(), images: [] };
  }

  // El modelo decidio usar una o mas herramientas: las ejecutamos de verdad
  // (busqueda contra el CSV, o resolver el nombre de una imagen) y le
  // devolvemos el resultado como mensajes 'tool' para que arme la respuesta
  // final con esa info real.
  messages.push(responseMessage);
  const images = [];
  for (const call of toolCalls) {
    const result = runTool(call);
    if (result.image) images.push(result.image);
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: result.content,
    });
  }

  const followUp = await client().chat.completions.create({
    model,
    temperature,
    messages,
    tools: TOOLS,
  });

  return { text: followUp.choices[0].message.content.trim(), images };
}

module.exports = { getAssistantReply, splitReply, enforceMessageLimits, applySplitPolicy, buildSystemPrompt, catalogText };

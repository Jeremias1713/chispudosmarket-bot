// Cerebro conversacional del bot: arma el prompt de comportamiento, llama a
// OpenAI y decide como partir la respuesta en varios mensajes de WhatsApp.
const OpenAI = require('openai');
const { loadProducts } = require('./catalog');
const { getSettings } = require('./settings');
const agencies = require('./agencies');
const library = require('./library');
const { listCoupons } = require('./coupons');

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

// Lista los cupones activos (panel > Cupones) para que el modelo los pueda
// mencionar o aplicar naturalmente cuando corresponda, nunca inventar otros.
function couponsText() {
  let list = [];
  try {
    list = listCoupons().filter((c) => c.active !== false);
  } catch (err) {
    list = [];
  }
  if (!list.length) return '';
  return list
    .map((c) => `- ${c.code}: ${c.discountPercent}% de descuento. ${c.description || ''}`.trim())
    .join('\n');
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
  - El cliente pregunta por algo generico o ambiguo (dice "esa medicina", "el producto", "eso que vi", sin decir cual) y le tenes que preguntar a cual se refiere mencionando las opciones: el saludo/reaccion va en un mensaje, la aclaracion con las opciones en otro, y la pregunta de cierre en un tercero. NUNCA metas el saludo, la explicacion de las opciones y la pregunta de cierre los tres juntos en un solo mensaje largo, aunque entre todos no lleguen al tope de palabras: son tres ideas distintas (saludar/reaccionar, informar, preguntar) y cada una va en su propio mensaje.
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
  Otro ejemplo (pregunta ambigua sobre cual producto, caso muy comun: esto tiene que salir como TRES mensajes, no uno solo):
  "¡Hola! 😊

  Claro, tenemos Shilajit Viking y tambien Magnesio Triple, los dos te ayudan con la energia y el bienestar.

  ¿Te gustaria saber mas de alguno en particular?"
  Al reves: si algo tiene que ir en un SOLO mensaje (ver "QUE NUNCA SE PARTE" arriba: una direccion, el pedido de datos completo, una lista de precios/tallas, un dato que se rompe como un telefono), NO dejes ningun renglon en blanco adentro. Usa un solo salto de linea entre cada item de la lista, nunca dos seguidos, para que todo eso siga siendo un unico mensaje.`;
}

function buildSystemPrompt(knownCity, knownProduct, orderClosed, dataAlreadyRequested) {
  const settings = getSettings();
  const businessName = settings.businessName || process.env.BUSINESS_NAME || 'nuestro negocio';
  const knowledge = (settings.knowledgeBase || '').trim();
  const maxWords = settings.maxWordsPerMessage || 30;
  const maxWordsHardCap = settings.maxWordsHardCap || 90;
  const maxParts = settings.maxMessageParts || 5;
  const splitEnabled = settings.splitRepliesEnabled !== false;
  const knownCityClean = String(knownCity || '').trim();
  const knownProductClean = String(knownProduct || '').trim();
  // Texto EXACTO que el bot manda para pedir nombre/cedula/telefono cuando
  // retira en agencia. Editable desde Configuracion (Configuracion > "Texto
  // para pedir los datos del pedido"); si no se cargo nada ahi, usa este por
  // defecto. OJO: si se cambian las ETIQUETAS (Nombre/Cedula/Telefono), hay
  // que revisar tambien looksLikeEmptyDataRequest mas abajo en este mismo
  // archivo: el sistema que evita que el bot lo pida dos veces en la misma
  // conversacion busca esas palabras puntuales en la respuesta.
  const dataRequestTemplate = (settings.dataRequestTemplate && settings.dataRequestTemplate.trim())
    || '📦 Para procesar tu pedido envíanos:\n👤 Nombre y apellido:\n🆔 Cédula:\n📞 Teléfono:\n🚚 Enviaremos tu pedido GRATIS por Tealca a la oficina más cercana';

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

  REGLA DE ORO: termina siempre tu respuesta con una pregunta que haga avanzar la venta (el siguiente dato que falta, o confirmar algo), EXCEPTO cuando el pedido de este cliente ya quedo cerrado (ver mas abajo si hay un DATO YA CONFIRMADO de pedido cerrado): ahi esta regla queda APAGADA para el resto de la conversacion, no la reactives ni inventes una pregunta de venta nueva solo por costumbre.

  PRIORIDAD (que va primero):
  1. Contesta lo que te acaban de decir. Si pregunto algo, contestalo. Si conto algo, reconocelo. Esto le gana a cualquier guion de producto o a seguir pidiendo datos.
  2. No le preguntes algo que ya te contesto. Mira la conversacion antes de preguntar.
  3. Recien despues de (1) y (2): segui con el dato que falta del pedido.
  4. Las preguntas de calificacion o de interes que puedan venir en las instrucciones de un producto (por ejemplo, preguntarle si busca tal beneficio o tal otro) SOLO sirven para abrir la charla, ANTES de que el cliente te de el primer dato del pedido. En cuanto el cliente ya te dio cualquier dato del pedido (te dijo la ciudad, cuantos quiere, o cualquier otro de la lista de "COMO SE ARMA EL PEDIDO" mas abajo), NUNCA vuelvas para atras a una pregunta de calificacion del producto: seguí siempre para adelante con el guion de armar el pedido. Ejemplo tipico de este error, que hay que evitar: el cliente te dice en que ciudad esta y en vez de seguir con el paso que corresponde (domicilio/agencia segun ENTREGA) le repreguntas algo del tipo "¿buscas mas energia o mejorar tu rendimiento?": eso esta mal, ya paso el momento de esa pregunta.
  5. Si un mensaje del cliente es exactamente "[sticker]", es porque mando un sticker de WhatsApp (no se puede leer que dice). En la practica, la gran mayoria de las veces un sticker es solo su forma de decir "si, dale, esta bien, ok", asi que asumilo asi y segui la conversacion para adelante con naturalidad, como si te hubiera dicho que si. La UNICA excepcion es si tu mensaje anterior le pedia un dato puntual en texto que un sticker no puede reemplazar (por ejemplo nombre y apellido, cedula, telefono, cuantos quiere, en que ciudad esta, o el nombre/numero de una agencia de la lista): en ese caso especifico no asumas el dato, decile con onda que te lo escriba porque necesitas ese dato exacto.
${knownCityClean ? `\n  DATO YA CONFIRMADO (viene de la ficha del cliente, no de lo que ves en el historial reciente): el cliente ya dijo antes que esta en "${knownCityClean}". NUNCA le vuelvas a preguntar la ciudad o el estado, usa este dato directamente para buscar la agencia o definir domicilio/agencia. Solo si el mismo cliente menciona una ciudad distinta, usa esa nueva en su lugar.\n` : ''}${dataAlreadyRequested ? `\n  DATO YA CONFIRMADO, MUY IMPORTANTE: en esta conversacion YA le mandaste el mensaje pidiendo nombre y apellido, cedula y telefono (el bloque de "Para procesar tu pedido envianos"). NUNCA vuelvas a mandar ese bloque de nuevo, ni completo ni parecido, aunque el cliente todavia no te haya contestado con esos datos, aunque haya pasado tiempo, o aunque te mande un sticker, un "ok" u otro mensaje corto. Si todavia no te paso esos datos y te escribe algo que no son los datos, contestale lo que corresponda a ese mensaje y como mucho agregale un recordatorio CORTO en una sola frase (por ejemplo "cuando puedas pasame esos datos para procesar tu pedido"), nunca repitas el bloque completo con nombre/cedula/telefono de nuevo. En cuanto identifiques los tres datos en lo que te escribio, seguí al mensaje de cierre del pedido normalmente.\n` : ''}${knownProductClean ? `\n  DATO YA CONFIRMADO: ya se le presento el producto "${knownProductClean}" y la conversacion sigue sobre ese mismo producto. NUNCA le preguntes "que producto queres" ni nada parecido: sabes cual es. Si todavia no sabes cuantos quiere, tu UNICA pregunta pendiente sobre el pedido es la cantidad, nunca el producto. Ejemplo de error que NO tenes que cometer (esto ya paso una vez, no lo repitas): despues de resolver la agencia o la ciudad, cerrar la respuesta con algo como "¿que producto te gustaria pedir y cuantos frascos quieres?" esta MAL, porque el producto ya se sabe; lo correcto ahi es preguntar solo "¿cuantos frascos queres pedir?" (o similar, sin mencionar "que producto"). Esto vale tambien justo despues de usar la herramienta buscar_agencias_por_zona: la pregunta que sigue a la lista de agencias tiene que ser sobre la cantidad, nunca sobre el producto. Si el cliente menciona otro producto distinto, ahi si cambia el producto del que estan hablando.\n` : ''}${orderClosed ? `\n  DATO YA CONFIRMADO, EL MAS IMPORTANTE DE TODOS AHORA MISMO: el pedido de este cliente YA ESTA CERRADO (ya se mando el mensaje de cierre con el resumen, el pago contra entrega y lo de la guia de Tealca). Esto cambia como contestas TODO lo que venga ahora:\n  - La REGLA DE ORO de terminar con una pregunta de venta queda APAGADA. No la reactives.\n  - Si el cliente pregunta algo suelto del producto (por ejemplo si sirve para algo, como se toma, cuanto dura), contestale la pregunta con la info real y PARA AHI. No le agregues "¿te gustaria apartar tu frasco?", "¿te aparto uno?", "¿cuantos queres pedir?" ni ninguna frase de venta: el ya lo pidio, no hay nada que apartar de nuevo.\n  - No vuelvas a pedir ningun dato del pedido (producto, cantidad, ciudad, agencia, nombre, cedula, telefono): ya los tenes todos.\n  - Si te saluda o dice algo corto como "gracias" u "ok", contestale corto y calido, sin reabrir el pedido.\n  - Solo si el cliente dice explicitamente que quiere agregar otro producto, cambiar algo del pedido, o hacer un pedido nuevo, ahi si volves al guion normal de armar un pedido (y ese pedido nuevo es el que queda "abierto" de ahi en adelante).\n` : ''}

  ENTREGA: depende de la ciudad.
  - CARACAS (Distrito Capital, incluye todos sus municipios/parroquias): hay dos formas de recibirlo, domicilio (te lo llevan hasta la puerta) o retiro en agencia. Ofrecele PRIMERO la opcion de domicilio, es la mas comoda para el cliente, y si prefiere retirar en agencia esa tambien esta disponible.
  - RESTO DE VENEZUELA (todos los demas estados, Maracaibo incluida): SOLO se retira en agencia (TEALCA), no hay entrega a domicilio ahi. Si un cliente fuera de Caracas pide que se lo lleven a la casa, decile con naturalidad que fuera de Caracas por ahora solo se retira en agencia, no ofrezcas ni prometas domicilio en esos casos, y segui ayudandolo a elegir la agencia mas cercana.
  - MARACAIBO (estado Zulia): ademas de la agencia Tealca, ahi tambien hay tienda fisica propia del negocio. Si el cliente esta en Maracaibo, o pregunta puntualmente por Maracaibo (si hay tienda ahi, si pueden retirar en persona, direccion del local, etc), contale con naturalidad que ademas de Tealca tambien tienen local propio, y pasale la direccion: Palacio de Eventos, local PBG-16, Maracaibo, estado Zulia 🙏🏻. Dala como un dato mas de la conversacion (con algun emoji si corresponde, tipo 📍), no como una lista fria. Esto es informacion SOLO para Maracaibo puntual, no para el resto del Zulia ni del pais: en cualquier otra ciudad segui con la agencia Tealca como unica opcion.

  COMO SE ARMA EL PEDIDO:
  Antes que nada, fijate si el cliente ya mostro interes real en comprar (pregunto por un producto, dijo que lo quiere, o vos ya se lo presentaste y sigue la charla). Si todavia no, no le pidas ciudad ni datos del pedido, primero entendes que necesita o le presentas el catalogo.
  Cuando ya hay interes real, necesitas estos datos, en este orden, de a uno por vez:
  1. Que producto quiere y cuantos. Si el cliente ya dijo la cantidad en algun momento de la conversacion (aunque haya sido hace varios mensajes), usa esa cantidad y NUNCA se la vuelvas a preguntar. Preguntale la cantidad SOLO si todavia no la dijo.
  2. En que ciudad esta.
  3. Segun la ciudad (ver ENTREGA arriba):
     - Si es Caracas: preguntale si prefiere domicilio o agencia (ofrecele domicilio primero). Si elige domicilio, pedile la direccion exacta con un punto de referencia. Si elige agencia, buscale las agencias con buscar_agencias_por_zona y que te confirme cual le queda bien (ver AGENCIAS Y COBERTURA).
     - Si es cualquier otra ciudad: buscale la agencia mas cercana con buscar_agencias_por_zona y que te confirme cual le queda bien (ver AGENCIAS Y COBERTURA). NUNCA pidas direccion exacta ni punto de referencia fuera de Caracas: no hace falta, todo se retira en agencia, y la unica direccion que existe ahi es la de la agencia (que vos ya le diste), nunca la del cliente.
     - IMPORTANTE: en cuanto la agencia (o la modalidad domicilio/agencia en Caracas) ya quedo resuelta, esa parte del pedido esta cerrada para siempre en esta conversacion. NUNCA vuelvas a mencionarla como un dato pendiente, ni le vuelvas a pedir que la confirme o que te de una direccion, salvo que el cliente mismo diga que cambio de ciudad o quiere otra agencia.
  4. Nombre y apellido, telefono y cedula: una vez que ya sabes el producto+cantidad y ya quedo resuelta la entrega (paso 3), pedi estos tres datos juntos, en un solo pedido (no de a uno), usando EXACTAMENTE este texto, en un UNICO mensaje de WhatsApp (no le cambies ni una palabra, ni el orden, ni le agregues nada, y no le pongas nada antes tipo "necesito estos datos": eso ya queda dicho en este mismo mensaje, ponerlo dos veces se ve repetido):

${dataRequestTemplate}

     Esto aplica cuando el cliente retira en agencia (Tealca). Si es domicilio en Caracas, pedi los mismos tres datos (nombre y apellido, telefono, cedula) juntos en un solo mensaje pero con tus propias palabras, sin mencionar Tealca ni oficina (ya tiene la direccion con punto de referencia).
     Cuando el cliente te conteste con esos datos, leelos con cuidado y fijate bien cual valor es cual aunque los mande en un orden distinto al que pediste, o todos juntos en un solo mensaje: el nombre es texto con letras, el telefono venezolano tiene 10 u 11 digitos (suele empezar con 0 o con 4), la cedula tiene entre 6 y 9 digitos. Si el cliente dice algo como "la direccion que me pasaste" o similar, es solo una confirmacion de la agencia/direccion, no un dato nuevo, no lo cuentes como si faltara. En cuanto identifiques nombre, telefono y cedula (aunque hayan llegado mezclados en un mismo mensaje o en un orden distinto), da esos tres datos por completos y NUNCA le vuelvas a pedir ninguno de ellos.
  Si te dice una cantidad sin precio confirmado, nunca inventes ni calcules el precio total: segui tomando los datos y decile que confirmas el precio exacto en un momento.
  Si no sabes un precio, un plazo de envio o un dato del producto, decilo asi de simple: que lo confirmas en un momento. Nunca lo inventes.
  Si el cliente pide hablar con una persona, se queja o reclama algo serio, decile que ya lo pasas con un asesor humano y no sigas insistiendo con el guion de venta.

  CIERRE DEL PEDIDO:
  Cuando ya tenes todos los datos (producto y cantidad, como lo va a recibir -agencia elegida, o direccion con punto de referencia si es domicilio en Caracas-, nombre y apellido, telefono, cedula), el mensaje de cierre tiene que incluir, en este orden:
  1. Un resumen de lo que pidio (incluyendo la agencia donde va a retirar, o la direccion si es domicilio).
  2. Que el pago se hace contra entrega: en la agencia, al momento de retirar (o en la puerta, si es domicilio en Caracas). NUNCA digas que "un asesor se va a poner en contacto para coordinar el pago": eso no es asi, el pago no se coordina antes, se paga ahi mismo al recibirlo.
  3. Que en cuanto tengan la guia de envio de Tealca se la van a pasar, y que le avisan apenas el pedido llegue a la agencia (o este en camino, si es domicilio).
  No prometas una fecha ni un tiempo de entrega exacto: eso lo confirma la guia de Tealca cuando la tengan.
  Usa 1 o 2 emojis en este mensaje para que se sienta cercano y de confirmacion (por ejemplo ✅📦🚚), no lo mandes en texto plano y seco.
  IMPORTANTE, esto es innegociable: ese mensaje de cierre es LO ULTIMO que decis sobre este pedido. Nunca mandes un mensaje aparte despues con cosas como "¡Listo! Todo esta confirmado" ni "¿Hay algo mas en lo que te pueda ayudar?" ni ninguna otra variante de esa pregunta: eso contradice la REGLA DE ORO (ya esta todo cerrado, no hace falta inventar una pregunta ni una confirmacion de relleno). Si el cliente te contesta despues con algo corto como "gracias" o "ok", ahi si podes responder algo breve y calido, pero nunca reabras el pedido con esa pregunta de cierre de servicio.
  DESPUES DEL CIERRE: una vez que el pedido ya quedo cerrado en esta conversacion, el cliente ya lo compro, no hay nada mas que venderle. Si despues sigue preguntando cosas sueltas sobre el producto (por ejemplo "¿esto sirve para tal cosa?", "¿cuanto dura?"), contestale la pregunta con la info real y nada mas. NUNCA le agregues de nuevo preguntas o frases de venta como "¿te gustaria apartar tu frasco?", "¿cuantos queres pedir?" ni parecidas: eso suena a que no te acordas que ya hizo el pedido. Si el cliente dice explicitamente que quiere agregar algo mas o cambiar el pedido, ahi si retomas el guion de pedido normal.

  CATALOGO ACTUAL (unica fuente de precios y productos, no inventes otros):
  ${catalogText()}
${knowledge ? `\n  DATOS DEL NEGOCIO QUE DAS POR CIERTOS (envio, pago, promos vigentes):\n  ${knowledge}\n` : ''}${couponsText() ? `
  CUPONES DE DESCUENTO VIGENTES (unicos validos, no inventes otros):
${couponsText()}
` : ''}
  AGENCIAS Y COBERTURA:
  - Si el cliente comparte su ubicacion GPS, el sistema ya se encarga de mostrarle las agencias mas cercanas automaticamente: vos no necesitas hacer nada en ese caso.
  - Cuando el cliente nombra una ciudad, estado o zona por CUALQUIER motivo relacionado a donde le llega el pedido, usa la herramienta buscar_agencias_por_zona. Esto incluye tanto cuando pregunta explicitamente por cobertura (ej. "soy de bolivar", "tienen envios a maracaibo?", "cual es la agencia mas cercana en tachira", "estoy en ciudad bolivar") COMO cuando te esta diciendo esa ciudad como parte de cerrar el pedido, aunque no te lo pregunte (ej. "en que ciudad esta" del paso 2 del pedido, o "me lo envias a cd bolivar", "mandalo a valencia", "vivo en la ciudad de merida"). En estos casos SIEMPRE llama a la herramienta antes de contestar: nunca digas frases como "necesito saber si hay una agencia ahi", "te busco la agencia mas cercana", "dame un momentito" o "ya te paso la direccion" sin haber llamado YA a la herramienta EN ESE MISMO turno: la respuesta tiene que traer el resultado real (la lista de agencias, o el aviso de que no hay cobertura), nunca una promesa de averiguarlo despues o "en un momento". Esto paso de verdad (le prometiste a un cliente de Barinas "te busco la agencia mas cercana, dame un momentito" y nunca le llegaste a mandar nada mas: quedo esperando sin respuesta y la venta se perdio) — NUNCA vuelvas a dejar una promesa de este tipo sin cumplirla en el mismo mensaje. Pasale SIEMPRE el estado de Venezuela (deducilo vos con tu conocimiento de la geografia del pais si el cliente solo nombro una ciudad), y ademas la ciudad puntual si el cliente dijo algo mas especifico que el estado. Si el cliente usa una abreviatura o forma corta (ej. "cd bolivar" = Ciudad Bolivar), reconocela igual. NO inventes direcciones de agencias, NO calcules distancias, dejale la busqueda real a la herramienta.
  - IMPORTANTE: si lo que dijo el cliente NO es un lugar real de Venezuela que reconozcas con confianza (una descripcion vaga como "un caserio alejado", "el campo", "bien lejos de todo", o cualquier cosa que no puedas ubicar en un estado concreto), NO llames a la herramienta y NO inventes ni adivines un estado al azar. En vez de eso, pedile al cliente que te confirme el nombre de su ciudad o estado para poder buscar la cobertura real.
  - NUNCA uses esa herramienta para numeros sueltos que sean cantidad de producto, telefono, respuestas de si/no, ni ningun otro dato del pedido que no sea explicitamente el nombre de un lugar. Un mensaje como "4" respondiendo cuantas unidades quiere NO es una zona.
  - Si la herramienta encuentra agencias en la ciudad puntual, presentaselas al cliente como una lista numerada (1., 2., 3., etc), cada una con nombre y direccion, con TODAS las agencias que encontro la herramienta en esa ciudad (nunca le muestres solo algunas si hay mas disponibles: si pregunta por las agencias, la lista tiene que ser la completa). Esta lista, sin importar cuantas agencias tenga, va SIEMPRE junta en un solo mensaje de WhatsApp (es un caso de "QUE NUNCA SE PARTE"): no dejes ningun renglon en blanco entre una agencia y la siguiente, usa un solo salto de linea, para que no se corte en varios mensajes.
  - Si el cliente todavia no te dijo una ciudad puntual, solo un estado (o una zona muy amplia), buscale por estado directamente: no le muestres una lista de una ciudad que vos elegiste por tu cuenta, dejá que la herramienta busque por el estado completo.
  - Si la herramienta te avisa que en esa ciudad puntual no hay agencia pero si hay cobertura en el estado, decile al cliente claramente que a esa ciudad no llega de forma directa, pero que en el estado si hay agencias, y mostraselas numeradas igual (misma regla: todas juntas en un solo mensaje).
  - Si la herramienta no encuentra nada ni en la ciudad ni en el estado, decile que por ahora no hay cobertura confirmada ahi, sin inventar una direccion.
  - Si mas adelante el cliente se refiere a una de esas agencias por su numero o nombre (ej. "la cuatro", "la segunda", "esa de La Candelaria"), NO vuelvas a usar la herramienta: mirá la lista numerada que vos mismo mandaste antes en la conversacion, identifica cual eligio y confirmale la direccion de esa agencia puntual, preguntandole si le queda bien esa.
  - NUNCA repitas la lista completa de agencias ni la pregunta de "¿cual te queda bien?" dos veces seguidas en la misma conversacion sin que haya pasado algo nuevo. Si ya se la mandaste una vez, no la vuelvas a mandar de nuevo salvo que el cliente la pida de nuevo explicitamente (ej. "mandamela otra vez", "cuales eran"). Antes de responder, fijate en el historial si la ULTIMA lista de agencias que vos mandaste es igual a la que estarias por mandar ahora: si es asi, no la repitas, contesta puntualmente lo que el cliente esta preguntando ahora en su lugar.
  - Si ninguna de las agencias que le ofreciste le queda bien (dice que le queda lejos, que prefiere otra zona, etc.), NO le repitas la misma lista de nuevo: pregunta por otra ciudad/zona mas puntual y usa la herramienta con ese nuevo dato, o si no hay otra opcion cercana, decile con sinceridad que por ahora esa es la cobertura disponible en su zona y que capaz alguien del equipo pueda revisar otra alternativa.
  - Si el cliente pregunta puntualmente por un servicio de envio o mensajeria que EL NEGOCIO NO OFRECE (por ejemplo MRW, Zoom, un delivery propio, o que se lo mandes directo a una ciudad sin agencia), contestale con sinceridad que el envio es unicamente por la agencia (Tealca) a las direcciones que le pasaste, que el negocio no gestiona otros couriers, y ofrecele elegir la agencia mas conveniente de la lista. NUNCA ignores esa pregunta ni contestes repitiendo la lista de agencias como si no te hubiera preguntado nada: primero respondele eso puntual, y recien despues, si corresponde, volvé a la pregunta de que agencia le queda mejor (sin repetir la lista entera si ya se la mandaste).
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

// Red de seguridad de codigo, ademas de las instrucciones del prompt (ver
// splitInstructions): el prompt le pide al modelo mandar el saludo ("Hola!")
// en su propio mensaje, separado de lo que sigue, pero en la practica no
// siempre lo respeta y termina pegando el saludo con la explicacion o la
// pregunta (ej. "¡Hola! 😊 Claro, ¿a que medicina te refieres?..."), lo que
// se ve como un solo mensaje largo en vez de varios cortos. Esto detecta ese
// patron puntual (arranca con "hola", nada mas, para evitar falsos
// positivos con palabras como "buenas noticias") y fuerza el corte aca, sin
// depender 100% de que el modelo lo haga bien cada vez.
function splitLeadingGreeting(text) {
  const re = /^(\s*[¡]?hola[!¡.,]?\s*(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]\s*)*)([\s\S]+)$/iu;
  const m = String(text || '').match(re);
  if (!m) return null;
  const greeting = m[1].trim();
  const rest = m[2].trim();
  if (!greeting || !rest) return null;
  return [greeting, rest];
}

// Red de seguridad igual que splitLeadingGreeting pero para el otro extremo
// del mensaje: el prompt le pide al modelo (REGLA DE ORO y las demas reglas
// de partido) que la pregunta con la que cierra vaya siempre sola, en su
// propio mensaje, pero en la practica a veces la deja pegada despues de una
// oracion en el mismo fragmento (ej. "Genial, tenemos envios ahi. ¿Prefieres
// domicilio o agencia?" como un solo mensaje en vez de dos). Esto detecta una
// pregunta (arranca con ¿) pegada al final de un fragmento que tiene texto
// antes, y la separa en su propio mensaje. Nunca toca la lista de agencias
// (esa siempre va entera, sin excepciones).
function splitTrailingQuestion(text) {
  const t = String(text || '').trim();
  if (!t || isAgencyListBlock(t)) return null;
  const idx = t.lastIndexOf('¿');
  if (idx <= 0) return null; // sin "¿", o la pregunta ya es todo el mensaje
  const before = t.slice(0, idx).trim();
  const question = t.slice(idx).trim();
  if (!before || !question || !question.includes('?')) return null;
  if (before.endsWith('?')) return null; // ya hay otra pregunta antes, mejor no tocarlo
  return [before, question];
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
    // Red de seguridad ademas de las instrucciones del prompt: el cliente
    // pidio que la lista de agencias SIEMPRE vaya en un solo mensaje de
    // WhatsApp. El modelo no siempre respeta al 100% "no dejes renglones en
    // blanco", asi que si igual llegan a quedar varias partes que son items
    // de una lista numerada (1., 2., 3., ...), las volvemos a pegar aca.
    parts = mergeAgencyListParts(parts);
    // Se revisa el primer fragmento DESPUES de mergeShortParts (no antes):
    // si se hiciera antes, mergeShortParts pegaria el saludo de vuelta con
    // lo que sigue porque "¡Hola! 😊" por si solo tiene menos palabras que
    // el minimo (se ve raro un WhatsApp de una sola palabra), justo el
    // efecto contrario al que se busca aca.
    if (parts.length) {
      const split = splitLeadingGreeting(parts[0]);
      if (split) parts = [split[0], split[1], ...parts.slice(1)];
    }
    // Igual que el saludo, pero al reves: se revisa el ULTIMO fragmento,
    // tambien despues de mergeShortParts/mergeAgencyListParts, para que la
    // pregunta de cierre quede sola aunque el modelo la haya pegado a la
    // oracion anterior (o aunque mergeShortParts la hubiera pegado hacia
    // atras por ser corta).
    if (parts.length) {
      const lastIdx = parts.length - 1;
      const qsplit = splitTrailingQuestion(parts[lastIdx]);
      if (qsplit) parts = [...parts.slice(0, lastIdx), qsplit[0], qsplit[1]];
    }
  }
  return enforceMessageLimits(parts, maxWordsHardCap, maxParts);
}

// Une en un solo mensaje cualquier corrida de partes consecutivas que
// empiecen con un item de lista numerada (1. , 2. , 3. , ...): es la forma
// en la que se presentan las agencias (ver formatAgencyList). Si el modelo
// termino separando "1. Agencia A" y "2. Agencia B" en mensajes distintos
// (por un ||| de mas o un renglon en blanco), esto los vuelve a juntar.
function looksLikeListItemStart(text) {
  return /^\s*\d+[.)]\s/.test(String(text || ''));
}
function mergeAgencyListParts(parts) {
  const merged = [];
  let i = 0;
  while (i < parts.length) {
    if (looksLikeListItemStart(parts[i])) {
      const block = [parts[i]];
      let j = i + 1;
      while (j < parts.length && looksLikeListItemStart(parts[j])) {
        block.push(parts[j]);
        j++;
      }
      merged.push(block.join('\n'));
      i = j;
    } else {
      merged.push(parts[i]);
      i++;
    }
  }
  return merged;
}

// Un bloque de texto "es" una lista de agencias si tiene al menos dos items
// numerados seguidos (1. ... y 2. ...). A estos bloques no les aplicamos el
// tope de palabras por mensaje (chunkByWords): cortarlos a la mitad rompe la
// regla de "siempre en un solo mensaje", y en la practica nunca son tantas
// agencias como para que el mensaje sea un problema real de WhatsApp.
function isAgencyListBlock(text) {
  return /(^|\n)\s*1[.)]\s[\s\S]*(^|\n)\s*2[.)]\s/m.test(String(text || ''));
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
    if (isAgencyListBlock(part)) {
      // Nunca cortamos una lista de agencias a la mitad por el tope de
      // palabras: tiene que llegar siempre entera en un solo mensaje.
      chunks.push(part);
      continue;
    }
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
// OJO: antes esto cortaba en 3 agencias por ciudad. El cliente pidio
// explicitamente que, cuando pregunten por las agencias, se les pase la
// lista COMPLETA de la ciudad (no solo algunas), asi que el limite ahora es
// alto a proposito (no hay tantas agencias por ciudad como para que esto
// sea un problema de tamano de mensaje real).
function searchAgenciesByZone(estado, ciudad) {
  const cityResults = ciudad ? agencies.searchByText(ciudad, 50) : [];
  if (cityResults.length) {
    return { scope: 'ciudad', results: cityResults };
  }
  const stateResults = estado ? agencies.searchByText(estado, 50) : [];
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

// Red de seguridad de codigo (aparte de la instruccion en el prompt de mas
// arriba): esto paso de verdad una vez — el modelo le prometio a un cliente
// "te busco la agencia mas cercana, dame un momentito" y nunca llamo a la
// herramienta ni le mando la lista real, dejando al cliente esperando una
// respuesta que nunca llego (ver detectPendingAgencyPromise en flow.js, que
// llama a esta funcion cuando detecta esa promesa incumplida). Arma
// directamente, sin pasar por el modelo, el mensaje con la lista real de
// agencias para la ciudad que ya se sabe de la sesion, usando la misma
// busqueda (y el mismo reconocimiento de ciudades conocidas) que usa la
// herramienta. Devuelve null si no hay ciudad conocida o no encontro nada
// (en ese caso no se manda nada extra, para no inventar informacion).
// Arma el mensaje final (el que se le manda de verdad al cliente) para una
// busqueda de agencias ya resuelta. Se separa de buildDirectAgencyMessage
// para poder reusarla tambien como red de seguridad de completitud (ver
// getAssistantReply mas abajo): ambos casos ya tienen el scope/resultados
// resueltos, solo hace falta redactar el texto.
function buildAgencyListMessage(scope, estado, ciudad, results) {
  if (scope === 'ciudad') {
    return `Aquí tienes las agencias disponibles en ${ciudad}:\n${formatAgencyList(results)}\n\n¿Cuál de estas te queda mejor para retirar tu pedido?`;
  }
  return (
    `A esa ciudad puntual no llega de forma directa, pero en el estado ${estado} sí hay cobertura:\n` +
    `${formatAgencyList(results)}\n\n¿Cuál de estas te queda mejor para retirar tu pedido?`
  );
}

function buildDirectAgencyMessage(ciudadConocida) {
  if (!ciudadConocida) return null;
  const cityKey = agencies.findKnownCityKey(ciudadConocida);
  const estado = cityKey ? agencies.resolveStateForCity(cityKey) : null;
  const ciudad = cityKey || ciudadConocida;
  const { scope, results } = searchAgenciesByZone(estado, ciudad);
  if (!results.length) return null;
  return buildAgencyListMessage(scope, estado, ciudad, results);
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
  const estadoDelModelo = String(args.estado || '').trim();
  const ciudadDelModelo = String(args.ciudad || '').trim();
  // Si dentro de lo que mando el modelo como "ciudad" reconocemos una de
  // nuestras ciudades conocidas (agencies.findKnownCityKey), usamos esa
  // ciudad "limpia" (y su estado real) por encima de lo que haya mandado el
  // modelo. Esto cubre dos fallas reales que ya pasaron: (1) el modelo
  // "confundio" el estado de una ciudad real (Maturin a Monagas, Guasdalito
  // a Merida) en vez de pedir que se la confirmen, y (2) el modelo mando la
  // frase completa del cliente como ciudad (ej. "San Carlos Cojedes
  // Venezuela" en vez de solo "San Carlos"), lo que hacia que ni la busqueda
  // por ciudad ni el diccionario de estados reconocieran nada y el bot
  // terminaba mandando agencias de un estado totalmente distinto (le llego a
  // mandar las agencias de Caracas a un cliente de San Carlos, Cojedes).
  const ciudadConocida = agencies.findKnownCityKey(ciudadDelModelo);
  const estado = (ciudadConocida && agencies.resolveStateForCity(ciudadConocida)) || estadoDelModelo;
  const ciudad = ciudadConocida || ciudadDelModelo;
  const { scope, results } = searchAgenciesByZone(estado, ciudad);
  // agencyResult va aparte del texto para el modelo: lo usa getAssistantReply
  // como red de seguridad de completitud (ver mas abajo), sin tener que
  // volver a parsear el texto de la herramienta.
  return { content: formatAgencyToolResult(estado, ciudad, scope, results), image: null, agencyResult: { scope, estado, ciudad, results } };
}

// Devuelve { text, images }: el texto que hay que mandar por WhatsApp, y la
// lista de imagenes (de la biblioteca) que el modelo decidio mandar durante
// la charla via la herramienta mostrar_foto. Quien llama a esta funcion
// (flow.js o simulator.js) es quien manda esas imagenes de verdad: este
// archivo solo decide el contenido, nunca habla directo con WhatsApp.
// Red de seguridad ademas de la instruccion en el prompt: el modelo NO
// siempre respeta al 100% una instruccion de "nunca uses esta palabra"
// (es una regla probabilistica, no un filtro), y el cliente pidio
// explicitamente que la palabra "genial" quede prohibida siempre. Esto
// la reemplaza de forma determinista por si se cuela igual.
// Deteccion deterministica de si un texto ES el mensaje de cierre del
// pedido (ver CIERRE DEL PEDIDO en el prompt). No dependemos de que el
// clasificador por IA (aparte, async, y no siempre acierta) marque la etapa
// como "vendido": eso demostro ser poco confiable en la practica (el cliente
// seguia recibiendo la pregunta de venta despues del cierre porque la etapa
// nunca se marcaba). En cambio, miramos el propio texto que el bot ya
// generó: el mensaje de cierre siempre tiene que mencionar el pago contra
// entrega y la guia de Tealca (instrucciones de arriba), asi que buscamos
// esas señales directamente, sin acentos y en minuscula para no fallar por
// mayusculas/tildes.
function isClosingMessage(text) {
  const norm = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return norm.includes('tealca') && norm.includes('pago') && norm.includes('guia');
}

// Red de seguridad igual en espiritu a isClosingMessage: el prompt le pide al
// modelo pedir nombre+cedula+telefono UNA sola vez (ver "COMO SE ARMA EL
// PEDIDO" punto 4), pero en la practica a veces igual lo repite (por ejemplo
// si el cliente contesta con un sticker o algo corto en vez de los datos, o
// si simplemente se confunde). Esto detecta el patron de "pedido de datos
// vacio": los tres campos (nombre, cedula, telefono) aparecen como etiqueta
// seguida de dos puntos SIN nada despues en la misma linea, que es como se
// ve tanto la plantilla fija de Tealca como la version con palabras propias
// para domicilio. Un mensaje de CIERRE que ya trae los datos rellenos (ej.
// "Nombre: Juan Perez") no matchea, porque ahi despues de los dos puntos hay
// texto en la misma linea, no un salto de linea vacio.
function looksLikeEmptyDataRequest(text) {
  const t = String(text || '');
  const emptyFieldRe = /(nombre[^:\n]*|c[e\u00e9]dula|tel[e\u00e9]fono)\s*:[ \t]*(?:\r?\n|$)/gi;
  const matches = t.match(emptyFieldRe) || [];
  return matches.length >= 2;
}

// Mensaje corto de repuesto para cuando ya se pidieron los datos antes y el
// modelo, a pesar de la instruccion, intento mandar el bloque completo de
// nuevo: en vez de repetir todo el pedido de datos, se manda solo este
// recordatorio breve.
const DATA_REQUEST_REMINDER = 'Cuando puedas, pasame tu nombre completo, cedula y telefono para terminar de procesar tu pedido \ud83d\ude4f';

// Saca del texto (separado en partes igual que splitReply) cualquier
// fragmento que sea un pedido de datos vacio repetido. Si despues de sacarlo
// no queda nada, devuelve null (el que llama decide que mandar en su lugar,
// ver DATA_REQUEST_REMINDER). Si no habia nada que sacar, devuelve el texto
// tal cual.
function stripDuplicateDataRequest(text) {
  const parts = splitReply(text);
  const filtered = parts.filter((p) => !looksLikeEmptyDataRequest(p));
  if (!filtered.length) return null;
  if (filtered.length === parts.length) return text;
  return filtered.join('\n\n');
}

const GENIAL_REPLACEMENTS = ['que bueno', 'perfecto', 'buenisimo', 'dale', 'listo'];
let _genialCounter = 0;
function scrubGenial(text) {
  if (!text) return text;
  return text.replace(/\b(que\s+)?genial\b!?/gi, (match) => {
    const repl = GENIAL_REPLACEMENTS[_genialCounter % GENIAL_REPLACEMENTS.length];
    _genialCounter++;
    // Si el original empezaba con mayuscula (inicio de frase), respetamos eso.
    if (match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()) {
      return repl.charAt(0).toUpperCase() + repl.slice(1);
    }
    return repl;
  });
}

async function getAssistantReply(history, userText, knownCity, knownProduct, orderClosed, dataAlreadyRequested) {
  const settings = getSettings();
  const model = settings.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const temperature = settings.openaiTemperature != null ? Number(settings.openaiTemperature) : parseFloat(process.env.OPENAI_TEMPERATURE || '0.7');
  const historyN = settings.openaiHistoryN != null ? Number(settings.openaiHistoryN) : parseInt(process.env.OPENAI_HISTORY_N || '12', 10);

  // El historial que guarda state.js tiene mensajes con role 'user',
  // 'assistant' o 'human' (un mensaje mandado a mano por alguien del negocio
  // desde el panel, ej. cuando toman control de la charla), ademas de otros
  // campos como "at" (hora) o "attachment" (audio original de una nota de
  // voz). OpenAI solo acepta role "system"/"user"/"assistant"/"tool" en sus
  // mensajes: mandarle un mensaje con role "human" tal cual (o con esos
  // campos de mas) hace que la API rechace TODA la llamada con un error. Eso
  // rompia el bot por completo apenas alguien tomaba control un momento y
  // despues se lo devolvia: quedaba un mensaje "human" pegado en el
  // historial reciente, y CADA respuesta de ahi en mas fallaba (se veia como
  // el "Disculpa, tuve un problema para responderte" de mas abajo, sin
  // parar). Por eso aca se arma una version limpia del historial, solo con
  // los dos campos que la API entiende, y "human" se manda como "assistant"
  // (es el lado del negocio hablando, igual que el bot).
  const sanitizedHistory = history.slice(-historyN).map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.content ?? ''),
  }));

  const messages = [
    { role: 'system', content: buildSystemPrompt(knownCity, knownProduct, orderClosed, dataAlreadyRequested) },
    ...sanitizedHistory,
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
    return { text: scrubGenial(responseMessage.content.trim()), images: [] };
  }

  // El modelo decidio usar una o mas herramientas: las ejecutamos de verdad
  // (busqueda contra el CSV, o resolver el nombre de una imagen) y le
  // devolvemos el resultado como mensajes 'tool' para que arme la respuesta
  // final con esa info real.
  messages.push(responseMessage);
  const images = [];
  let lastAgencyResult = null;
  for (const call of toolCalls) {
    const result = runTool(call);
    if (result.image) images.push(result.image);
    if (result.agencyResult) lastAgencyResult = result.agencyResult;
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

  let text = scrubGenial(followUp.choices[0].message.content.trim());

  // Red de seguridad de codigo: si en este turno se busco una lista de
  // agencias por ciudad/estado y la herramienta encontro mas de una, pero el
  // modelo termino mandando MENOS agencias numeradas de las que realmente
  // hay (esto paso de verdad: en Gran Caracas, con 25 agencias reales, el
  // modelo "resumio" y solo mando 2, pese a que el prompt pide explicitamente
  // la lista completa), no confiamos en el resumen: se descarta y se cambia
  // por la lista completa armada por codigo, con el mismo formato que usa
  // buildDirectAgencyMessage. Nunca se recorta informacion real al cliente.
  if (lastAgencyResult && lastAgencyResult.results.length) {
    const numerados = (text.match(/(^|\n)\s*\d+[.)]\s/g) || []).length;
    if (numerados < lastAgencyResult.results.length) {
      text = buildAgencyListMessage(lastAgencyResult.scope, lastAgencyResult.estado, lastAgencyResult.ciudad, lastAgencyResult.results);
    }
  }

  return { text, images };
}

module.exports = {
  getAssistantReply,
  splitReply,
  enforceMessageLimits,
  applySplitPolicy,
  buildSystemPrompt,
  catalogText,
  isClosingMessage,
  looksLikeEmptyDataRequest,
  stripDuplicateDataRequest,
  DATA_REQUEST_REMINDER,
  buildDirectAgencyMessage,
};

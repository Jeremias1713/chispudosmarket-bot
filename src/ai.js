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

// Que puede decir el bot sobre el envio segun la etapa REAL del pedido (la
// que se ve en el panel: automatica del clasificador, o fijada a mano ahi
// mismo). Sin esto, el modelo no tenia forma de saber si un pedido ya salio
// o no, y a veces terminaba "adivinando" segun cuanto tiempo habia pasado
// desde el cierre (bug real: le dijo a un cliente que su pedido ya habia
// llegado cuando en realidad se habia armado hacia apenas 2 horas). El
// tiempo transcurrido nunca es un dato confiable para esto, asi que ahora
// el UNICO dato que se usa es esta etapa.
const SHIPPING_STAGE_TEXT = {
  vendido: 'el pedido esta cerrado pero TODAVIA NO se genero ni se mando el numero de guia: no se ha despachado. Si pregunta si ya salio, si ya llego, o por el numero de guia, decile con honestidad que todavia se esta preparando y que en cuanto tengan la guia se la pasan. NUNCA digas que ya se envio, que esta en camino, o que ya llego.',
  esperando_guia: 'el pedido esta cerrado pero TODAVIA NO se genero ni se mando el numero de guia: no se ha despachado. Si pregunta si ya salio, si ya llego, o por el numero de guia, decile con honestidad que todavia se esta preparando y que en cuanto tengan la guia se la pasan. NUNCA digas que ya se envio, que esta en camino, o que ya llego.',
  esperando_retiro: 'ya se genero y se le paso al cliente el numero de guia (el pedido salio de despacho), pero TODAVIA NO hay confirmacion de que haya llegado a destino. Si pregunta si ya llego, decile que todavia esta en camino/en transito, nunca que ya llego.',
  en_camino: 'el pedido ya salio y, segun la ultima actualizacion, ya esta en camino o ya llego a la agencia y esta lista para que el cliente lo retire. Podes decir eso (que esta en camino, o que ya puede pasar a retirarlo por la agencia), pero NO digas que "ya llego a sus manos" ni que "ya lo recibio": eso solo lo confirma el cliente cuando lo retire de verdad.',
  entregado: 'el cliente YA CONFIRMO que recibio o retiro su pedido. Si pregunta o menciona algo sobre la entrega, podes hablar de eso con naturalidad como algo ya resuelto.',
};

function buildSystemPrompt(knownCity, knownProduct, orderClosed, dataAlreadyRequested, shippingStage, knownCustomer) {
  const settings = getSettings();
  const businessName = settings.businessName || process.env.BUSINESS_NAME || 'nuestro negocio';
  const knowledge = (settings.knowledgeBase || '').trim();
  const maxWords = settings.maxWordsPerMessage || 30;
  const maxWordsHardCap = settings.maxWordsHardCap || 90;
  const maxParts = settings.maxMessageParts || 5;
  const splitEnabled = settings.splitRepliesEnabled !== false;
  const knownCityClean = String(knownCity || '').trim();
  const knownProductClean = String(knownProduct || '').trim();
  // Nombre/cedula/telefono ya confirmados por el cliente (ver la ficha,
  // card.nombre/cedula/telefono en state.js): a diferencia de knownCity, esto
  // no se usaba antes en el prompt, asi que el modelo solo "se acordaba" de
  // estos datos mientras siguieran dentro de las ultimas historyN mensajes
  // (ver sanitizedHistory mas abajo). En una conversacion larga, o cuando el
  // pedido se reabre para cambiar algo (agregar cantidad, otro producto),
  // esos mensajes viejos con los datos quedaban afuera de esa ventana y el
  // bot terminaba volviendo a pedirlos como si nunca los hubiera tenido
  // (bug real: se lo volvio a pedir completo despues de cerrado el pedido).
  // Pasarlos aca, igual que knownCity, los hace validos SIEMPRE, vengan o no
  // dentro del historial reciente.
  const knownNombreClean = String(knownCustomer?.nombre || '').trim();
  const knownCedulaClean = String(knownCustomer?.cedula || '').trim();
  const knownTelefonoClean = String(knownCustomer?.telefono || '').trim();
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
  6. Si un mensaje del cliente trae un tramo entre corchetes tipo "[Lo que se ve en la imagen que mando: ...]" o "[Mando una imagen sin texto. Lo que se ve: ...]", es porque el cliente mando una FOTO y ese texto es una descripcion automatica de lo que muestra (vos no "ves" la foto en si, solo esa descripcion). Usala con naturalidad para entender que mando y responder en consecuencia, como si hubieras visto la foto vos mismo, PERO nunca repitas el corchete ni la palabra "descripcion" en tu respuesta: contestale como a cualquier mensaje. Ejemplos: si la descripcion dice que es un comprobante de pago con un monto, agradecele y confirmale que lo recibiste (o si el monto no coincide con lo que corresponde, decilo con onda); si dice que es su cedula y se lee el numero, tomalo como el dato de cedula y no se lo vuelvas a pedir; si dice que es una foto de un producto o de una consulta, respondele sobre eso igual que si fuera una pregunta de texto. Si la descripcion dice explicitamente que algo no se alcanza a leer bien (un monto borroso, un numero cortado), no lo inventes: decile que no se ve bien esa parte y pedile que la reenvie o te confirme el dato por texto.
  7. NUNCA le digas a un cliente que su pedido "ya llego", "ya fue entregado", "ya lo recibio", "ya esta en tus manos" o cualquier variante de eso, a menos que la etapa real del pedido (ver el DATO YA CONFIRMADO de "ESTADO DEL ENVIO" mas abajo) sea "entregado", o el cliente mismo te lo acabe de decir con sus propias palabras en el mensaje que estas contestando. El tiempo que haya pasado desde que se cerro el pedido NO ES UNA SEÑAL de que ya llego (esto ya paso de verdad: se le dijo a un cliente que su pedido ya habia llegado cuando en realidad se habia armado hacia apenas 2 horas, y era mentira). Si el cliente pregunta por el estado del envio y la etapa real todavia no es "entregado", contestale la verdad segun esa etapa (ver el texto exacto de que decir en cada caso, mas abajo), nunca asumas ni inventes que ya esta resuelto.
${knownCityClean ? `\n  DATO YA CONFIRMADO (viene de la ficha del cliente, no de lo que ves en el historial reciente): el cliente ya dijo antes que esta en "${knownCityClean}". NUNCA le vuelvas a preguntar la ciudad o el estado, usa este dato directamente para buscar la agencia o definir domicilio/agencia. Solo si el mismo cliente menciona una ciudad distinta, usa esa nueva en su lugar.\n` : ''}${dataAlreadyRequested ? `\n  DATO YA CONFIRMADO, MUY IMPORTANTE: en esta conversacion YA le mandaste el mensaje pidiendo nombre y apellido, cedula y telefono (el bloque de "Para procesar tu pedido envianos"). NUNCA vuelvas a mandar ese bloque de nuevo, ni completo ni parecido, aunque el cliente todavia no te haya contestado con esos datos, aunque haya pasado tiempo, o aunque te mande un sticker, un "ok" u otro mensaje corto. Si todavia no te paso esos datos y te escribe algo que no son los datos, contestale lo que corresponda a ese mensaje y como mucho agregale un recordatorio CORTO en una sola frase (por ejemplo "cuando puedas pasame esos datos para procesar tu pedido"), nunca repitas el bloque completo con nombre/cedula/telefono de nuevo. En cuanto identifiques los tres datos en lo que te escribio, seguí al mensaje de cierre del pedido normalmente.\n` : ''}${knownProductClean ? `\n  DATO YA CONFIRMADO: ya se le presento el producto "${knownProductClean}" y la conversacion sigue sobre ese mismo producto. NUNCA le preguntes "que producto queres" ni nada parecido: sabes cual es. Si todavia no sabes cuantos quiere, tu UNICA pregunta pendiente sobre el pedido es la cantidad, nunca el producto. Ejemplo de error que NO tenes que cometer (esto ya paso una vez, no lo repitas): despues de resolver la agencia o la ciudad, cerrar la respuesta con algo como "¿que producto te gustaria pedir y cuantos frascos quieres?" esta MAL, porque el producto ya se sabe; lo correcto ahi es preguntar solo "¿cuantos frascos queres pedir?" (o similar, sin mencionar "que producto"). Esto vale tambien justo despues de usar la herramienta buscar_agencias_por_zona: la pregunta que sigue a la lista de agencias tiene que ser sobre la cantidad, nunca sobre el producto. Si el cliente menciona otro producto distinto, ahi si cambia el producto del que estan hablando.\n` : ''}${orderClosed ? `\n  DATO YA CONFIRMADO, EL MAS IMPORTANTE DE TODOS AHORA MISMO: el pedido de este cliente YA ESTA CERRADO (ya se mando el mensaje de cierre con el resumen, el pago contra entrega y lo de la guia de Tealca). Esto cambia como contestas TODO lo que venga ahora:\n  - La REGLA DE ORO de terminar con una pregunta de venta queda APAGADA. No la reactives.\n  - Si el cliente pregunta algo suelto del producto (por ejemplo si sirve para algo, como se toma, cuanto dura), contestale la pregunta con la info real y PARA AHI. No le agregues "¿te gustaria apartar tu frasco?", "¿te aparto uno?", "¿cuantos queres pedir?" ni ninguna frase de venta: el ya lo pidio, no hay nada que apartar de nuevo.\n  - No vuelvas a pedir ningun dato del pedido (producto, cantidad, ciudad, agencia, nombre, cedula, telefono): ya los tenes todos.\n  - Si te saluda o dice algo corto como "gracias" u "ok", contestale corto y calido, sin reabrir el pedido.\n  - Solo si el cliente dice explicitamente que quiere agregar otro producto, cambiar algo del pedido, o hacer un pedido nuevo, ahi si volves al guion normal de armar un pedido (y ese pedido nuevo es el que queda "abierto" de ahi en adelante). PERO OJO, esto NO borra nada de lo que ya sabes de este cliente: ciudad, agencia, nombre, cedula y telefono siguen siendo los mismos de antes (ver los DATO YA CONFIRMADO de mas abajo), asi que en ese pedido nuevo/modificado NUNCA vuelvas a preguntar la ciudad, ni a mandar de nuevo el bloque completo de nombre/cedula/telefono: lo unico que falta confirmar es lo que realmente cambio (por ejemplo la cantidad, o el producto nuevo si pidio otro). Esto ya paso mal una vez de verdad: un cliente cambio la cantidad de su pedido ya cerrado y el bot le volvio a preguntar la ciudad Y le volvio a pedir nombre/cedula/telefono, a pesar de que ya los tenia los tres.\n` : ''}${(knownNombreClean || knownCedulaClean || knownTelefonoClean) ? `\n  DATO YA CONFIRMADO (viene de la ficha del cliente, no de lo que ves en el historial reciente, asi que vale aunque estos mensajes ya hayan quedado afuera del historial reciente que ves aca abajo): ya tenes estos datos de este cliente:${knownNombreClean ? `\n  - Nombre y apellido: ${knownNombreClean}` : ''}${knownCedulaClean ? `\n  - Cedula: ${knownCedulaClean}` : ''}${knownTelefonoClean ? `\n  - Telefono: ${knownTelefonoClean}` : ''}\n  NUNCA le vuelvas a pedir ninguno de estos datos, ni completo ni parcial (ni el bloque de "Para procesar tu pedido envianos", ni preguntar "cual es tu nombre" suelto), aunque el pedido se haya cerrado hace rato, aunque abra un pedido nuevo o modifique uno, o aunque estos mensajes ya no aparezcan en el historial reciente de abajo. Solo si el mismo cliente te da un dato distinto (por ejemplo corrige su telefono), usa ese nuevo valor en su lugar.\n` : ''}${orderClosed && SHIPPING_STAGE_TEXT[shippingStage] ? `\n  DATO YA CONFIRMADO, ESTADO DEL ENVIO (esto es lo unico que podes usar para hablar de si el pedido llego o no, ver regla 7 de PRIORIDAD mas arriba): ${SHIPPING_STAGE_TEXT[shippingStage]}\n` : ''}

  ENTREGA: depende de la ciudad.
  - CARACAS (Distrito Capital, incluye todos sus municipios/parroquias): hay dos formas de recibirlo, domicilio (te lo llevan hasta la puerta) o retiro en agencia. Ofrecele PRIMERO la opcion de domicilio, es la mas comoda para el cliente, y si prefiere retirar en agencia esa tambien esta disponible.
  - RESTO DE VENEZUELA (todos los demas estados, Maracaibo incluida): SOLO se retira en agencia (TEALCA), no hay entrega a domicilio ahi. Si un cliente fuera de Caracas pide que se lo lleven a la casa, decile con naturalidad que fuera de Caracas por ahora solo se retira en agencia, no ofrezcas ni prometas domicilio en esos casos, y segui ayudandolo a elegir la agencia mas cercana.
  - MARACAIBO (estado Zulia): ademas de la agencia Tealca, ahi tambien hay tienda fisica propia del negocio, en Palacio de Eventos, local PBG-16, Maracaibo, estado Zulia 🙏🏻. ESA es la UNICA direccion que podes escribir de memoria, sin llamar a la herramienta: es fija y siempre la misma. Para las agencias Tealca de Maracaibo NUNCA hagas lo mismo: aunque te sepas que en Maracaibo hay varias agencias Tealca, NO inventes ni escribas de memoria ninguna direccion de Tealca (nombre de sector, calle, numero, etc) — eso ya paso de verdad (se le invento a un cliente una direccion de Tealca en Maracaibo que no existe en el listado real) y no puede volver a pasar. Para Maracaibo llama a buscar_agencias_por_zona exactamente igual que para cualquier otra ciudad (esta nota de la tienda propia NO reemplaza ese paso), dejá que la herramienta traiga la lista REAL de agencias Tealca de Maracaibo (suelen ser varias, no una sola), y despues sumale la tienda propia como un dato mas de la conversacion (con algun emoji si corresponde, tipo 📍), no como parte de la lista numerada. Esto es informacion SOLO para Maracaibo puntual, no para el resto del Zulia ni del pais: en cualquier otra ciudad segui con la agencia Tealca como unica opcion.

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
  NUNCA escribas un link ni una imagen en formato markdown (cosas como "![nombre](https://...)" o cualquier link inventado/de ejemplo) directo en el texto del mensaje: WhatsApp no lo muestra como imagen, el cliente ve el texto crudo y el link ni siquiera funciona. Esto paso de verdad: un cliente pidio ver una foto y en vez de mandarsela de verdad (o decirle que no tenias una para ese momento), se le mando un link falso como texto plano, que no le sirvio de nada. Si el cliente pide una foto y no es un caso en el que corresponda usar mostrar_foto (ver mas abajo), decile con tus palabras que por ahora no tenes esa foto para mandarle, sin inventar ningun link.
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
  Podes mandar una de estas fotos en medio de la charla usando la herramienta mostrar_foto con el nombre EXACTO tal cual aparece arriba, pero SOLO cuando las instrucciones de un producto (arriba, en el catalogo) o la base de conocimiento del negocio te digan explicitamente que mandes esa foto en ese momento. Nunca la uses por iniciativa propia sin que te lo hayan indicado asi. Si el cliente pide ver una foto y no corresponde mandarla asi, NUNCA escribas un link ni una imagen en markdown en el texto (ver la regla de mas arriba): decile con tus palabras que por ahora no tenes esa foto para mandarle.` : ''}`;
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
  const stateResults = estado ? agencies.searchByText(estado, 50) : [];
  if (cityResults.length) {
    // Bug real detectado con logs de produccion: los datos actuales de
    // agencias (subidos por el panel, pueden cambiar en cualquier momento y
    // NO son los mismos que el CSV de este repo) tienen las agencias de
    // Caracas cargadas por barrio ("Catia", "El Junquito"), sin la palabra
    // "caracas" en el nombre ni en la mayoria de las direcciones. Buscar
    // "caracas" como texto encontraba solo 2 agencias de las que sí la
    // mencionaban de casualidad, y el cliente se quedaba sin ver el resto.
    // Si "caracas" es la unica ciudad conocida de su estado (ver
    // isSoleCityOfItsState), no hay riesgo de mezclar agencias de otro
    // pueblo: buscar por el estado completo da exactamente el mismo
    // conjunto que "buscar por Caracas" deberia dar. Se usa la lista mas
    // grande de las dos.
    if (stateResults.length > cityResults.length && agencies.isSoleCityOfItsState(ciudad)) {
      return { scope: 'ciudad', results: stateResults };
    }
    return { scope: 'ciudad', results: cityResults };
  }
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
// Los ciudad/estado que llegan aca vienen "foldeados" (minusculas, sin
// tildes) porque salen de findKnownCityKey. Para que el mensaje al cliente
// no diga literalmente "en maracaibo" o "en tachira", se capitaliza cada
// palabra antes de mostrarlo (no hace falta que quede con tildes perfectas,
// con la mayuscula alcanza para que se lea natural).
function capitalizeWords(s) {
  return String(s || '')
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Nota fija de la tienda propia de Maracaibo (ver AGENCIAS Y COBERTURA en el
// prompt): se agrega SIEMPRE que la lista final que se le manda al cliente
// sea de Maracaibo, sin importar si el texto lo redacto el modelo o si es la
// lista armada por codigo (red de seguridad de completitud). Antes esto
// dependia de que el modelo se acordara de agregarlo el solo, y paso de
// verdad que la omitio en su respuesta.
const MARACAIBO_TIENDA_PROPIA_NOTE =
  '\n\nAdemas de esas agencias, tambien tenemos tienda propia en Maracaibo 📍: Palacio de Eventos, local PBG-16, Maracaibo, estado Zulia.';

// Arma el mensaje final (el que se le manda de verdad al cliente) para una
// busqueda de agencias ya resuelta. Se separa de buildDirectAgencyMessage
// para poder reusarla tambien como red de seguridad de completitud (ver
// getAssistantReply mas abajo): ambos casos ya tienen el scope/resultados
// resueltos, solo hace falta redactar el texto.
function buildAgencyListMessage(scope, estado, ciudad, results) {
  const ciudadMostrable = capitalizeWords(ciudad);
  const extra = ciudad === 'maracaibo' ? MARACAIBO_TIENDA_PROPIA_NOTE : '';
  if (scope === 'ciudad') {
    return `Aquí tienes las agencias disponibles en ${ciudadMostrable}:\n${formatAgencyList(results)}${extra}\n\n¿Cuál de estas te queda mejor para retirar tu pedido?`;
  }
  return (
    `A esa ciudad puntual no llega de forma directa, pero en el estado ${capitalizeWords(estado)} sí hay cobertura:\n` +
    `${formatAgencyList(results)}${extra}\n\n¿Cuál de estas te queda mejor para retirar tu pedido?`
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

// Red de seguridad de codigo (ademas de la instruccion en el prompt): una
// foto real SIEMPRE se manda por un canal aparte (la herramienta
// mostrar_foto, ver result.image mas abajo), nunca como markdown adentro
// del texto del mensaje. Si el modelo igual escribe algo como
// "![nombre](https://...)" (esto paso de verdad: un cliente pidio ver una
// foto y en vez de mandarsela o decir que no tenia, le llego ese link falso
// como texto plano), lo sacamos: WhatsApp no lo muestra como imagen de
// todos modos, asi que dejarlo ahi solo confunde al cliente con un link roto.
function scrubFakeImageLinks(text) {
  if (!text) return text;
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

// Red de seguridad de codigo: si el modelo NO llamo a buscar_agencias_por_zona
// en este turno (por eso se usa desde la rama donde no hubo tool_calls) pero
// igual escribio algo con forma de lista de agencias (numerada, mencionando
// "agencia"), no hay forma de confiar en que ese dato sea real: puede
// haberlo inventado. Esto paso de verdad (le invento a un cliente de Ciudad
// Bolivar una agencia y una direccion que no existen, en vez de llamar a la
// herramienta y traer las 6 agencias reales del estado Bolivar). Si se puede
// reconocer la ciudad (de la ficha ya guardada del cliente, o si no de lo
// que el cliente acaba de escribir en este mismo mensaje), se reemplaza por
// la busqueda real hecha aca mismo por codigo. Si no hay ciudad reconocible
// no se toca nada: mejor dejar el texto del modelo que no contestar nada.
function guardAgainstUnverifiedAgencyList(text, knownCity, userText) {
  if (!/agencia/i.test(text) || !/(^|\n)\s*\d+[.)]\s/.test(text)) return text;
  const ciudadCandidata = agencies.findKnownCityKey(knownCity) || agencies.findKnownCityKey(userText);
  if (!ciudadCandidata) {
    console.log('[agency-guard] sin-tool: no reconoci ciudad, dejo el texto del modelo tal cual. knownCity=', knownCity, 'userText=', userText);
    return text;
  }
  const estado = agencies.resolveStateForCity(ciudadCandidata);
  const { scope, results } = searchAgenciesByZone(estado, ciudadCandidata);
  if (!results.length) {
    console.log('[agency-guard] sin-tool: ciudad reconocida pero sin resultados, dejo el texto del modelo. ciudad=', ciudadCandidata);
    return text;
  }
  console.log('[agency-guard] sin-tool: OVERRIDE aplicado. ciudad=', ciudadCandidata, 'scope=', scope, 'resultados=', results.length);
  return buildAgencyListMessage(scope, estado, ciudadCandidata, results);
}

async function getAssistantReply(history, userText, knownCity, knownProduct, orderClosed, dataAlreadyRequested, shippingStage, knownCustomer) {
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
    { role: 'system', content: buildSystemPrompt(knownCity, knownProduct, orderClosed, dataAlreadyRequested, shippingStage, knownCustomer) },
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
    console.log('[agency-guard] el modelo NO llamo ninguna herramienta este turno. userText=', userText, 'knownCity=', knownCity);
    const text = guardAgainstUnverifiedAgencyList(scrubFakeImageLinks(scrubGenial(responseMessage.content.trim())), knownCity, userText);
    return { text, images: [] };
  }
  console.log('[agency-guard] el modelo SI llamo herramienta(s):', toolCalls.map((c) => c.function.name).join(', '));

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

  let text = scrubFakeImageLinks(scrubGenial(followUp.choices[0].message.content.trim()));

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
    console.log('[agency-completeness] tool-called: ciudad=', lastAgencyResult.ciudad, 'scope=', lastAgencyResult.scope, 'resultadosReales=', lastAgencyResult.results.length, 'numeradosEnTexto=', numerados);
    if (numerados < lastAgencyResult.results.length) {
      console.log('[agency-completeness] OVERRIDE aplicado (numerados < resultadosReales)');
      text = buildAgencyListMessage(lastAgencyResult.scope, lastAgencyResult.estado, lastAgencyResult.ciudad, lastAgencyResult.results);
    }
  } else {
    console.log('[agency-completeness] tool-called pero sin agencyResult/resultados (lastAgencyResult=', lastAgencyResult ? 'presente-vacio' : 'null', ')');
  }

  // Bug real encontrado con los logs de arriba: cuando el modelo SI mando
  // todas las agencias de Maracaibo (no dispara el override de arriba porque
  // el conteo ya daba completo), el texto del modelo simplemente no incluia
  // la nota de la tienda propia, porque esa nota solo vivia adentro de
  // buildAgencyListMessage (que solo se usa cuando hay override). Antes esto
  // dependia 100% de que el modelo se acordara solo de mencionarla. Ahora se
  // agrega por codigo, sin pasar por el modelo, cada vez que la lista final
  // que se le manda al cliente es de Maracaibo y todavia no la menciona.
  if (lastAgencyResult && lastAgencyResult.ciudad === 'maracaibo' && !/tienda propia|palacio de eventos/i.test(text)) {
    console.log('[agency-completeness] agregando nota de tienda propia de Maracaibo (no estaba en el texto del modelo)');
    text = text.trim() + MARACAIBO_TIENDA_PROPIA_NOTE;
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

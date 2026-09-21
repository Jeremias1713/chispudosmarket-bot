// Clasifica cada conversacion por etapa de venta y extrae una "ficha" del
// cliente (nombre, ciudad, telefono, producto, notas), igual que hacia el
// bot anterior. Corre en cada turno, aparte de la respuesta al cliente:
// si falla, no rompe nada, simplemente no actualiza la etapa.
const OpenAI = require('openai');
const { normalizeProductName } = require('./catalog');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const STAGES = [
  'nuevo',
  'interesado',
  'negociando',
  // El cliente promete comprar en una fecha o momento futuro concreto (ej.
  // "te escribo el 15", "el mes que viene lo pido"), pero el pedido TODAVIA
  // no se cerro de verdad (sin todos los datos, sin mensaje de cierre). Se
  // separa de "negociando" y sobre todo de "vendido" porque estas promesas a
  // futuro se olvidan seguido — no es una venta real todavia, es un
  // recordatorio pendiente. Al estar en STALE_STAGES (ver panel.js) tambien
  // va a aparecer en "conversaciones que necesitan seguimiento" si pasa
  // mucho tiempo sin que el cliente vuelva a escribir, para no perderla de
  // vista.
  'escribir_mas_tarde',
  'vendido',
  // "esperando_guia" es una categoria de uso MANUAL (se fija a mano desde el
  // panel, el clasificador de IA nunca la elige sola): sirve para separar,
  // dentro de los pedidos ya vendidos, los que todavia no tienen numero de
  // guia de los que ya lo tienen y estan "esperando_retiro"/"en_camino". No
  // esta en el prompt de la IA (ver CLASSIFIER_PROMPT mas abajo) a proposito,
  // para no repetir el mismo tipo de confusion que ya paso con otras etapas
  // parecidas (ver esperando_retiro vs en_camino).
  'esperando_guia',
  // "tienda_maracaibo" es para el otro caso de retiro en Maracaibo: el
  // negocio tiene ahi, ademas de las agencias Tealca, una tienda propia
  // (Palacio de Eventos, local PBG-16 — ver la nota fija en ai.js). Cuando
  // el cliente esta en Maracaibo y elige retirar en ESA tienda propia (no
  // una agencia Tealca), el pedido no pasa por el circuito de guia/Tealca
  // (esperando_guia -> en_camino -> esperando_retiro): el negocio solo
  // necesita saber que ese cliente va a pasar por la tienda, para tenerlo
  // identificado aparte del resto de los pedidos por agencia.
  'tienda_maracaibo',
  'esperando_retiro',
  'en_camino',
  'novedad',
  'pendiente_devolucion',
  'entregado',
  // "devolucion" es para un pedido que YA se habia cerrado/entregado pero el
  // cliente lo devolvio (o el negocio confirmo que se va a devolver/reembolsar).
  // A proposito NO esta en SOLD_STAGES (ver flow.js): una vez que un pedido
  // pasa a esta etapa, deja de contar como venta cerrada en ingresos y
  // conversion (el dinero/producto volvio), aunque haya llegado a "vendido"
  // o "entregado" antes.
  'devolucion',
  'necesita_atencion',
  'perdido',
];

let _client = null;
function client() {
    if (!_client) {
    // OJO: hay que hacer .trim() igual que en ai.js. Si la variable de
    // entorno tiene un espacio o salto de linea invisible al final (pasa
    // seguido al pegarla en el dashboard de Render), el header Authorization
    // queda mal formado y el fetch de Node falla con "Connection error" en
    // TODAS las llamadas, sin ningun mensaje mas claro. Este bug hizo que la
    // clasificacion (Etapa + ficha del cliente) estuviera rota siempre.
    const apiKey = (process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('Falta OPENAI_API_KEY en las variables de entorno.');
    }
    _client = new OpenAI({ apiKey });
    }
  return _client;
}

const CLASSIFIER_PROMPT = `Clasificas conversaciones de venta por WhatsApp de un negocio que vende
con retiro en agencia.

  Leete todos los mensajes y devolve la etapa en la que esta la conversacion AHORA.

  Etapas posibles:
- nuevo: saludo o pregunta generica, todavia no muestra interes claro.
  - interesado: pregunta por precio, producto o disponibilidad.
- negociando: ya dijo que lo quiere o que lo compra, pero todavia no dio todos sus datos
  (nombre, ciudad, telefono, producto). Ante la duda, va aca.
  - escribir_mas_tarde: el cliente dijo EXPLICITAMENTE que va a hacer el pedido mas adelante, en un
  momento o fecha futura concreta (ej. "te escribo el 15", "compro la semana que viene", "dejame
  pensarlo y te aviso", "el mes que viene lo pido", "ahorita no tengo, despues te escribo"), pero
  TODAVIA no dio todos los datos para cerrar (nombre, ciudad, telefono, producto) NI el negocio le
  mando el mensaje de cierre del pedido. MUY IMPORTANTE: esto NUNCA es "vendido", aunque el cliente
  suene decidido o entusiasmado — son promesas a futuro que se olvidan seguido, no representan una
  venta real todavia. Si en algun momento posterior el cliente SI termina dando todos los datos y el
  negocio SI manda el cierre, ahi recien pasa a "vendido" (ver mas abajo), sin importar que antes
  haya mencionado una fecha.
  - vendido: ya dio nombre, ciudad, telefono y que producto quiere, y el negocio ya le mando el
  mensaje de cierre del pedido (resumen + pago contra entrega + que le pasan la guia). Esta es la
  etapa por defecto de un pedido recien cerrado: quedate aca salvo que la conversacion, DESPUES del
  cierre, tenga algo mas concreto que justifique avanzar a una de las tres etapas de abajo.
  - tienda_maracaibo: lo mismo que "vendido" (pedido cerrado), pero ademas el cliente esta en
  Maracaibo y explicitamente eligio retirar en la TIENDA PROPIA del negocio (Palacio de Eventos,
  local PBG-16), no en una agencia Tealca. Marca esta etapa SOLO si de la conversacion queda claro
  que el retiro va a ser en esa tienda propia puntual, no una agencia. Si el cliente de Maracaibo
  eligio una agencia Tealca en cambio, seguí con las etapas normales de abajo (vendido,
  esperando_retiro, en_camino, entregado), no esta.
  - en_camino: alguien (negocio o cliente) confirma EXPLICITAMENTE, en un mensaje concreto despues
  del cierre, que el pedido YA SALIO/YA SE DESPACHO (por ejemplo le paso el numero de guia real, o le
  confirmo que ya se envio), pero TODAVIA NO llego a la agencia de destino: sigue en transito. No
  alcanza con la frase generica del mensaje de cierre tipo "en cuanto tengamos la guia te la pasamos"
  o "te avisamos cuando llegue": eso es una PROMESA a futuro que ya viene siempre en el cierre, no una
  confirmacion de que ya paso. Si lo unico que hay despues del cierre es silencio, un "gracias" del
  cliente, o charla suelta sobre el producto, la etapa sigue siendo "vendido", no "en_camino". OJO,
  MUY IMPORTANTE: que se haya generado o mandado un numero de guia SOLO confirma que el pedido salio
  de despacho (esta etapa, "en_camino"); JAMAS uses eso para inferir que el pedido YA LLEGO a la
  agencia (esa es la etapa de abajo, "esperando_retiro") — son dos eventos distintos y separados en
  el tiempo, uno no implica el otro.
  - esperando_retiro: alguien (negocio o cliente) confirma EXPLICITAMENTE, en un mensaje concreto
  despues del cierre, que el pedido YA LLEGO a la agencia de destino y esta listo para que el cliente
  lo retire ahora (por ejemplo "ya llego a la agencia", "ya esta en la oficina de Tealca", "ya lo
  podes retirar"). De nuevo, la frase generica del mensaje de cierre NO alcanza para esto, y tampoco
  alcanza con que el pedido ya este "en_camino": sin una confirmacion EXPLICITA de que llego a la
  agencia (nunca por el solo paso del tiempo desde que salio de despacho), la etapa mas alta posible
  es "en_camino".
- entregado: el CLIENTE en persona confirma en sus propias palabras que ya recibio o ya retiro el
  producto (ej. "ya me llego", "ya lo retire", "llego todo bien"). NUNCA marques "entregado" solo
  porque el negocio prometio avisar cuando llegue, ni porque paso tiempo desde el cierre, el
  despacho o la llegada a la agencia: sin un mensaje del cliente confirmando la entrega/retiro real,
  la etapa mas alta posible es "esperando_retiro". Ejemplo de error que no hay que repetir: un pedido
  se cierra (o se despacha, o llega a la agencia) y, en la misma conversacion, unos minutos despues
  sin que el cliente haya dicho nada de recibir el producto, se marca como "entregado": eso esta mal,
  en ese caso la etapa se queda en la que estaba antes (vendido, en_camino o esperando_retiro segun
  corresponda), nunca "entregado" por el solo paso del tiempo.
  - devolucion: el CLIENTE dice explicitamente que va a devolver o ya devolvio el producto (ej. "lo
  quiero devolver", "ya lo mande de vuelta", "no me sirvio, quiero el reembolso"), O el negocio
  confirma explicitamente que se va a procesar la devolucion/el reembolso de ese pedido. No alcanza
  con una queja o un reclamo sin mencionar devolucion o reembolso (eso es "necesita_atencion"). Una
  vez marcada, esta etapa no cuenta como venta cerrada en los reportes del negocio.
  - necesita_atencion: se queja, reclama o pide hablar con una persona.
- perdido: dijo que no le interesa o abandono claramente la conversacion.

  Ademas de la etapa, extrae los datos que el cliente haya dado en TODA la conversacion:
- nombre: nombre completo si lo dijo, si no null.
  - ciudad: ciudad o zona que menciono, si no null.
- telefono: telefono de contacto SOLO si lo escribio explicitamente (el numero desde el que
  escribe no cuenta), si no null.
- cedula: numero de cedula si lo escribio explicitamente, si no null.
- producto: resumen legible del producto o productos que pidió, si no null.
- productos: SOLO los productos del pedido confirmado más reciente, como una lista de objetos con
  nombre y cantidad. Incluye todos si pidió varios productos distintos. No incluyas productos que
  solo aparecieron como opciones, preguntas o promociones. Si una cantidad no fue confirmada usa
  null; no la inventes. Si todavía no existe un pedido concreto usa [].
  - notas: cualquier dato relevante para la venta que no entre en los otros campos, si no null.

  Copia lo que dijo el cliente, no lo inventes ni lo completes. Un dato que no aparece va en null.

  Devolve SOLO un JSON con esta forma exacta, nada de texto extra:
{"etapa": "...", "razon": "...", "card": {"nombre": null, "ciudad": null, "telefono": null, "cedula": null, "producto": null, "productos": [{"nombre": "Shilajit Viking", "cantidad": 1}], "notas": null}}`;

async function classifyConversation(history) {
  const transcript = (history || [])
    .map((m) => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`)
    .join('\n');

  try {
    const completion = await client().chat.completions.create({
            model: MODEL,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
{ role: 'system', content: CLASSIFIER_PROMPT },
              { role: 'user', content: transcript || '(sin mensajes todavia)' },
                    ],
              });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const etapa = STAGES.includes(parsed.etapa) ? parsed.etapa : 'nuevo';
    const card = parsed.card || {};
    const productos = (Array.isArray(card.productos) ? card.productos : [])
      .map((item) => ({
        nombre: String(item?.nombre || item?.producto || '').trim(),
        cantidad: Number.isInteger(Number(item?.cantidad)) && Number(item.cantidad) > 0 ? Number(item.cantidad) : null,
      }))
      .filter((item) => item.nombre);

    return {
      stage: etapa,
      razon: parsed.razon || null,
      card: {
        nombre: card.nombre || null,
        ciudad: card.ciudad || null,
        telefono: card.telefono || null,
        cedula: card.cedula || null,
        // Se normaliza contra el nombre EXACTO del catalogo (ver
        // catalog.normalizeProductName) para que variantes distintas del
        // mismo producto ("shilajit", "1 frasco de Shilajit", "Shilajit
        // Viking"...) no queden separadas en Metricas > Productos mas
        // vendidos.
        producto: card.producto ? normalizeProductName(card.producto) : null,
        // Se conserva además la lista estructurada y sin normalizar. La cola
        // de DroPanas la cruza contra alias configurables y bloquea cualquier
        // nombre ambiguo en lugar de adivinar un producto.
        productos: productos.length ? productos : null,
        notas: card.notas || null,
},
};
} catch (err) {
    console.error('Error clasificando conversacion:', err.message);
    return null;
}
}

module.exports = { classifyConversation, STAGES };

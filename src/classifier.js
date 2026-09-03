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
  'vendido',
  // "esperando_guia" es una categoria de uso MANUAL (se fija a mano desde el
  // panel, el clasificador de IA nunca la elige sola): sirve para separar,
  // dentro de los pedidos ya vendidos, los que todavia no tienen numero de
  // guia de los que ya lo tienen y estan "esperando_retiro"/"en_camino". No
  // esta en el prompt de la IA (ver CLASSIFIER_PROMPT mas abajo) a proposito,
  // para no repetir el mismo tipo de confusion que ya paso con otras etapas
  // parecidas (ver esperando_retiro vs en_camino).
  'esperando_guia',
  'esperando_retiro',
  'en_camino',
  'entregado',
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
con retiro en agencia o entrega a domicilio.

  Leete todos los mensajes y devolve la etapa en la que esta la conversacion AHORA.

  Etapas posibles:
- nuevo: saludo o pregunta generica, todavia no muestra interes claro.
  - interesado: pregunta por precio, producto o disponibilidad.
- negociando: ya dijo que lo quiere o que lo compra, pero todavia no dio todos sus datos
  (nombre, ciudad, telefono, producto). Ante la duda, va aca.
  - vendido: ya dio nombre, ciudad, telefono y que producto quiere, y el negocio ya le mando el
  mensaje de cierre del pedido (resumen + pago contra entrega + que le pasan la guia). Esta es la
  etapa por defecto de un pedido recien cerrado: quedate aca salvo que la conversacion, DESPUES del
  cierre, tenga algo mas concreto que justifique avanzar a una de las tres etapas de abajo.
  - esperando_retiro: lo mismo que "vendido" (pedido cerrado), pero ademas alguien del negocio dijo
  explicitamente, DESPUES del cierre, que ya le esta coordinando o preparando el envio o el retiro
  (por ejemplo le paso el numero de guia real, o le confirmo que ya se despacho). No alcanza con la
  frase generica del mensaje de cierre tipo "en cuanto tengamos la guia te la pasamos" o "te avisamos
  cuando llegue": eso es una PROMESA a futuro que ya viene siempre en el cierre, no una confirmacion
  de que ya paso. Si lo unico que hay despues del cierre es silencio, un "gracias" del cliente, o
  charla suelta sobre el producto, la etapa sigue siendo "vendido", no "esperando_retiro".
  - en_camino: alguien (negocio o cliente) confirma EXPLICITAMENTE, en un mensaje concreto despues
  del cierre, que el pedido ya salio/esta en camino o que ya llego a la agencia y esta listo para
  retirar ahora. De nuevo, la frase generica del mensaje de cierre NO alcanza para esto.
- entregado: el CLIENTE en persona confirma en sus propias palabras que ya recibio o ya retiro el
  producto (ej. "ya me llego", "ya lo retire", "llego todo bien"). NUNCA marques "entregado" solo
  porque el negocio prometio avisar cuando llegue, ni porque paso tiempo desde el cierre: sin un
  mensaje del cliente confirmando la entrega real, la etapa mas alta posible es "esperando_retiro".
  Ejemplo de error que no hay que repetir: un pedido se cierra y, en la misma conversacion, unos
  minutos despues sin que el cliente haya dicho nada de recibir el producto, se marca como
  "entregado": eso esta mal, en ese caso la etapa sigue siendo "vendido".
  - necesita_atencion: se queja, reclama o pide hablar con una persona.
- perdido: dijo que no le interesa o abandono claramente la conversacion.

  Ademas de la etapa, extrae los datos que el cliente haya dado en TODA la conversacion:
- nombre: nombre completo si lo dijo, si no null.
  - ciudad: ciudad o zona que menciono, si no null.
- telefono: telefono de contacto SOLO si lo escribio explicitamente (el numero desde el que
  escribe no cuenta), si no null.
- cedula: numero de cedula si lo escribio explicitamente, si no null.
- producto: que producto pidio, aunque no haya cerrado el pedido, si no null.
  - notas: cualquier dato relevante para la venta que no entre en los otros campos, si no null.

  Copia lo que dijo el cliente, no lo inventes ni lo completes. Un dato que no aparece va en null.

  Devolve SOLO un JSON con esta forma exacta, nada de texto extra:
{"etapa": "...", "razon": "...", "card": {"nombre": null, "ciudad": null, "telefono": null, "cedula": null, "producto": null, "notas": null}}`;

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
        notas: card.notas || null,
},
};
} catch (err) {
    console.error('Error clasificando conversacion:', err.message);
    return null;
}
}

module.exports = { classifyConversation, STAGES };

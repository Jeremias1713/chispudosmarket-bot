// Clasifica cada conversacion por etapa de venta y extrae una "ficha" del
// cliente (nombre, ciudad, telefono, producto, notas), igual que hacia el
// bot anterior. Corre en cada turno, aparte de la respuesta al cliente:
// si falla, no rompe nada, simplemente no actualiza la etapa.
const OpenAI = require('openai');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const STAGES = [
  'nuevo',
  'interesado',
  'negociando',
  'vendido',
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
  - vendido: ya dio nombre, ciudad, telefono y que producto quiere. La cantidad no hace falta.
  - esperando_retiro: el pedido esta confirmado y se esta coordinando el retiro/entrega.
  - en_camino: se le informo que el pedido va en camino o esta listo para retirar.
- entregado: confirmo que ya recibio el producto.
  - necesita_atencion: se queja, reclama o pide hablar con una persona.
- perdido: dijo que no le interesa o abandono claramente la conversacion.

  Ademas de la etapa, extrae los datos que el cliente haya dado en TODA la conversacion:
- nombre: nombre completo si lo dijo, si no null.
  - ciudad: ciudad o zona que menciono, si no null.
- telefono: telefono de contacto SOLO si lo escribio explicitamente (el numero desde el que
  escribe no cuenta), si no null.
- producto: que producto pidio, aunque no haya cerrado el pedido, si no null.
  - notas: cualquier dato relevante para la venta que no entre en los otros campos, si no null.

  Copia lo que dijo el cliente, no lo inventes ni lo completes. Un dato que no aparece va en null.

  Devolve SOLO un JSON con esta forma exacta, nada de texto extra:
{"etapa": "...", "razon": "...", "card": {"nombre": null, "ciudad": null, "telefono": null, "producto": null, "notas": null}}`;

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
        producto: card.producto || null,
        notas: card.notas || null,
},
};
} catch (err) {
    console.error('Error clasificando conversacion:', err.message);
    return null;
}
}

module.exports = { classifyConversation, STAGES };

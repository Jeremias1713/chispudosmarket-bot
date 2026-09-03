// Describe en texto que hay en una imagen que manda el cliente por WhatsApp
// (foto de un producto, captura de un pago, foto de la cedula, etc.), usando
// el mismo modelo de OpenAI que ya se usa para las respuestas (ver ai.js),
// que entiende imagenes. Es la contraparte de stt.js (nota de voz a texto)
// pero para fotos: antes, una foto sin texto quedaba guardada para verla
// desde el panel pero el bot no tenia ninguna idea de que mostraba, asi que
// no podia contestar nada relacionado (ej. confirmar un pago, o responder
// sobre lo que se ve en la foto).
//
// Igual que stt.js: si esto falla por cualquier motivo (sin OPENAI_API_KEY,
// sin credito, imagen rara, sin red), quien llama tiene que atajarlo y
// seguir como si no se hubiera podido leer la imagen, nunca romper la
// conversacion.
const OpenAI = require('openai');

// Se puede usar un modelo distinto al de las respuestas si hiciera falta
// (ej. uno mas barato solo para describir), pero por defecto es el mismo:
// gpt-4o-mini ya entiende imagenes sin configuracion extra.
const VISION_MODEL = process.env.VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

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

const DESCRIBE_PROMPT = `Describi en 1-2 oraciones, en español y bien concreto, que se ve en esta
imagen que mando un cliente por WhatsApp a un negocio que vende por catalogo.

- Si es una captura de un pago o transferencia: deci el monto y el
  banco/plataforma si se alcanzan a leer.
- Si es un documento (cedula, etc.): deci que documento es y el numero si se
  lee con claridad.
- Si es una foto de un producto, o de algo relacionado a una consulta sobre
  el cuerpo/la piel/etc: describila tal cual se ve, sin dar consejos,
  diagnosticos ni recomendaciones — eso lo decide el negocio, no vos.
- No inventes nada que no se vea con claridad: si algo no se alcanza a leer
  bien (un monto borroso, un numero cortado), decilo en vez de adivinarlo.

Responde SOLO la descripcion, sin introducciones ni comentarios aparte.`;

// buffer: la imagen tal como la devuelve whatsapp.downloadMedia. mimeType: el
// que manda Meta (ej. "image/jpeg"). Devuelve '' si no se pudo describir.
async function describeImage(buffer, mimeType) {
  if (!buffer || !buffer.length) return '';
  const mime = String(mimeType || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

  const completion = await client().chat.completions.create({
    model: VISION_MODEL,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: DESCRIBE_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  return String(completion.choices?.[0]?.message?.content || '').trim();
}

module.exports = { describeImage };

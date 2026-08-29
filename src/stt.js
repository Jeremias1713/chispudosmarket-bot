// Voz a texto para las notas de audio que mandan los clientes: baja el
// archivo desde WhatsApp (ver whatsapp.downloadMedia) y lo transcribe con
// Whisper de OpenAI. Es la contraparte de tts.js (que hace texto a voz para
// las respuestas del bot).
//
// Igual que tts.js: si esto falla por cualquier motivo (sin OPENAI_API_KEY,
// sin credito, audio raro, sin red), quien llama tiene que atajarlo y seguir
// como si no se hubiera podido transcribir, nunca romper la conversacion.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const OpenAI = require('openai');

const STT_MODEL = process.env.STT_MODEL || 'whisper-1';

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

// audio/ogg; codecs=opus -> ogg (Whisper solo necesita una extension que
// coincida mas o menos con el contenido para saber como leerlo).
function extFromMime(mime) {
  const main = String(mime || '').split(';')[0].trim();
  const sub = main.split('/')[1];
  return sub || 'ogg';
}

// Recibe el buffer binario del audio (tal como lo devuelve downloadMedia) y
// devuelve el texto transcripto. Devuelve '' si no hay nada que transcribir.
async function transcribeAudio(buffer, mimeType) {
  if (!buffer || !buffer.length) return '';

  const ext = extFromMime(mimeType);
  const tmpPath = path.join(os.tmpdir(), `nota-voz-${crypto.randomBytes(6).toString('hex')}.${ext}`);
  fs.writeFileSync(tmpPath, buffer);

  try {
    const response = await client().audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: STT_MODEL,
      language: 'es',
    });
    return String(response?.text || '').trim();
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

module.exports = { transcribeAudio };

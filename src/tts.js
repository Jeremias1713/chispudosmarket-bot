// Texto a voz para las respuestas del bot: genera un audio corto con las
// voces de OpenAI y lo deja en el mismo directorio publico que usa la
// biblioteca de imagenes (server.js expone /media sin autenticacion, hace
// falta porque WhatsApp/Meta tiene que poder descargarlo desde afuera).
//
// Si esto falla por cualquier motivo (sin OPENAI_API_KEY, sin credito, sin
// red), quien llama tiene que atajarlo: el bot siempre contesta por texto
// igual, el audio es un extra, nunca un bloqueante.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const OpenAI = require('openai');
const { MEDIA_DIR } = require('./library');

const TTS_MODEL = process.env.TTS_MODEL || 'tts-1';
const TTS_VOICE = process.env.TTS_VOICE || 'alloy';

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

// Genera un mp3 con el texto dado y lo guarda en data/media/. Devuelve
// { filename, filepath } para que quien llama arme el link publico y despues
// pueda borrarlo una vez mandado (no hace falta guardarlo para siempre).
async function generateSpeech(text) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Texto vacio, nada que convertir a audio.');

  const response = await client().audio.speech.create({
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: clean,
    response_format: 'mp3',
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const filename = `voz-${crypto.randomBytes(6).toString('hex')}.mp3`;
  const filepath = path.join(MEDIA_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return { filename, filepath };
}

// Borra el mp3 despues de mandado: es un archivo de paso, no algo que el
// negocio necesite conservar (a diferencia de las fotos de la biblioteca).
function deleteSpeech(filepath) {
  try {
    fs.unlinkSync(filepath);
  } catch (err) {
    // ya no estaba en disco, no importa
  }
}

module.exports = { generateSpeech, deleteSpeech };

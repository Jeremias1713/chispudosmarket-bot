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
// Voz femenina por defecto (nova). Se puede cambiar con TTS_VOICE en Render: nova o shimmer (mujer), alloy (neutra).
const TTS_VOICE = process.env.TTS_VOICE || 'nova';

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
  sweepOldSpeech();
  const filename = `voz-${crypto.randomBytes(6).toString('hex')}.mp3`;
  const filepath = path.join(MEDIA_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return { filename, filepath };
}

// Borra el mp3 un rato DESPUES de mandado. WhatsApp no baja el archivo en el
// momento en que se le pide el envio: lo descarga despues desde nuestro link
// /media. Si se borra enseguida, Meta encuentra un 404 y el audio nunca le
// llega al cliente (aunque el envio figure como hecho). Por eso se espera.
const SPEECH_TTL_MS = 15 * 60 * 1000;

function deleteSpeech(filepath) {
  try {
    fs.unlinkSync(filepath);
  } catch (err) {
    // ya no estaba en disco, no importa
  }
}

function deleteSpeechLater(filepath, ms = SPEECH_TTL_MS) {
  const t = setTimeout(() => deleteSpeech(filepath), ms);
  if (t.unref) t.unref();
}

// Limpieza de respaldo: si el servidor se reinicio antes de borrar, quedan
// voz-*.mp3 viejos. Se borran los que tengan mas de una hora.
function sweepOldSpeech(now = Date.now(), maxAgeMs = 60 * 60 * 1000) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(MEDIA_DIR)) {
      if (!/^voz-[0-9a-f]+\.mp3$/.test(name)) continue;
      const fp = path.join(MEDIA_DIR, name);
      try {
        if (now - fs.statSync(fp).mtimeMs > maxAgeMs) { fs.unlinkSync(fp); removed++; }
      } catch (e) { /* ya no estaba */ }
    }
  } catch (err) {
    // sin carpeta de media todavia
  }
  return removed;
}

module.exports = { generateSpeech, deleteSpeech, deleteSpeechLater, sweepOldSpeech, SPEECH_TTL_MS };

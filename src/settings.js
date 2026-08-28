// Configuracion editable en vivo desde el panel, sin tener que redesplegar.
// Se guarda en un JSON aparte de sessions.json. Todo lo que este vacio/null
// acá cae al valor por variable de entorno (o al default de cada modulo),
// asi que el bot sigue funcionando igual si nunca se toca esto.
//
// OJO: mismo caveat que sessions.json — en el plan gratis de Render el disco
// no es persistente entre reinicios por inactividad.
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

const DEFAULTS = {
  botEnabled: true,
  businessName: null, // null = usa BUSINESS_NAME del .env
  welcomeMessage: null, // null = usa el saludo por defecto de flow.js
  welcomeImageIds: [], // ids de imagenes de la biblioteca para mandar junto al saludo inicial (puede ser mas de una)
  knowledgeBase: '', // datos de envio/pago/promos que el bot da por ciertos
  openaiModel: null,
  openaiTemperature: null,
  openaiHistoryN: null,
  // Cuanto espera el bot en milisegundos DESPUES del ultimo mensaje del
  // cliente antes de contestar. Si el cliente manda varios mensajes
  // seguidos, cada uno reinicia la espera: el bot recien contesta cuando
  // el cliente se queda callado ese rato.
  replyDelayMs: 8000,
  // Objetivo de palabras por mensaje para una respuesta comun (saludo,
  // confirmar un dato, etc). No es un tope duro: el modelo puede pasarse de
  // esto sin que se le corte el mensaje.
  maxWordsPerMessage: 30,
  // Tope duro de palabras por mensaje: recien si se pasa de ESTO se corta y
  // se reparte en el siguiente mensaje (nunca se descarta texto, lo que
  // sobra se pega al ultimo). Mas alto que el objetivo a proposito, para que
  // el bot pueda explicar un producto, los datos del formulario o la
  // direccion de una agencia sin que le corten la explicacion a la mitad.
  maxWordsHardCap: 90,
  maxMessageParts: 5,
  // Ademas del texto, manda una nota de voz con la misma respuesta.
  audioReplyEnabled: true,
};

function load() {
  let settings;
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch (err) {
    settings = { ...DEFAULTS };
  }
  // Migracion: dato viejo de antes de soportar varias fotos en el saludo
  // (welcomeImageId, una sola imagen) todavia sin migrar a welcomeImageIds.
  if (settings.welcomeImageId && (!Array.isArray(settings.welcomeImageIds) || !settings.welcomeImageIds.length)) {
    settings.welcomeImageIds = [settings.welcomeImageId];
  }
  return settings;
}

function save(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function getSettings() {
  return load();
}

function updateSettings(patch) {
  const settings = { ...load(), ...patch };
  save(settings);
  return settings;
}

module.exports = { getSettings, updateSettings, DEFAULTS };

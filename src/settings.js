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
  knowledgeBase: '', // datos de envio/pago/promos que el bot da por ciertos
  openaiModel: null,
  openaiTemperature: null,
  openaiHistoryN: null,
};

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch (err) {
    return { ...DEFAULTS };
  }
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

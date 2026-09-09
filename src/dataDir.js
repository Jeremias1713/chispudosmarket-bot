// Carpeta base donde viven todos los archivos JSON/CSV persistidos por el bot
// (sessions.json, products.json, settings.json, etc.) y los medios subidos.
//
// Por defecto es data/ junto a src/, exactamente como estaba antes de esto:
// en produccion (Render) BOT_DATA_DIR nunca se define, asi que el
// comportamiento no cambia en nada.
//
// Se agrega esta variable de entorno UNICAMENTE para poder correr pruebas
// automatizadas (carpeta test/) contra una carpeta de datos temporal y
// aislada, sin tocar ni arriesgar los archivos reales del negocio. Ver
// test/helpers/tempDataDir.js.
const path = require('path');

const DATA_DIR = process.env.BOT_DATA_DIR
  ? path.resolve(process.env.BOT_DATA_DIR)
  : path.join(__dirname, '..', 'data');

module.exports = { DATA_DIR };

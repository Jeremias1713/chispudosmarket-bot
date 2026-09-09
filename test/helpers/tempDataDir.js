// Crea una carpeta de datos temporal y aislada para pruebas, y la deja lista
// en process.env.BOT_DATA_DIR ANTES de que cualquier test haga
// require('../src/...'). Ver src/dataDir.js.
//
// IMPORTANTE: esto tiene que llamarse desde la PRIMERA linea del archivo de
// test (antes de cualquier require de src/), porque cada modulo de src/ lee
// BOT_DATA_DIR una sola vez, al cargarse. Si algun otro archivo ya requirio
// ese modulo antes con otra carpeta, Node lo sirve desde cache y este
// aislamiento no tiene efecto (por eso cada archivo de test de esta suite
// crea su PROPIA carpeta temporal, no comparten una global).
const fs = require('fs');
const os = require('os');
const path = require('path');

function setupTempDataDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'chispudos-test-') + '-'));
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  process.env.BOT_DATA_DIR = dir;
  return dir;
}

function writeJson(dir, filename, data) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
}

function writeRaw(dir, filename, text) {
  fs.writeFileSync(path.join(dir, filename), text);
}

function readJson(dir, filename) {
  return JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8'));
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { setupTempDataDir, writeJson, writeRaw, readJson, loadFixture, cleanup };

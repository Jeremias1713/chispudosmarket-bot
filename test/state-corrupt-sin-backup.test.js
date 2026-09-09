// FASE 1 (H04): caso separado de state.test.js porque BOT_DATA_DIR se fija
// una sola vez por archivo de test (al requerir src/state.js), y este caso
// necesita arrancar con el archivo YA corrupto, sin haber pasado nunca por
// saveAll() (o sea, sin ningun backup todavia disponible).
'use strict';
const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('state-sin-backup');
const fs = require('fs');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const state = require('../src/state');

after(() => cleanup(dataDir));

test('H04 - sin ninguna copia de seguridad disponible, un JSON corrupto hace fallar la lectura en vez de sobrescribirlo con datos vacios', () => {
  // Corrupcion "de entrada": nunca se llamo a saveAll(), no existe backup.
  writeRaw(dataDir, 'sessions.json', '{"584120000001": { "card": { ROTO');

  assert.throws(
    () => state.getSession('584120099999'),
    /corrupto/,
    'BUG H04 corregido: sin backup, se falla ruidosamente en vez de continuar con {} y sobrescribir'
  );

  // Y lo mas importante: el archivo corrupto original SIGUE en disco, no se
  // sobreescribio con un {} ni con la sesion nueva a medio crear.
  const raw = fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8');
  assert.match(raw, /ROTO/, 'el archivo corrupto no fue sobrescrito');
});

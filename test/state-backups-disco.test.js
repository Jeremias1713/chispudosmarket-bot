// El disco del servidor se lleno de copias de sessions.json (una por cada
// guardado, 20 copias) y el bot se caia con ENOSPC. Ahora las copias se
// espacian en el tiempo, son pocas, y se limpian al arrancar.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('state-backups-disco');
const fs = require('node:fs');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// Antes de cargar state.js: 12 copias viejas que ya estaban en el disco.
const bdir = path.join(dataDir, 'backups', 'sessions');
fs.mkdirSync(bdir, { recursive: true });
for (let i = 0; i < 12; i++) {
  const n = String(i).padStart(2, '0');
  fs.writeFileSync(path.join(bdir, `sessions-2026-01-01T00-00-${n}-000Z.json`), '{}');
}
fs.writeFileSync(path.join(dataDir, 'sessions.json.tmp'), 'basura');

const state = require('../src/state');

after(() => cleanup(dataDir));

test('al arrancar se dejan solo las ultimas copias y se borra el .tmp suelto', () => {
  const files = fs.readdirSync(bdir);
  assert.equal(files.length, 5);
  assert.ok(files.includes('sessions-2026-01-01T00-00-11-000Z.json'), 'se conservan las mas nuevas');
  assert.equal(fs.existsSync(path.join(dataDir, 'sessions.json.tmp')), false);
});

test('muchos guardados seguidos no crean una copia por cada uno', () => {
  state.updateSession('584120000001', { name: 'A' });
  const before = fs.readdirSync(bdir).length;
  for (let i = 0; i < 25; i++) state.appendMessage('584120000001', 'user', 'hola ' + i);
  const after2 = fs.readdirSync(bdir).length;
  assert.ok(after2 <= 5, 'nunca mas de 5 copias, hay ' + after2);
  assert.ok(after2 - before <= 1, 'a lo sumo una copia nueva en 25 guardados');
});

test('un guardado funciona aunque no se pueda escribir la copia de seguridad', () => {
  // Hace que la carpeta de copias sea un archivo: crear copias va a fallar.
  fs.rmSync(path.join(dataDir, 'backups'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dataDir, 'backups'), 'no soy una carpeta');
  state.appendMessage('584120000001', 'user', 'mensaje que igual debe guardarse');
  const h = state.getSession('584120000001').history;
  assert.equal(h[h.length - 1].content, 'mensaje que igual debe guardarse');
});

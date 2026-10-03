// Limpieza automatica del disco (diskJanitor), reintento ante ENOSPC y
// compactacion de historiales viejos.
'use strict';
const { setupTempDataDir, writeJson, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('disk-janitor');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const janitor = require('../src/diskJanitor');
const state = require('../src/state');

after(() => cleanup(dataDir));

const media = path.join(dataDir, 'media');
const DAY = 24 * 3600 * 1000;

function mk(rel, ageMs) {
  const f = path.join(media, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return f;
}

test('borra media de clientes por antiguedad; el modo agresivo es mas corto', () => {
  const old = mk('audio-in-1.ogg', 40 * DAY);
  const mid = mk('image-in-2.jpg', 10 * DAY);
  const voz = mk('voz-abc.mp3', 2 * 3600 * 1000);
  const vozNueva = mk('voz-new.mp3', 60 * 1000);
  janitor.runOnce();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(mid), true);
  assert.equal(fs.existsSync(voz), false);
  assert.equal(fs.existsSync(vozNueva), true);
  janitor.runOnce({ aggressive: true });
  assert.equal(fs.existsSync(mid), false);
});

test('no borra archivos referenciados en library.json', () => {
  const f = mk('image-in-keep.jpg', 400 * DAY);
  writeJson(dataDir, 'library.json', [{ id: 1, filename: 'image-in-keep.jpg' }]);
  janitor.runOnce({ aggressive: true });
  assert.equal(fs.existsSync(f), true);
});

test('capturas de guias: 50 dias se borra, 20 dias no', () => {
  const a = mk('guias/x.png', 50 * DAY);
  const b = mk('guias/y.png', 20 * DAY);
  janitor.runOnce();
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), true);
});

test('diskUsage nunca rompe e isDiskCritical reacciona a ENOSPC', () => {
  const u = janitor.diskUsage();
  assert.ok(u === null || (u.usedRatio >= 0 && u.usedRatio <= 1));
  janitor.markEnospc();
  assert.equal(janitor.isDiskCritical(), true);
});

test('saveAll con ENOSPC reintenta una vez y guarda', () => {
  const real = fs.writeFileSync;
  let fails = 0;
  fs.writeFileSync = function (p, ...rest) {
    if (String(p).endsWith('sessions.json.tmp') && fails === 0) {
      fails += 1;
      const e = new Error('no space left on device');
      e.code = 'ENOSPC';
      throw e;
    }
    return real.call(fs, p, ...rest);
  };
  try {
    state.updateSession('584120000777', { name: 'Reintento' });
  } finally {
    fs.writeFileSync = real;
  }
  assert.equal(fails, 1);
  assert.equal(state.getSession('584120000777').name, 'Reintento');
});

test('saveAll con ENOSPC persistente relanza el error', () => {
  const real = fs.writeFileSync;
  fs.writeFileSync = function (p, ...rest) {
    if (String(p).endsWith('sessions.json.tmp')) {
      const e = new Error('no space left on device');
      e.code = 'ENOSPC';
      throw e;
    }
    return real.call(fs, p, ...rest);
  };
  try {
    assert.throws(() => state.updateSession('584120000778', { name: 'x' }), /no space/);
  } finally {
    fs.writeFileSync = real;
  }
});

test('compactHistories archiva historiales viejos y no toca chats con actividad reciente', () => {
  const mkHist = (n, endMs) =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, at: new Date(endMs - (n - i) * 60000).toISOString() }));
  const now = Date.now();
  const viejo = mkHist(300, now - 120 * DAY);
  const reciente = mkHist(300, now - 1 * DAY);
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({ '58412A': { history: viejo }, '58412B': { history: reciente } }));
  const archiveDir = path.join(dataDir, 'archive');
  const r = state.compactHistories({ olderThanMs: 90 * DAY, keepLast: 150, archiveDir });
  assert.equal(r.sessions, 1);
  const all = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8'));
  assert.equal(all['58412A'].history.length, 150);
  assert.equal(all['58412A'].historyArchivedCount, 150);
  assert.equal(all['58412B'].history.length, 300);
  const lines = zlib.gunzipSync(fs.readFileSync(path.join(archiveDir, '58412A.jsonl.gz'))).toString().trim().split('\n');
  assert.equal(lines.length, 150);
});

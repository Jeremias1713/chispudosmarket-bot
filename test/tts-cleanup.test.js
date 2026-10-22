'use strict';
// El mp3 de la nota de voz NO se borra apenas se manda: WhatsApp lo descarga
// despues desde /media. Si se borraba enseguida, el audio nunca llegaba.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('tts-cleanup');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MEDIA_DIR } = require('../src/library');
const tts = require('../src/tts');

after(() => cleanup(dataDir));

test('deleteSpeechLater no borra el archivo enseguida', async () => {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const fp = path.join(MEDIA_DIR, 'voz-abc123.mp3');
  fs.writeFileSync(fp, 'x');
  tts.deleteSpeechLater(fp, 30);
  assert.ok(fs.existsSync(fp));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!fs.existsSync(fp));
});

test('sweepOldSpeech borra solo audios viejos', () => {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const viejo = path.join(MEDIA_DIR, 'voz-aaaaaa.mp3');
  const nuevo = path.join(MEDIA_DIR, 'voz-bbbbbb.mp3');
  const foto = path.join(MEDIA_DIR, 'foto.jpg');
  for (const f of [viejo, nuevo, foto]) fs.writeFileSync(f, 'x');
  const hace2h = (Date.now() - 2 * 3600e3) / 1000;
  fs.utimesSync(viejo, hace2h, hace2h);
  fs.utimesSync(foto, hace2h, hace2h);
  assert.equal(tts.sweepOldSpeech(), 1);
  assert.ok(!fs.existsSync(viejo));
  assert.ok(fs.existsSync(nuevo));
  assert.ok(fs.existsSync(foto));
});

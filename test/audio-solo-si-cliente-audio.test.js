// Con audioReplyEnabled apagado, el bot solo contesta con nota de voz si el
// ultimo mensaje del cliente fue una nota de voz.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('audio-espejo');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { shouldSendAudio, setVoiceInbound } = require('../src/flow');
const { getSettings } = require('../src/settings');

after(() => cleanup(dataDir));

test('el valor por defecto de audioReplyOnVoice es true', () => {
  assert.equal(getSettings().audioReplyOnVoice, true);
});

test('apagado: sin audio del cliente no manda audio', () => {
  setVoiceInbound('58411', false);
  assert.equal(shouldSendAudio({ audioReplyEnabled: false, audioReplyOnVoice: true }, '58411'), false);
});

test('apagado: si el cliente mando nota de voz, contesta con audio', () => {
  setVoiceInbound('58412', true);
  assert.equal(shouldSendAudio({ audioReplyEnabled: false, audioReplyOnVoice: true }, '58412'), true);
});

test('si despues el cliente escribe texto, deja de mandar audio', () => {
  setVoiceInbound('58413', true);
  setVoiceInbound('58413', false);
  assert.equal(shouldSendAudio({ audioReplyEnabled: false, audioReplyOnVoice: true }, '58413'), false);
});

test('audioReplyOnVoice apagado: nunca manda audio', () => {
  setVoiceInbound('58414', true);
  assert.equal(shouldSendAudio({ audioReplyEnabled: false, audioReplyOnVoice: false }, '58414'), false);
});

test('audioReplyEnabled prendido: manda siempre (modo anterior)', () => {
  setVoiceInbound('58415', false);
  assert.equal(shouldSendAudio({ audioReplyEnabled: true }, '58415'), true);
});

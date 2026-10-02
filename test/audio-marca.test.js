// El panel debe poder ver cuando el bot mando una nota de voz: se marca el
// ultimo mensaje del bot con audioSent, sin agregar mensajes al historial.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('audio-marca');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { appendMessage, markLastAssistantAudio, getSession } = require('../src/state');

after(() => cleanup(dataDir));

test('marca solo el ultimo mensaje del bot y no agrega mensajes', () => {
  appendMessage('58412', 'user', 'hola');
  appendMessage('58412', 'assistant', 'Hola, como estas');
  appendMessage('58412', 'assistant', 'Que producto buscas');
  markLastAssistantAudio('58412');
  const h = getSession('58412').history;
  assert.equal(h.length, 3);
  assert.equal(h[0].audioSent, undefined);
  assert.equal(h[1].audioSent, undefined);
  assert.equal(h[2].audioSent, true);
  assert.equal(getSession('58412').audioRepliesCount, 1);
});

test('chat inexistente o sin mensajes del bot no falla', () => {
  markLastAssistantAudio('no-existe');
  appendMessage('58413', 'user', 'hola');
  markLastAssistantAudio('58413');
  assert.equal(getSession('58413').history[0].audioSent, undefined);
});

// Punto 7 del pedido: "Prepara una prueba con temperatura 0.2, sin cambiar
// produccion, el modelo ni top_p." Esto NO cambia ningun default de
// produccion (openaiTemperature sigue null por defecto en settings.js, y
// sin nada configurado ai.js sigue usando OPENAI_TEMPERATURE/0.7 como
// siempre) -- solo agrega la prueba controlada que exige el pedido: fijar
// 0.2 desde Configuracion y verificar que efectivamente se le manda asi a
// OpenAI, sin tocar el modelo configurado ni agregar top_p (que no es un
// parametro que este bot use en ningun lado).
//
// El modulo 'openai' real hace una llamada de red; para esta prueba
// controlada se reemplaza por un mock ANTES de requerir src/ai.js (mismo
// mecanismo que ya usa el resto de la suite para mockear dependencias:
// pisar lo que exporta el modulo antes del primer require en cada archivo).
'use strict';
const Module = require('module');
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('ai-temperature');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { updateSettings } = require('../src/settings');

const llamadasRecibidas = [];

class FakeOpenAI {
  constructor() {
    this.chat = {
      completions: {
        create: async (args) => {
          llamadasRecibidas.push(args);
          return { choices: [{ message: { content: 'Respuesta de prueba, sin tool calls.', tool_calls: null } }] };
        },
      },
    };
  }
}

// Intercepta require('openai') SOLO para este archivo de test, antes de que
// ai.js (requerido mas abajo) haga su propio require('openai').
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'openai') return FakeOpenAI;
  return originalLoad.apply(this, arguments);
};

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-fake-key';
const ai = require('../src/ai');

after(() => {
  Module._load = originalLoad;
  cleanup(dataDir);
});

test('temperatura 0.2 desde Configuracion se manda tal cual a OpenAI, sin tocar el modelo ni agregar top_p', async () => {
  updateSettings({ openaiTemperature: 0.2 }); // NO se toca openaiModel: sigue el default de siempre
  llamadasRecibidas.length = 0;

  await ai.getAssistantReply([], 'hola', null, null, false, false, null, {});

  assert.equal(llamadasRecibidas.length, 1, 'tiene que haber llamado a OpenAI una sola vez (el modelo no llamo ninguna herramienta)');
  const llamada = llamadasRecibidas[0];
  assert.equal(llamada.temperature, 0.2, 'la temperatura configurada (0.2) tiene que llegar tal cual a la llamada real');
  assert.equal('top_p' in llamada, false, 'esta prueba no puede agregar top_p: el bot no usa ese parametro');
});

test('sin nada configurado en Configuracion, la temperatura por defecto de produccion sigue igual (no se toco ningun default)', async () => {
  updateSettings({ openaiTemperature: null });
  llamadasRecibidas.length = 0;

  await ai.getAssistantReply([], 'hola', null, null, false, false, null, {});

  const llamada = llamadasRecibidas[0];
  const esperado = parseFloat(process.env.OPENAI_TEMPERATURE || '0.7');
  assert.equal(llamada.temperature, esperado, 'sin override en Configuracion, la temperatura tiene que seguir siendo la de siempre (env o 0.7)');
});

// Reproduce H31: un filtro de campana incompleto (scope='stage' con stage
// vacio, o scope desconocido) selecciona a TODOS los clientes en vez de
// rechazar la peticion.
'use strict';
const { setupTempDataDir, writeRaw, loadFixture, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('broadcasts');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const broadcasts = require('../src/broadcasts');

after(() => cleanup(dataDir));

function sesionesMixtas() {
  const nombresParecidos = loadFixture('sesiones-nombres-parecidos.json'); // ambas 'interesado'/'nuevo'
  const dosPedidos = loadFixture('sesiones-dos-pedidos-mismo-cliente.json'); // 'entregado' (vendido)
  return { ...nombresParecidos, ...dosPedidos };
}

test('H31 - {scope:"stage", stage:""} devuelve TODOS los telefonos, no ninguno', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify(sesionesMixtas()));

  const targets = broadcasts.resolveTargets({ scope: 'stage', stage: '' });

  // FASE 4 (H31): un filtro de etapa vacio deberia rechazarse (400) antes de
  // resolver telefonos, no caer al "else" que devuelve todas las sesiones.
  assert.equal(targets.length, 3, 'BUG H31: stage vacio trae las 3 sesiones (vendidas y nuevas mezcladas)');
});

test('H31 - un scope desconocido tambien cae en "todos"', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify(sesionesMixtas()));

  const targets = broadcasts.resolveTargets({ scope: 'algo_que_no_existe' });

  assert.equal(targets.length, 3, 'BUG H31: un scope no reconocido deberia rechazarse, no tratarse como "todos"');
});

test('H31 (caso bueno, para no romperlo al reparar) - {scope:"stage", stage:"entregado"} SI filtra correctamente', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify(sesionesMixtas()));

  const targets = broadcasts.resolveTargets({ scope: 'stage', stage: 'entregado' });

  assert.deepEqual(targets, ['584120000003']);
});

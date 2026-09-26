'use strict';
// Catalogo de oficinas Tealca para la lista desplegable del panel: consulta
// lenta con reintento y copia guardada en disco. Todo simulado, sin red.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-oficinas-catalogo');
const fs = require('node:fs');
const path = require('node:path');
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const automation = require('../src/dropanasOrderAutomation');

const originalGet = axios.get;
after(() => { axios.get = originalGet; cleanup(dataDir); });

const OFFICES = [
  { id: 3, nombre: 'Tealca Valencia Centro', ciudad: 'Valencia', estado: 'Carabobo' },
  { id: 1, nombre: 'Tealca Punto Fijo', ciudad: 'Punto Fijo', estado: 'Falcón' },
  { id: 2, nombre: 'Tealca Coro', ciudad: 'Coro', estado: 'Falcón' },
];
let calls = 0;
let failures = 0;
let lastTimeout = 0;

beforeEach(() => {
  process.env.DROPANAS_API_ENABLED = 'true';
  process.env.DROPANAS_API_READ_ONLY_ACK = 'true';
  process.env.DROPANAS_API_TOKEN = 'live_sk_prueba';
  calls = 0;
  failures = 0;
  fs.rmSync(path.join(dataDir, 'dropanas-oficinas.json'), { force: true });
  automation.resetOfficeCache();
  axios.get = async (url, options) => {
    if (!url.endsWith('/oficinas')) throw new Error('inesperado ' + url);
    calls += 1;
    lastTimeout = options.timeout;
    if (failures > 0) {
      failures -= 1;
      throw Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' });
    }
    return { headers: { 'x-dropanas-mode': 'live' }, data: { data: OFFICES } };
  };
});

test('sin texto devuelve todas las oficinas ordenadas por estado y nombre', async () => {
  const result = await automation.searchOffices('', 3000);
  assert.deepEqual(result.offices.map((o) => o.id), [3, 2, 1]);
  assert.equal(result.total, 3);
  assert.equal(result.source, 'dropanas');
  assert.ok(lastTimeout >= 60000, 'la consulta de oficinas usa un timeout largo');
});

test('si DroPanas tarda una vez, reintenta y la lista sale igual', async () => {
  failures = 1;
  const result = await automation.searchOffices('coro', 25);
  assert.equal(calls, 2);
  assert.deepEqual(result.offices.map((o) => o.id), [2]);
});

test('si DroPanas falla, usa la ultima copia buena guardada', async () => {
  await automation.searchOffices('', 3000);
  automation.resetOfficeCache();
  failures = 99;
  const result = await automation.searchOffices('', 3000);
  assert.equal(result.total, 3);
  assert.equal(result.source, 'copia');
  assert.equal(result.warning, null);
});

test('sin copia guardada y con DroPanas caido, avisa el motivo', async () => {
  failures = 99;
  const result = await automation.searchOffices('', 3000);
  assert.equal(result.total, 0);
  assert.match(result.warning, /oficinas/);
});

test('la lista buena queda en cache: no se vuelve a consultar en cada apertura', async () => {
  await automation.searchOffices('', 3000);
  await automation.searchOffices('valencia', 25);
  assert.equal(calls, 1);
});

// FASE 3: cubre H05 (el cruce por nombre puede elegir a la persona
// equivocada) y H12 (montos mal interpretados: vacio -> '0bs', texto con
// separador de miles interpretado como decimal). Estos tests documentaban
// el bug original; ahora que src/nameMatch.js y src/seguimiento.js
// (matchCliente/formatMonto) se repararon, verifican el comportamiento
// correcto y sirven de regresion.
'use strict';
const { setupTempDataDir, writeRaw, loadFixture, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('seguimiento');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const seguimiento = require('../src/seguimiento');

after(() => cleanup(dataDir));

// matchCliente no esta exportado (es interno a seguimiento.js); se ejerce a
// traves de buildPreview(), que si es publico y expone matchType/candidates
// para cada fila en su resultado.

test('H05 (reparado) - "Ana" contra "Ana Isabel" y "Ana María" ya NO da "exacto": queda "ambiguo" con las dos como sugerencia', () => {
  const fixture = loadFixture('sesiones-nombres-parecidos.json');
  writeRaw(dataDir, 'sessions.json', JSON.stringify(fixture));

  // "Ana" es una sola palabra: comparte una palabra con "Ana María" y con
  // "Ana Isabel", pero eso es evidencia demasiado debil para decidir solo
  // (ver src/nameMatch.js, compareNames). Antes esto daba "exacto" con
  // cualquiera de las dos sesiones (bug); ahora queda "ambiguo" con ambas
  // como sugerencia, para que el negocio elija a mano.
  const [resultado] = seguimiento.buildPreview([
    { guia: 'X', cliente: 'Ana', ciudad: '', producto: '', estadoPedido: 'sin dato', totalVentaBs: '', bodegaDestino: '' },
  ]);

  assert.equal(resultado.matchType, 'ambiguo');
  assert.equal(resultado.candidates.length, 2);
});

test('H05 (caso bueno, para no romperlo al reparar) - nombre completo exacto de una fixtura sigue dando "exacto"', () => {
  const fixture = loadFixture('sesiones-nombres-parecidos.json');
  writeRaw(dataDir, 'sessions.json', JSON.stringify(fixture));

  const [resultado] = seguimiento.buildPreview([
    { guia: 'X', cliente: 'Ana María', ciudad: '', producto: '', estadoPedido: 'sin dato', totalVentaBs: '', bodegaDestino: '' },
  ]);
  assert.equal(resultado.matchType, 'exacto');
  assert.equal(resultado.candidates.length, 1);
  assert.equal(resultado.phone, '584120000001');
});

test('H12 (reparado) - un monto vacio en el Excel ya NO se convierte en "0bs": se manda el respaldo "-"', () => {
  const filas = loadFixture('excel-filas.json');
  const filaSinMonto = filas.find((f) => f.guia === 'GU-000113');
  const preview = seguimiento.buildPreview([filaSinMonto]);

  // formatMonto('') ahora devuelve '' (nunca "0bs"), y buildPreview usa su
  // propio respaldo '-' para ese caso (igual que hace con el resto de las
  // variables de plantilla) en vez de mandarle un precio inventado al
  // cliente.
  assert.equal(preview[0].plantillaVars.monto, '-');
});

test('H12 (reparado) - "38.900" (formato venezolano, punto = separador de miles) ahora da "38900bs", no "38.90bs"', () => {
  const filas = loadFixture('excel-filas.json');
  const filaConSeparadorDeMiles = filas.find((f) => f.guia === 'GU-000112');
  const preview = seguimiento.buildPreview([filaConSeparadorDeMiles]);

  assert.equal(preview[0].plantillaVars.monto, '38900bs');
});

test('H12 (reparado) - formatMonto/parseMontoBs: casos venezolanos comunes', () => {
  assert.equal(seguimiento.formatMonto(''), '');
  assert.equal(seguimiento.formatMonto(null), '');
  assert.equal(seguimiento.formatMonto(undefined), '');
  assert.equal(seguimiento.formatMonto('no es un numero'), '');
  assert.equal(seguimiento.formatMonto(38900), '38900bs'); // numero real de la celda, sin tocar
  assert.equal(seguimiento.formatMonto('38900'), '38900bs'); // texto sin separadores
  assert.equal(seguimiento.formatMonto('38.900'), '38900bs'); // punto de miles
  assert.equal(seguimiento.formatMonto('1.234.567'), '1234567bs'); // varios grupos de miles
  assert.equal(seguimiento.formatMonto('38.90'), '38.90bs'); // 2 decimales reales, no es de miles
  assert.equal(seguimiento.formatMonto('38.900,50'), '38900.50bs'); // miles + decimal venezolano
});
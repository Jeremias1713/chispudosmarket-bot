// Reproduce H05 (el cruce por nombre puede elegir a la persona equivocada)
// y H12 (montos mal interpretados: vacio -> '0bs', texto con separador de
// miles interpretado como decimal).
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

test('H05 - "Ana" contra "Ana Isabel" y "Ana María" da falso "exacto" por substring', () => {
  const fixture = loadFixture('sesiones-nombres-parecidos.json');
  writeRaw(dataDir, 'sessions.json', JSON.stringify(fixture));

  // Ninguna de las dos sesiones se llama exactamente "Ana": matchCliente usa
  // includes() en ambos sentidos, asi que "Ana" (mas corto) queda contenido
  // dentro de "Ana María" Y de "Ana Isabel".
  const [resultado] = seguimiento.buildPreview([
    { guia: 'X', cliente: 'Ana', ciudad: '', producto: '', estadoPedido: 'sin dato', totalVentaBs: '', bodegaDestino: '' },
  ]);

  // FASE 3 (H05): el hallazgo pide que esto se resuelva con identificador de
  // pedido/guia o telefono, y que un nombre corto ambiguo quede como
  // 'ambiguo' o 'sin_match', nunca como 'exacto'.
  assert.equal(resultado.candidates.length, 2, 'BUG H05: "Ana" hace match parcial con las dos sesiones');
  assert.notEqual(
    resultado.matchType,
    'exacto',
    'BUG H05: con dos candidatas esto ya deberia ser "ambiguo", no "exacto" (si esto falla es porque el codigo mejoro)'
  );
});

test('H05 (caso bueno, para no romperlo al reparar) - nombre completo exacto de una fixture sigue dando "exacto"', () => {
  const fixture = loadFixture('sesiones-nombres-parecidos.json');
  writeRaw(dataDir, 'sessions.json', JSON.stringify(fixture));

  const [resultado] = seguimiento.buildPreview([
    { guia: 'X', cliente: 'Ana María', ciudad: '', producto: '', estadoPedido: 'sin dato', totalVentaBs: '', bodegaDestino: '' },
  ]);
  assert.equal(resultado.matchType, 'exacto');
  assert.equal(resultado.candidates.length, 1);
  assert.equal(resultado.phone, '584120000001');
});

test('H12 - un monto vacio en el Excel se convierte en "0bs" (indistinguible de una venta real de 0)', () => {
  const filas = loadFixture('excel-filas.json');
  const filaSinMonto = filas.find((f) => f.guia === 'GU-000113');
  const preview = seguimiento.buildPreview([filaSinMonto]);

  // FASE 3 (H12): un monto vacio no deberia convertirse en "0bs". Number('')
  // es 0 en JavaScript, asi que formatMonto('') produce "0bs" igual que un
  // monto real de cero bolivares — no hay forma de distinguirlos hoy.
  assert.equal(preview[0].plantillaVars.monto, '0bs', 'BUG H12: vacio se interpreta como 0bs en vez de "sin dato"');
});

test('H12 - "38.900" (treinta y ocho mil, formato venezolano) se trunca a "38.90bs" (treinta y ocho con noventa)', () => {
  const filas = loadFixture('excel-filas.json');
  const filaConSeparadorDeMiles = filas.find((f) => f.guia === 'GU-000112');
  const preview = seguimiento.buildPreview([filaConSeparadorDeMiles]);

  // El texto '38.900' en un export venezolano tipicamente significa 38.900
  // bolivares (punto como separador de miles). formatMonto lo interpreta
  // como Number('38.900') = 38.9, y lo redondea a 2 decimales: "38.90bs".
  // FASE 3 (H12): hace falta una regla explicita de lectura del Excel
  // (separador de miles vs. decimal) antes de formatear, no asumir que todo
  // texto numerico ya viene en el formato de JS.
  assert.equal(preview[0].plantillaVars.monto, '38.90bs', 'BUG H12: "38.900" bolivares se interpreta como 38,90 en vez de 38.900');
});
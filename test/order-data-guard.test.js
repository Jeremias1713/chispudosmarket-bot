const test = require('node:test');
const assert = require('node:assert/strict');
const { missingOrderData, missingDataMessage } = require('../src/orderDataGuard');
const { looksLikeEmptyDataRequest } = require('../src/ai');

const ASK = '📦 Para procesar tu pedido envíanos:\n👤 Nombre y apellido:\n🆔 Cédula:\n📞 Teléfono:';
const run = (history, userText, card) =>
  missingOrderData({ card, history, userText, requestMarker: looksLikeEmptyDataRequest });

test('sin haber pedido los datos: faltan los tres', () => {
  const h = [{ role: 'user', content: 'Quiero 1 frasco' }, { role: 'assistant', content: 'Dime la ciudad' }, { role: 'user', content: 'Ciudad Ojeda' }];
  assert.deepEqual(run(h, 'Correcto', {}), ['nombre', 'cedula', 'telefono']);
});

test('cedula tomada como telefono: sigue faltando el telefono', () => {
  const h = [{ role: 'assistant', content: ASK }];
  assert.deepEqual(run(h, 'Alejandro Rodríguez. 15152198', {}), ['telefono']);
});

test('"este numero" cuenta como telefono', () => {
  const h = [{ role: 'assistant', content: ASK }, { role: 'user', content: 'Alejandro Rodríguez 15152198' }];
  assert.deepEqual(run(h, 'Es este', {}), []);
});

test('datos completos en un mensaje, con separadores', () => {
  const h = [{ role: 'assistant', content: ASK }];
  assert.deepEqual(run(h, 'Miguel Alvaracín, V-25.379.216, 0412-1741-347', {}), []);
});

test('datos ya en la ficha no se vuelven a pedir', () => {
  assert.deepEqual(run([], 'ok', { nombre: 'Ana Perez', cedula: '123456', telefono: '04141234567' }), []);
});

test('mensaje de lo que falta nombra solo los campos faltantes', () => {
  assert.match(missingDataMessage(['cedula']), /cédula/);
  assert.doesNotMatch(missingDataMessage(['cedula']), /teléfono/);
  assert.match(missingDataMessage(['nombre', 'telefono']), /nombre y apellido y número de teléfono/);
});

test('telefono con espacio tras la operadora y datos pegados en una linea', () => {
  const h = [{ role: 'assistant', content: ASK }];
  assert.deepEqual(run(h, 'José Rodríguez, cédula 13456789, teléfono 0414 7712345', {}), []);
  assert.deepEqual(run(h, 'Diego Muro 32159800 04245228325', {}), []);
  assert.deepEqual(run(h, 'Elio Martinez c.i 9612345 0412 9234567', {}), []);
});

test('datos dados antes de que el bot los pidiera tambien cuentan', () => {
  const h = [{ role: 'user', content: 'Ana Perez 12345678 04141234567' }, { role: 'assistant', content: ASK }];
  assert.deepEqual(run(h, 'ok', {}), []);
});

test('numero con prefijo de pais cuenta como telefono', () => {
  const h = [{ role: 'assistant', content: ASK }];
  assert.deepEqual(run(h, 'Ramón Rodríguez 25785764 +573151130288', {}), []);
});

test('solo un mensaje de resumen cuenta como cierre a bloquear', () => {
  const { looksLikeOrderSummary } = require('../src/orderDataGuard');
  assert.equal(looksLikeOrderSummary('Hacemos el pedido, te enviamos la guía de Tealca y el pago es contra entrega.'), false);
  assert.equal(looksLikeOrderSummary('Aquí va el resumen de tu pedido: 1 frasco. Pago contra entrega, guía de Tealca.'), true);
});

test('formatos reales de clientes: puntos suspensivos, grupos con espacios', () => {
  const h = [{ role: 'assistant', content: ASK }];
  assert.deepEqual(run(h, 'Henry rodriguez...5712345...04145551234..', {}), []);
  assert.deepEqual(run(h, 'Okay yosmart Mendoza cédula 13 818 930 teléfono 0412 971 4955', {}), []);
  assert.deepEqual(run(h, 'Marin Angel C.I.13 107 805 Cel. 0424 666 8212', {}), []);
  assert.deepEqual(run(h, 'Elbis Lopez...13555444...04145551234', {}), []);
});

test('una cantidad suelta no se confunde con cedula ni telefono', () => {
  const h = [{ role: 'assistant', content: ASK }];
  assert.deepEqual(run(h, 'Quiero 2 frascos, Juan Perez', {}), ['cedula', 'telefono']);
});

test('formatos raros: coma, guion bajo, cedula con V., operadora desconocida', () => {
  const h = [{ role: 'assistant', content: ASK }];
  assert.deepEqual(run(h, 'Jose luis vera gutierrez 12.345.678 0414,1234567', {}), []);
  assert.deepEqual(run(h, 'Silverio González Brito 1234567 0414_1234567', {}), []);
  assert.deepEqual(run(h, 'Elio jesus martinez ,c,i 9612345 0422 9212345', {}), []);
  assert.deepEqual(run(h, 'Juan.Antonio.Perez V.12.345.678 +57.315.1130288', {}), []);
});

test('cedula que contiene un 4 pegada al telefono no se come el telefono', () => {
  const h = [{ role: 'assistant', content: ASK }];
  assert.deepEqual(run(h, 'Ana Gomez 14412345 04145551234', {}), []);
  assert.deepEqual(run(h, 'Ana Gomez 13555444...04145551234', {}), []);
  assert.deepEqual(run(h, 'Ana Gomez 04145551234', {}), ['cedula']);
});

test('telefono con guion bajo en un solo bloque', () => {
  const h = [{ role: 'assistant', content: ASK }];
  assert.deepEqual(run(h, 'Silverio González Brito 12345678 999_99999999', {}), []);
});

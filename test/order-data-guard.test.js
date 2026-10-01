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

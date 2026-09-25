// Pedido del negocio: los "5 dias habiles para retirar" se dicen SOLO en el
// mensaje de cierre del pedido. Despues (pedido en camino, ya en la agencia,
// despues del aviso/plantilla de llegada) el bot no debe recordarlo: le da
// margen al cliente para dejarlo para despues y aumenta las devoluciones.
// Caso real: "Recuerda que tienes 5 dias habiles para retirar tu pedido" en
// conversaciones que ya estaban en Esperando retiro.
const assert = require('assert');
const { test } = require('node:test');
const { buildSystemPrompt } = require('../src/ai');

test('el cierre del pedido sigue incluyendo los 5 dias habiles', () => {
  const prompt = buildSystemPrompt(null, 'Turkesterone', false, false, null, null);
  assert.match(prompt, /va a tener 5 dias habiles para pasar a retirarlo/);
});

test('hay una regla que prohibe repetir el plazo despues del cierre', () => {
  const prompt = buildSystemPrompt(null, 'Turkesterone', true, true, 'esperando_retiro', null);
  assert.match(prompt, /PLAZO DE RETIRO \(INQUEBRANTABLE\)/);
  assert.match(prompt, /NUNCA mas los vuelvas a mencionar/);
  assert.match(prompt, /lo antes posible/);
});

test('con el pedido ya en la agencia, el estado del envio pide no mencionar el plazo', () => {
  const prompt = buildSystemPrompt(null, 'Turkesterone', true, true, 'esperando_retiro', null);
  assert.match(prompt, /ESTADO DEL ENVIO[^\n]*YA LLEGO[^\n]*NUNCA le menciones el plazo de 5 dias habiles/);
});

// Prueba de la unica modificacion comercial de esta recuperacion (punto 6 del
// pedido del negocio): el bot ya NO debe ofrecer entrega a domicilio en
// ningun caso, ni siquiera en Caracas (que en la version anterior a la
// regresion SI la ofrecia primero). Se verifica directamente sobre el texto
// que arma buildSystemPrompt, que es la unica fuente de esa instruccion en
// esta version del codigo (no hay una funcion de validacion aparte que lo
// garantice a nivel de codigo -- por diseno, ver punto 8 del pedido: no se
// agregan capas nuevas de validacion en esta recuperacion).
const assert = require('assert');
const { test } = require('node:test');
const { buildSystemPrompt } = require('../src/ai');

// El prompt SI puede mencionar la palabra "domicilio" -- pero solo dentro de
// una frase que la NIEGA (instruyendole al bot que no la ofrezca). Lo que
// nunca puede aparecer es una frase que la OFREZCA como opcion real.
const OFRECE_DOMICILIO_RE = /(prefiere domicilio|domicilio primero|ofrecele.*domicilio|hay dos formas de recibirlo|si es domicilio en caracas|si elige domicilio)/i;

test('buildSystemPrompt: Caracas ya NO ofrece domicilio, solo agencia', () => {
  const prompt = buildSystemPrompt('Caracas', null, false, false, null, null);
  assert.doesNotMatch(
    prompt,
    OFRECE_DOMICILIO_RE,
    'BUG: el prompt todavia ofrece domicilio como opcion en Caracas'
  );
  assert.match(
    prompt,
    /toda venezuela.*caracas incluida.*solo se retira en agencia/is,
    'BUG: no se encontro la regla de "toda Venezuela, Caracas incluida, solo agencia" en el prompt'
  );
});

test('buildSystemPrompt: resto de Venezuela sigue sin domicilio (no debia cambiar)', () => {
  const prompt = buildSystemPrompt('Maracaibo', null, false, false, null, null);
  assert.doesNotMatch(prompt, OFRECE_DOMICILIO_RE);
});

test('buildSystemPrompt: sin ciudad conocida, el prompt tampoco ofrece domicilio', () => {
  const prompt = buildSystemPrompt(null, null, false, false, null, null);
  assert.doesNotMatch(prompt, OFRECE_DOMICILIO_RE);
});

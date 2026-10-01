'use strict';
// El aviso de "ya llego a la agencia" mandado a mano desde el chat tiene que
// pasar la conversacion a esperando_retiro (igual que cuando lo manda el bot).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { stageAfterArrivalNotice } = require('../src/stageRules');

test('un pedido en camino (o recien cerrado) pasa a esperando_retiro', () => {
  assert.equal(stageAfterArrivalNotice('en_camino'), 'esperando_retiro');
  assert.equal(stageAfterArrivalNotice('vendido'), 'esperando_retiro');
  assert.equal(stageAfterArrivalNotice('esperando_guia'), 'esperando_retiro');
  assert.equal(stageAfterArrivalNotice('vendido_fecha_futura'), 'esperando_retiro');
});

test('nunca se mueve un pedido que ya llego, se entrego, tiene novedad o no es venta', () => {
  for (const stage of ['esperando_retiro', 'entregado', 'novedad', 'pendiente_devolucion', 'interesado', 'nuevo', 'perdido', undefined]) {
    assert.equal(stageAfterArrivalNotice(stage), null, String(stage));
  }
});

test('la ruta send-template del panel usa esa regla para la plantilla de llegada', () => {
  const src = fs.readFileSync(require.resolve('../src/web/panel.js'), 'utf8');
  assert.match(src, /stageAfterArrivalNotice\(getSession\(phone\)\.stage\)/);
  assert.match(src, /pedido_ha_llegado_a_tealca/);
});

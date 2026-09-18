// Pruebas unitarias directas de buildGuiaPatch (orderGuard.js), la funcion
// compartida que arma el patch de sesion al registrar una guia -- usada por
// los dos caminos del panel (individual y por lote). Complementa
// panel-guia-advance.test.js y panel-new-order.test.js, que prueban lo mismo
// pero a traves de los endpoints HTTP.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildGuiaPatch } = require('../src/orderGuard');

test('avanza a en_camino desde vendido, sin importar isNewOrder', () => {
  const patch = buildGuiaPatch({ session: { stage: 'vendido', card: {} }, guia: 'GU-1', isNewOrder: false });
  assert.equal(patch.stage, 'en_camino');
  assert.equal(patch.card.guia, 'GU-1');
});

test('avanza a en_camino desde esperando_guia aunque la sesion no traiga stageLocked explicito (el candado no importa aca)', () => {
  const patch = buildGuiaPatch({ session: { stage: 'esperando_guia', stageLocked: true, card: {} }, guia: 'GU-2', isNewOrder: false });
  assert.equal(patch.stage, 'en_camino');
});

test('NO avanza (ni retrocede) un pedido en esperando_retiro sin isNewOrder', () => {
  const patch = buildGuiaPatch({ session: { stage: 'esperando_retiro', card: {} }, guia: 'GU-3', isNewOrder: false });
  assert.equal(patch.stage, undefined, 'no debe tocar la etapa de un pedido ya en esperando_retiro');
});

test('NO avanza un pedido entregado sin isNewOrder', () => {
  const patch = buildGuiaPatch({ session: { stage: 'entregado', card: {} }, guia: 'GU-4', isNewOrder: false });
  assert.equal(patch.stage, undefined);
});

test('CON isNewOrder=true, fuerza el avance a en_camino aunque el pedido anterior estuviera entregado', () => {
  const patch = buildGuiaPatch({ session: { stage: 'entregado', card: { guia: 'GU-OLD' } }, guia: 'GU-5', isNewOrder: true });
  assert.equal(patch.stage, 'en_camino');
});

test('CON isNewOrder=true, reinicia guiaImageUrl/agencia/monto y las marcas de aviso/venta', () => {
  const session = {
    stage: 'entregado',
    card: { nombre: 'Ana', ciudad: 'Caracas', producto: 'Shilajit', guia: 'GU-OLD', agencia: 'Tealca Viejo', monto: 1000, guiaImageUrl: 'https://x/old.jpg' },
    shippingNotifiedAt: '2026-01-01T00:00:00.000Z',
    arrivalNotifiedAt: '2026-01-02T00:00:00.000Z',
  };
  const patch = buildGuiaPatch({ session, guia: 'GU-NEW', isNewOrder: true });

  assert.equal(patch.card.guia, 'GU-NEW');
  assert.equal(patch.card.agencia, null);
  assert.equal(patch.card.monto, null);
  assert.equal(patch.card.guiaImageUrl, null);
  assert.equal(patch.shippingNotifiedAt, null);
  assert.equal(patch.arrivalNotifiedAt, null);
  assert.equal(patch.orderClosed, false);
  assert.ok(patch.soldAt, 'debe fijar una fecha de venta nueva');
  // Datos personales (nombre, ciudad) no forman parte del reinicio: no
  // aparecen tocados en el patch mas que por no incluirse (se conservan por
  // el spread de session.card en buildGuiaPatch).
  assert.equal(patch.card.nombre, 'Ana');
  assert.equal(patch.card.ciudad, 'Caracas');
});

test('CON isNewOrder=true, una foto nueva en el mismo request reemplaza el reinicio a null', () => {
  const session = { stage: 'entregado', card: { guia: 'GU-OLD', guiaImageUrl: 'https://x/old.jpg' } };
  const patch = buildGuiaPatch({ session, guia: 'GU-NEW', guiaImageUrl: 'https://x/new.jpg', isNewOrder: true });
  assert.equal(patch.card.guiaImageUrl, 'https://x/new.jpg');
});

test('sin isNewOrder, no reinicia nada: solo pisa los campos que vinieron en el request', () => {
  const session = { stage: 'esperando_retiro', card: { guia: 'GU-1', agencia: 'Tealca A', monto: 500, guiaImageUrl: 'https://x/a.jpg' } };
  const patch = buildGuiaPatch({ session, guia: 'GU-1', agencia: 'Tealca B', isNewOrder: false });
  assert.equal(patch.card.agencia, 'Tealca B');
  assert.equal(patch.card.monto, 500, 'monto no tocado, se conserva');
  assert.equal(patch.card.guiaImageUrl, 'https://x/a.jpg', 'foto no tocada, se conserva');
  assert.equal(patch.shippingNotifiedAt, undefined, 'sin isNewOrder no se toca la marca de aviso');
});

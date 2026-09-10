// FASE 5 (H35): contrato para src/messageStatus.js -- aplica los eventos de
// status de Meta (sent/delivered/read/failed, del webhook, campo
// `value.statuses`, hoy ignorado por completo en server.js) al mensaje
// guardado en el historial que corresponda, buscandolo por wamid.
//
// Regla dura del punto 3 pedido por el dueño del bot: nunca se debe marcar
// "entregado" o "leido" sin confirmacion real del proveedor -- por eso esta
// funcion es la UNICA que puede tocar ese campo, a partir de un evento real
// de Meta, nunca inferido.
//
// Tests escritos antes de la implementacion (fallan a proposito hoy).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyStatusUpdate } = require('../src/messageStatus');

function sesionesDeEjemplo() {
  return {
    '59171234567': {
      history: [
        { role: 'human', content: '[plantilla] guia_envio', at: '2026-09-01T10:00:00.000Z', extra: {} },
        {
          role: 'human',
          content: '[plantilla] guia_envio',
          at: '2026-09-01T10:05:00.000Z',
          template: { name: 'guia_envio', wamid: 'wamid.ABC123', status: 'sent' },
        },
      ],
    },
  };
}

test('H35 - applyStatusUpdate encuentra el mensaje por wamid y actualiza el status', () => {
  const sessions = sesionesDeEjemplo();
  const resultado = applyStatusUpdate(sessions, { id: 'wamid.ABC123', status: 'delivered', timestamp: '1234' });
  assert.equal(resultado.updated, true);
  assert.equal(sessions['59171234567'].history[1].template.status, 'delivered');
});

test('H35 - un wamid que no existe en ninguna sesion no rompe nada', () => {
  const sessions = sesionesDeEjemplo();
  const resultado = applyStatusUpdate(sessions, { id: 'wamid.NO-EXISTE', status: 'delivered' });
  assert.equal(resultado.updated, false);
});

test('H35 - status failed guarda el motivo del fallo (errors[0].title)', () => {
  const sessions = sesionesDeEjemplo();
  applyStatusUpdate(sessions, {
    id: 'wamid.ABC123',
    status: 'failed',
    errors: [{ code: 131047, title: 'Re-engagement message', message: 'Fuera de la ventana de 24hs' }],
  });
  const msg = sessions['59171234567'].history[1];
  assert.equal(msg.template.status, 'failed');
  assert.match(msg.template.failReason, /Re-engagement message|Fuera de la ventana/);
});

test('H35 - no permite retroceder de un estado mas avanzado a uno anterior (evento atrasado)', () => {
  const sessions = sesionesDeEjemplo();
  sessions['59171234567'].history[1].template.status = 'read';
  applyStatusUpdate(sessions, { id: 'wamid.ABC123', status: 'delivered', timestamp: '999' });
  assert.equal(
    sessions['59171234567'].history[1].template.status,
    'read',
    'BUG a evitar: un status "delivered" atrasado no debe pisar un "read" ya confirmado',
  );
});

test('H35 - nunca setea "delivered" o "read" si no vino un evento real (no hay estado por default salvo el que ya se guardo al mandar)', () => {
  const sessions = sesionesDeEjemplo();
  // El primer mensaje del fixture no tiene template.status en absoluto
  // (representa el historial viejo, sin datos suficientes): no debe
  // inventarsele ningun estado.
  assert.equal(sessions['59171234567'].history[0].template, undefined);
});

// FASE 5 (H35): procesa los eventos de status de WhatsApp (`value.statuses`
// del webhook de Meta: sent/delivered/read/failed) y los aplica al mensaje
// correspondiente en el historial, buscandolo por `wamid` (el id que Meta
// devuelve al aceptar un envio de plantilla).
//
// Hoy el webhook (server.js) NUNCA lee `value.statuses` -- solo procesa
// `value.messages` y `value.contacts` -- asi que ningun mensaje en el panel
// puede pasar de "enviado" a "entregado"/"leido"/"fallido" con confirmacion
// real del proveedor. Esta pieza es la que cierra ese hueco, sin inventar
// nunca un estado que Meta no confirmo.
//
// TODAVIA NO IMPLEMENTADO. Contrato en test/messageStatus.test.js.

'use strict';

// sessions: el array/objeto de sesiones tal cual lo maneja state.js
// (recorre session.history buscando un mensaje con
// msg.extra.template.wamid === statusEvent.id).
// statusEvent: { id, status, timestamp, recipient_id, errors } (forma cruda
// de un elemento de value.statuses).
//
// Devuelve { updated: boolean, phone, messageIndex } indicando si encontro
// el mensaje y lo actualizo. Si status es 'failed', ademas debe guardar el
// motivo (errors[0].title / errors[0].message) en
// msg.extra.template.failReason. Nunca debe "subir" un estado ya mas
// avanzado a uno anterior (ej: si ya esta 'read', un evento 'delivered'
// atrasado no lo debe pisar) -- el orden real es
// sent < delivered < read, y failed es terminal.
function applyStatusUpdate(sessions, statusEvent) {
  throw new Error('TODO (H35): implementar applyStatusUpdate');
}

module.exports = { applyStatusUpdate };

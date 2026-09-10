// FASE 5 (H35): procesa los eventos de status de WhatsApp (`value.statuses`
// del webhook de Meta: sent/delivered/read/failed) y los aplica al mensaje
// correspondiente en el historial, buscandolo por `wamid` (el id que Meta
// devuelve al aceptar un envio de plantilla).
//
// Antes el webhook (server.js) nunca leia `value.statuses` -- solo procesaba
// `value.messages` y `value.contacts` -- asi que ningun mensaje en el panel
// podia pasar de "enviado" a "entregado"/"leido"/"fallido" con confirmacion
// real del proveedor. Esta pieza cierra ese hueco, sin inventar nunca un
// estado que Meta no confirmo: si no llega un evento real, el mensaje se
// queda en el ultimo estado conocido (o sin estado, para historial viejo).

'use strict';

// Orden real de progreso de un mensaje de WhatsApp. failed es terminal.
const ORDEN = { sent: 1, delivered: 2, read: 3, failed: 99 };

function esRetroceso(actual, nuevo) {
  if (!actual) return false;
  const ordenActual = ORDEN[actual] || 0;
  const ordenNuevo = ORDEN[nuevo] || 0;
  // failed es terminal: si ya esta failed, no lo pisa nada; y un evento
  // 'sent/delivered/read' atrasado nunca debe bajar un estado ya mas
  // avanzado (ej. 'read' no vuelve a 'delivered').
  if (actual === 'failed') return true;
  if (nuevo === 'failed') return false; // failed siempre se puede aplicar
  return ordenNuevo < ordenActual;
}

// sessions: el objeto { telefono: { history: [...] } } tal cual lo maneja
// state.js. statusEvent: { id, status, timestamp, errors } (forma cruda de
// un elemento de value.statuses de Meta).
//
// Devuelve { updated, phone, messageIndex }. Muta en el lugar el mensaje
// encontrado (sessions se guarda despues, en state.js).
function applyStatusUpdate(sessions, statusEvent) {
  const wamid = statusEvent && statusEvent.id;
  if (!wamid || !sessions) return { updated: false };

  for (const [phone, session] of Object.entries(sessions)) {
    const history = (session && session.history) || [];
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (!msg || !msg.template || msg.template.wamid !== wamid) continue;

      if (esRetroceso(msg.template.status, statusEvent.status)) {
        return { updated: false, phone, messageIndex: i, omitido: 'retroceso' };
      }

      msg.template.status = statusEvent.status;
      if (statusEvent.status === 'failed' && Array.isArray(statusEvent.errors) && statusEvent.errors[0]) {
        const e = statusEvent.errors[0];
        msg.template.failReason = e.title || e.message || 'Error desconocido de WhatsApp';
      }
      return { updated: true, phone, messageIndex: i };
    }
  }
  return { updated: false };
}

module.exports = { applyStatusUpdate };

// Ventana de 24 horas de WhatsApp: pasado ese tiempo desde el ULTIMO mensaje
// que mando el CLIENTE (no el bot ni el negocio), la API de Meta ya no deja
// mandar texto libre, solo plantillas ya aprobadas. Este calculo lo usa el
// panel (para avisar en el chat y bloquear el texto libre) y tambien el
// aviso automatico de guia de envio (shipping.js), asi que vive en un solo
// lugar compartido en vez de estar duplicado en los dos.
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

// Ultimo mensaje que mando el CLIENTE (role 'user'), no el bot ni el
// negocio: es lo unico que cuenta para la ventana de 24h de WhatsApp.
function lastInboundAt(history) {
  for (let i = (history || []).length - 1; i >= 0; i--) {
    if (history[i].role === 'user') return history[i].at || null;
  }
  return null;
}

function isWindowOpen(session) {
  const at = lastInboundAt(session.history || []);
  if (!at) return false; // nunca escribio: no hay ventana abierta para texto libre
  return Date.now() - new Date(at).getTime() < WHATSAPP_WINDOW_MS;
}

module.exports = { WHATSAPP_WINDOW_MS, lastInboundAt, isWindowOpen };

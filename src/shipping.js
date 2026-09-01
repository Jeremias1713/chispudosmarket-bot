// Aviso automatico de guia de envio: cuando se carga el numero de guia de un
// pedido (o el pedido pasa a "en camino"/"esperando retiro" y la guia ya
// estaba cargada de antes), el bot le avisa SOLO al cliente, sin que el
// negocio tenga que entrar al chat a escribirle a mano.
//
// - Si la ventana de 24h de WhatsApp todavia esta abierta (el cliente
//   escribio hace menos de 24h), se manda un mensaje de texto libre normal
//   (mas simple, sin restricciones de Meta).
// - Si ya se cerro, se manda la PLANTILLA aprobada que se configura en
//   Configuracion > Plantillas (nombre exacto tal cual quedo aprobada en
//   Meta), porque fuera de esas 24h WhatsApp no deja mandar texto libre.
//
// Se manda como mucho UNA vez por pedido (shippingNotifiedAt): si se corrige
// un typo en el numero de guia despues de avisado, no se le vuelve a
// escribir solo por eso.
const { getSession, updateSession, appendMessage } = require('./state');
const { sendTemplate } = require('./whatsapp');
const { sendRawReply } = require('./flow');
const { getSettings } = require('./settings');
const { isWindowOpen } = require('./whatsappWindow');

const DEFAULT_FREE_TEXT =
  'Hola {{nombre}}! Tu pedido de {{producto}} ya esta en camino. Numero de guia: {{guia}}.';

function placeholderValues(session) {
  return {
    nombre: session.name || session.card?.nombre || 'cliente',
    producto: session.card?.producto || 'tu pedido',
    guia: session.card?.guia || '',
  };
}

function fillPlaceholders(text, values) {
  return String(text || '')
    .replace(/\{\{\s*nombre\s*\}\}/gi, values.nombre)
    .replace(/\{\{\s*producto\s*\}\}/gi, values.producto)
    .replace(/\{\{\s*guia\s*\}\}/gi, values.guia);
}

// phone: numero del cliente. session: la sesion ya cargada (opcional, para
// no leerla dos veces si quien llama ya la tiene a mano).
async function maybeNotifyShipping(phone, session) {
  const s = session || getSession(phone);
  if (!s.card?.guia) return { sent: false, reason: 'sin_guia' };
  if (s.shippingNotifiedAt) return { sent: false, reason: 'ya_avisado' };

  const settings = getSettings();
  const abierta = isWindowOpen(s);
  const values = placeholderValues(s);

  try {
    if (abierta) {
      const texto = fillPlaceholders(settings.shippingFreeText || DEFAULT_FREE_TEXT, values);
      await sendRawReply(phone, texto);
    } else {
      if (!settings.shippingTemplateName) return { sent: false, reason: 'sin_plantilla' };
      // Orden de los parametros de la plantilla: nombre, producto, guia (en
      // ese orden). Tiene que coincidir con el orden de las variables
      // {{1}} {{2}} {{3}} tal cual quedaron aprobadas en Meta.
      await sendTemplate(
        phone,
        settings.shippingTemplateName,
        settings.shippingTemplateLanguage || 'es',
        [values.nombre, values.producto, values.guia]
      );
      appendMessage(phone, 'human', `[plantilla automatica] ${settings.shippingTemplateName}`);
    }
  } catch (err) {
    console.error('No se pudo mandar el aviso automatico de guia a', phone, err.response?.data || err.message);
    return { sent: false, reason: 'error', error: err.message };
  }

  updateSession(phone, { shippingNotifiedAt: new Date().toISOString() });
  return { sent: true, viaTemplate: !abierta };
}

module.exports = { maybeNotifyShipping };

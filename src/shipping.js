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
const { sendTemplate, sendImageByLink } = require('./whatsapp');
const { sendRawReply } = require('./flow');
const { getSettings } = require('./settings');
const { isWindowOpen } = require('./whatsappWindow');
const { loadProducts, findProduct } = require('./catalog');

const DEFAULT_FREE_TEXT =
  'Hola {{nombre}}! Tu pedido de {{producto}} ya esta en camino. Numero de guia: {{guia}}.';

// La plantilla "guia_del_pedido" (la que se usa aca cuando la ventana ya
// esta cerrada) quedo aprobada en Meta con 5 variables: nombre, producto,
// guia, agencia de destino y monto a pagar al retirar — y con un encabezado
// de IMAGEN obligatorio (la foto de la guia). Si el negocio aprueba otra
// plantilla con menos variables o sin imagen, hay que ajustar esto.
function resolveMonto(productoTexto) {
  const texto = String(productoTexto || '').trim();
  if (!texto) return '';
  const exacto = findProduct(texto);
  if (exacto) return `${Math.round(Number(exacto.price))}${exacto.currency || 'Bs'}`;
  const q = texto.toLowerCase();
  const match = loadProducts().find(
    (p) => p.name && (q.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(q))
  );
  return match ? `${Math.round(Number(match.price))}${match.currency || 'Bs'}` : '';
}

function placeholderValues(session) {
  return {
    nombre: session.name || session.card?.nombre || 'cliente',
    producto: session.card?.producto || 'tu pedido',
    guia: session.card?.guia || '',
    // agencia: se carga a mano junto con la guia (ver el campo nuevo en el
    // panel), porque este flujo (cargar guia desde el chat, una por una) no
    // tiene, como el seguimiento diario de Dropanas, un Excel del que
    // sacarla sola.
    agencia: session.card?.agencia || '',
    monto: resolveMonto(session.card?.producto),
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

  let imageSent = false;
  try {
    // La FOTO de la guia (si se cargo una) se manda sola como mensaje de
    // imagen SOLO cuando la ventana de 24h esta abierta (WhatsApp no deja
    // mandar ningun archivo libre fuera de esa ventana). Si la ventana esta
    // cerrada, la misma foto va como encabezado de imagen DENTRO de la
    // plantilla "guia_del_pedido" (ver mas abajo), que la exige.
    if (abierta && s.card?.guiaImageUrl) {
      try {
        await sendImageByLink(phone, s.card.guiaImageUrl);
        appendMessage(phone, 'assistant', '[imagen] Guia de envio');
        imageSent = true;
      } catch (err) {
        console.error('No se pudo mandar la foto de la guia a', phone, err.response?.data || err.message);
      }
    }

    if (abierta) {
      const texto = fillPlaceholders(settings.shippingFreeText || DEFAULT_FREE_TEXT, values);
      await sendRawReply(phone, texto);
    } else {
      if (!settings.shippingTemplateName) return { sent: false, reason: 'sin_plantilla' };
      // Orden de los parametros de la plantilla "guia_del_pedido": nombre,
      // producto, guia, agencia de destino, monto (en ese orden). Tiene que
      // coincidir con el orden de las variables {{1}}..{{5}} tal cual
      // quedaron aprobadas en Meta. Ademas esta plantilla exige un
      // encabezado de imagen (la foto de la guia); si todavia no se cargo
      // ninguna foto para este pedido, Meta va a rechazar el envio, asi que
      // el negocio deberia cargarla en el panel antes de que se cierre la
      // ventana de 24h.
      await sendTemplate(
        phone,
        settings.shippingTemplateName,
        settings.shippingTemplateLanguage || 'es',
        [values.nombre, values.producto, values.guia, values.agencia, values.monto],
        s.card?.guiaImageUrl || null
      );
      appendMessage(phone, 'human', `[plantilla automatica] ${settings.shippingTemplateName}`);
    }
  } catch (err) {
    console.error('No se pudo mandar el aviso automatico de guia a', phone, err.response?.data || err.message);
    return { sent: false, reason: 'error', error: err.message };
  }

  updateSession(phone, { shippingNotifiedAt: new Date().toISOString() });
  return {
    sent: true,
    viaTemplate: !abierta,
    imageSent,
    // Ventana cerrada + plantilla: la foto (si hay) va como encabezado DENTRO
    // de la plantilla, asi que no se "salta". Si no se cargo ninguna foto
    // todavia, Meta va a rechazar el envio entero (la plantilla la exige) —
    // eso es lo que marca este flag, para avisarle al negocio que falta.
    imageSkipped: !abierta && !s.card?.guiaImageUrl,
  };
}

module.exports = { maybeNotifyShipping };

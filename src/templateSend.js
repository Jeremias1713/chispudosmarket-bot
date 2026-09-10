// FASE 2/5 (H06 + H17 + H35): un solo lugar que arma el contenido de una
// plantilla (snapshot: texto con variables reemplazadas, header, footer,
// botones) y opcionalmente la manda -- para que preview, "probar en mi
// numero" y el envio real usen siempre exactamente los mismos datos
// (nombre, producto, monto, imagen), sin diferencias entre uno y otro.
'use strict';
const metaTemplates = require('./metaTemplates');
const { buildTemplateContent } = require('./templateContent');
// Se requiere el modulo completo (no se desestructura sendTemplate) a
// proposito: asi los tests pueden reemplazar whatsapp.sendTemplate por una
// funcion falsa sin tocar la red, y en produccion siempre se usa la version
// real sin ningun cambio de comportamiento.
const whatsapp = require('./whatsapp');

// Arma el snapshot del contenido, sin mandar nada. Si no se puede conseguir
// la plantilla aprobada desde Meta (sin credenciales, sin red, nombre no
// encontrado), devuelve null -- nunca inventa un snapshot con datos que no
// se pudieron confirmar.
async function previewTemplateContent({ templateName, languageCode, values, headerImageUrl }) {
  try {
    const approved = await metaTemplates.findApprovedTemplate(templateName, languageCode);
    if (!approved) return null;
    return buildTemplateContent({ components: approved.components, values, headerImageUrl });
  } catch (err) {
    return null;
  }
}

// Arma el mismo snapshot de arriba y ademas manda la plantilla de verdad.
// Devuelve { wamid, snapshot } para que el que llama guarde ambos en el
// historial (ver state.js / appendMessage).
async function sendTemplateWithSnapshot({ to, templateName, languageCode, values, headerImageUrl }) {
  const snapshot = await previewTemplateContent({ templateName, languageCode, values, headerImageUrl });
  const sendResult = await whatsapp.sendTemplate(to, templateName, languageCode, values, headerImageUrl);
  return { wamid: (sendResult && sendResult.wamid) || null, snapshot };
}

module.exports = { previewTemplateContent, sendTemplateWithSnapshot };

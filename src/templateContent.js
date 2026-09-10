// FASE 2/5 (H06 + H17): punto unico para armar el contenido final de una
// plantilla de WhatsApp (texto con variables ya reemplazadas, header, footer
// y botones) a partir de los `components` que devuelve la API de Meta para
// una plantilla aprobada.
//
// Antes esta logica estaba duplicada (con defaults distintos) en
// broadcasts.js, personalizedBroadcast.js, seguimiento.js y shipping.js, y
// en ningun lado se armaba el texto final: solo se le mandaba a Meta el
// array de `params`, que hace el reemplazo del lado de ellos. Eso hacia
// imposible previsualizar "como se va a ver" un envio antes de mandarlo
// (panel), y tambien imposible guardar un snapshot fiel en el historial
// (state.js). Ahora preview, prueba y envio real llaman siempre a
// buildTemplateContent con los mismos argumentos (ver templateSend.js).

'use strict';

// Reemplaza {{1}}, {{2}}, etc. en el texto por los valores de `values`
// (values[0] -> {{1}}, values[1] -> {{2}}, ...). Si falta un value para
// algun placeholder, lo deja tal cual (no inventa el dato ni rompe).
function resolvePlaceholders(text, values) {
  if (text == null) return text;
  const lista = Array.isArray(values) ? values : [];
  return String(text).replace(/\{\{\s*(\d+)\s*\}\}/g, (match, numero) => {
    const idx = Number(numero) - 1;
    const val = lista[idx];
    return val == null ? match : String(val);
  });
}

function findComponent(components, type) {
  return (components || []).find((c) => String(c.type || '').toUpperCase() === type) || null;
}

// components: el array `components` tal cual lo devuelve la Graph API de
// Meta para una plantilla aprobada (tipos HEADER/BODY/FOOTER/BUTTONS).
// values: array de strings, en el mismo orden que los placeholders del
// BODY (Meta no permite variables en el HEADER de tipo IMAGE, que es el
// unico tipo de header que usa este bot).
// headerImageUrl: si el header es de tipo IMAGE, la URL que se va a usar
// (viene de otro lado, no de Meta -- ej. la foto del pedido).
//
// Devuelve { headerText, headerImageUrl, bodyText, footerText, buttons },
// con null en los campos que la plantilla no tenga (nunca se inventa
// contenido que la plantilla real no tiene).
function buildTemplateContent({ components, values, headerImageUrl } = {}) {
  const header = findComponent(components, 'HEADER');
  const body = findComponent(components, 'BODY');
  const footer = findComponent(components, 'FOOTER');
  const buttonsComp = findComponent(components, 'BUTTONS');

  const headerFormat = header ? String(header.format || '').toUpperCase() : null;

  return {
    headerText: header && headerFormat === 'TEXT' ? resolvePlaceholders(header.text, values) : null,
    headerImageUrl: header && headerFormat === 'IMAGE' ? headerImageUrl || null : null,
    bodyText: body ? resolvePlaceholders(body.text, values) : null,
    footerText: footer ? footer.text : null,
    buttons: buttonsComp && Array.isArray(buttonsComp.buttons) ? buttonsComp.buttons : null,
  };
}

module.exports = { resolvePlaceholders, buildTemplateContent };

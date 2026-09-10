// FASE 2/5 (H06 + H17): punto unico para armar el contenido final de una
// plantilla de WhatsApp (texto con variables ya reemplazadas, header, footer
// y botones) a partir de los `components` que devuelve la API de Meta para
// una plantilla aprobada.
//
// Hoy esta logica esta duplicada (y con defaults distintos) en
// broadcasts.js, personalizedBroadcast.js, seguimiento.js y shipping.js, y
// en ningun lado se arma el texto final: solo se le manda a Meta el array
// de `params`, que hace el reemplazo del lado de ellos. Eso hace imposible
// previsualizar "como se va a ver" un envio antes de mandarlo (panel), y
// tambien imposible guardar un snapshot fiel en el historial (state.js).
//
// TODAVIA NO IMPLEMENTADO. Este archivo es el contrato (ver
// test/templateContent.test.js) para la siguiente fase de implementacion;
// por ahora cada funcion tira un error claro si se llega a usar por error.

'use strict';

// Reemplaza {{1}}, {{2}}, etc. en bodyText por los valores de `values`
// (values[0] -> {{1}}, values[1] -> {{2}}, ...). No debe lanzar si values
// tiene menos posiciones que placeholders (ver test); simplemente deja el
// placeholder sin reemplazar o usa un valor vacio, a definir en la
// implementacion real.
function resolvePlaceholders(bodyText, values) {
  throw new Error('TODO (H06): implementar resolvePlaceholders');
}

// components: el array `components` tal cual lo devuelve la Graph API de
// Meta para una plantilla aprobada (tipos HEADER/BODY/FOOTER/BUTTONS).
// values: array de strings, en el mismo orden que los placeholders del
// BODY (y del HEADER si el header es de texto).
// headerImageUrl: si el header es de tipo IMAGE, la URL que se va a usar
// (viene de otro lado, no de Meta).
//
// Devuelve { headerText, headerImageUrl, bodyText, footerText, buttons },
// con null en los campos que la plantilla no tenga.
function buildTemplateContent({ components, values, headerImageUrl } = {}) {
  throw new Error('TODO (H06/H17): implementar buildTemplateContent');
}

module.exports = { resolvePlaceholders, buildTemplateContent };

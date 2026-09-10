// FASE 2/5 (H06 + H17): trae las plantillas aprobadas desde Meta, con su
// contenido completo (`components`: header/body/footer/botones), no solo
// nombre/idioma/categoria como hacia antes /api/templates. Un solo lugar
// (con cache corto) para que preview, prueba de envio y envio real busquen
// siempre la misma version de la plantilla aprobada.
'use strict';
const axios = require('axios');

const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, templates: [] };

async function fetchApprovedTemplates({ force } = {}) {
  // El cache (usado tambien por los tests via _setCacheForTests) se revisa
  // primero: no depende de tener credenciales cargadas.
  if (!force && cache.templates.length && Date.now() - cache.at < CACHE_MS) {
    return { available: true, templates: cache.templates };
  }

  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!wabaId || !token) return { available: false, templates: [] };

  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v20.0';
  const { data } = await axios.get(`https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { limit: 100 },
    timeout: 10000,
  });
  const templates = (data.data || []).filter((t) => t.status === 'APPROVED');
  cache = { at: Date.now(), templates };
  return { available: true, templates };
}

// Busca una plantilla aprobada por nombre (y opcionalmente idioma). Si no
// hay coincidencia exacta de idioma, devuelve la primera con ese nombre
// (misma logica laxa que ya usaba el bot al mandar por nombre solo).
async function findApprovedTemplate(name, languageCode) {
  const { available, templates } = await fetchApprovedTemplates();
  if (!available || !name) return null;
  const porIdioma = languageCode && templates.find((t) => t.name === name && t.language === languageCode);
  return porIdioma || templates.find((t) => t.name === name) || null;
}

// Solo para tests: permite poblar el cache sin llamar a Meta de verdad.
function _setCacheForTests(templates) {
  cache = { at: Date.now(), templates: templates || [] };
}

module.exports = { fetchApprovedTemplates, findApprovedTemplate, _setCacheForTests };

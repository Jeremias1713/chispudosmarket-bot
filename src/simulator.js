// Simulador: mismo prompt, mismo catalogo y misma logica que el bot real,
// pero nada sale por WhatsApp. Estado en memoria (no se persiste a disco):
// se resetea solo si el proceso se reinicia, o con el boton "Reiniciar".
const { nearestByCoords, formatAgency, findKnownCityKey } = require('./agencies');
const { getAssistantReply, applySplitPolicy, buildDirectAgencyMessage } = require('./ai');
const { classifyConversation } = require('./classifier');
const { matchTrigger, findProduct } = require('./catalog');
const { getSettings } = require('./settings');
// looksLikePendingAgencyPromise: misma red de seguridad que corre en las
// conversaciones reales (ver flow.js processReply). Se reusa aca para que el
// simulador se comporte IGUAL que un chat real: si el bot promete buscar la
// agencia y no lo hace, el simulador tiene que mostrar el mismo mensaje de
// seguimiento que mandaria de verdad, no quedarse "colgado".
const { looksLikePendingAgencyPromise } = require('./flow');

function randomGap() {
  return 400 + Math.floor(Math.random() * 500);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Misma politica que usa el bot real (Configuracion) para que el simulador
// previsualice exactamente como se va a partir la respuesta.
function splitForPreview(text) {
  return applySplitPolicy(text, getSettings());
}

function blankState() {
  return {
    history: [], // {role, content, at}
    stage: 'nuevo',
    card: { nombre: null, ciudad: null, telefono: null, cedula: null, producto: null, notas: null },
    linkedProductId: null,
  };
}

let state = blankState();

function push(role, content) {
  state.history.push({ role, content, at: new Date().toISOString() });
}

function getState() {
  return state;
}

function reset() {
  state = blankState();
  return state;
}

async function sendMessage(rawText) {
  push('user', rawText);

  const product = !state.linkedProductId ? matchTrigger(rawText) : null;
  if (product && product.intro && product.intro.trim()) {
    state.linkedProductId = product.id;
    const intro = product.intro.trim();
    const imgCount = (product.introImageIds || []).length;
    // El simulador no manda fotos de verdad: solo lo deja ver en el
    // historial, igual que ya se hacia con una sola foto.
    const preview = imgCount ? `[${imgCount === 1 ? 'imagen' : imgCount + ' imagenes'}] ${intro}` : intro;
    push('assistant', preview);
    return { parts: splitForPreview(intro), state };
  }

  const history = state.history.map((m) => ({ role: m.role, content: m.content }));
  const knownCity = state.card?.ciudad || null;
  const knownProduct = state.linkedProductId ? findProduct(state.linkedProductId)?.name || null : null;
  const { text: reply, images } = await getAssistantReply(history.slice(0, -1), rawText, knownCity, knownProduct);

  for (const img of images) {
    push('assistant', `[imagen] ${img.name}`);
  }

  // Partimos la respuesta igual que el bot real (mismo applySplitPolicy) y
  // metemos cada parte como un mensaje separado en el historial, para que
  // el simulador se vea EXACTAMENTE como se veria en WhatsApp: una burbuja
  // por cada mensaje, no todo el texto pegado en una sola burbuja.
  const parts = splitForPreview(reply);
  for (const part of parts) {
    push('assistant', part);
  }

  // Misma red de seguridad que corre en produccion (ver flow.js
  // processReply): si el bot prometio buscar la agencia y no lo hizo, se
  // manda el mensaje de seguimiento aca tambien, para que el simulador no de
  // una falsa sensacion de que el bot se quedo "colgado" cuando en un chat
  // real si se resuelve solo. knownCity puede seguir vacio en el primer
  // mensaje (la ficha recien se llena con la clasificacion de mas abajo), asi
  // que ahi se prueba reconocer la ciudad directo de lo que el cliente acaba
  // de escribir.
  const extraParts = [];
  const ciudadParaFollowUp = knownCity || findKnownCityKey(rawText);
  if (ciudadParaFollowUp && looksLikePendingAgencyPromise(reply)) {
    const followUp = buildDirectAgencyMessage(ciudadParaFollowUp);
    if (followUp) {
      await sleep(randomGap());
      push('assistant', followUp);
      extraParts.push(...splitForPreview(followUp));
    }
  }

  const classification = await classifyConversation(state.history.map((m) => ({ role: m.role, content: m.content })));
  if (classification) {
    state.stage = classification.stage;
    // Mismo motivo que en flow.js: fusionar, no reemplazar, para no borrar
    // un dato ya confirmado si este turno el clasificador no lo vuelve a
    // detectar (por ejemplo por un mensaje fuera de tema en el medio).
    const mergedCard = { ...(state.card || {}) };
    for (const [key, value] of Object.entries(classification.card || {})) {
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        mergedCard[key] = value;
      }
    }
    state.card = mergedCard;
  }

  return { parts: [...images.map((img) => `[imagen] ${img.name}`), ...parts, ...extraParts], state };
}

async function sendLocation(latitude, longitude) {
  push('user', '[Comparti su ubicacion GPS]');
  const nearby = nearestByCoords(latitude, longitude, 3);
  const reply = !nearby.length
    ? 'Aun no tenemos agencias cargadas cerca de tu ubicacion.'
    : 'Estas son las agencias mas cercanas a tu ubicacion:\n\n' + nearby.map(formatAgency).join('\n\n');
  push('assistant', reply);
  return { parts: [reply], state };
}

module.exports = { getState, reset, sendMessage, sendLocation };

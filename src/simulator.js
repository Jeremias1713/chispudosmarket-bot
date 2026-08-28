// Simulador: mismo prompt, mismo catalogo y misma logica que el bot real,
// pero nada sale por WhatsApp. Estado en memoria (no se persiste a disco):
// se resetea solo si el proceso se reinicia, o con el boton "Reiniciar".
const { nearestByCoords, searchByText, formatAgency } = require('./agencies');
const { getAssistantReply, splitReply, enforceMessageLimits } = require('./ai');
const { classifyConversation } = require('./classifier');
const { matchTrigger } = require('./catalog');
const { getSettings } = require('./settings');

// Mismos topes que usa el bot real (Configuracion) para que el simulador
// previsualice exactamente como se va a partir la respuesta.
function splitForPreview(text) {
  const settings = getSettings();
  return enforceMessageLimits(
    splitReply(text),
    settings.maxWordsPerMessage || 30,
    settings.maxMessageParts || 5
  );
}

function blankState() {
  return {
    history: [], // {role, content, at}
    stage: 'nuevo',
    card: { nombre: null, ciudad: null, telefono: null, producto: null, notas: null },
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
    push('assistant', product.intro.trim());
    return { parts: splitForPreview(product.intro.trim()), state };
  }

  const wordCount = rawText.split(/\s+/).filter(Boolean).length;
  const cityMatches = wordCount <= 4 ? searchByText(rawText, 3) : [];
  if (cityMatches.length > 0) {
    const reply = 'Estas son las agencias que encontre:\n\n' + cityMatches.map((a) => formatAgency(a)).join('\n\n');
    push('assistant', reply);
    return { parts: [reply], state };
  }

  const history = state.history.map((m) => ({ role: m.role, content: m.content }));
  const reply = await getAssistantReply(history.slice(0, -1), rawText);
  push('assistant', reply);

  const classification = await classifyConversation(state.history.map((m) => ({ role: m.role, content: m.content })));
  if (classification) {
    state.stage = classification.stage;
    state.card = classification.card;
  }

  return { parts: splitForPreview(reply), state };
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

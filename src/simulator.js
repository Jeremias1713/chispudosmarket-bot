// Simulador: mismo prompt, mismo catalogo y misma logica que el bot real,
// pero nada sale por WhatsApp. Estado en memoria (no se persiste a disco):
// se resetea solo si el proceso se reinicia, o con el boton "Reiniciar".
const { nearestByCoords, formatAgency } = require('./agencies');
const { getAssistantReply, applySplitPolicy } = require('./ai');
const { classifyConversation } = require('./classifier');
const { matchTrigger } = require('./catalog');
const { getSettings } = require('./settings');

// Misma politica que usa el bot real (Configuracion) para que el simulador
// previsualice exactamente como se va a partir la respuesta.
function splitForPreview(text) {
  return applySplitPolicy(text, getSettings());
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
    const intro = product.intro.trim();
    const imgCount = (product.introImageIds || []).length;
    // El simulador no manda fotos de verdad: solo lo deja ver en el
    // historial, igual que ya se hacia con una sola foto.
    const preview = imgCount ? `[${imgCount === 1 ? 'imagen' : imgCount + ' imagenes'}] ${intro}` : intro;
    push('assistant', preview);
    return { parts: splitForPreview(intro), state };
  }

  const history = state.history.map((m) => ({ role: m.role, content: m.content }));
  const { text: reply, images } = await getAssistantReply(history.slice(0, -1), rawText);

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

  const classification = await classifyConversation(state.history.map((m) => ({ role: m.role, content: m.content })));
  if (classification) {
    state.stage = classification.stage;
    state.card = classification.card;
  }

  return { parts: [...images.map((img) => `[imagen] ${img.name}`), ...parts], state };
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

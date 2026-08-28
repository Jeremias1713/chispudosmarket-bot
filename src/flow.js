// Logica de conversacion: el bot es un chatbot con IA (OpenAI). Este archivo
// decide que hacer con cada mensaje entrante: comandos globales, ubicacion
// (que se resuelve solo, sin IA, para que sea instantaneo y gratis), y todo
// lo demas se lo pasamos al modelo (ver ./ai.js) que responde como asesor de
// ventas y decide el texto.
const { sendText } = require('./whatsapp');
const { getSession, updateSession, resetSession } = require('./state');
const { nearestByCoords, searchByText, formatAgency } = require('./agencies');
const { getAssistantReply, splitReply } = require('./ai');
const { classifyConversation } = require('./classifier');

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'nuestro negocio';
const SPLIT_GAP_MIN_MS = parseInt(process.env.SPLIT_GAP_MIN_MS || '1500', 10);
const SPLIT_GAP_MAX_MS = parseInt(process.env.SPLIT_GAP_MAX_MS || '3500', 10);

function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomGap() {
        return SPLIT_GAP_MIN_MS + Math.random() * (SPLIT_GAP_MAX_MS - SPLIT_GAP_MIN_MS);
}

async function sendSplit(to, text) {
        const parts = splitReply(text);
        for (let i = 0; i < parts.length; i++) {
                  if (i > 0) await sleep(randomGap());
                  await sendText(to, parts[i]);
        }
}

async function sendGreeting(to) {
        return sendText(
                  to,
                  `Hola! Bienvenido a ${BUSINESS_NAME}. Contame, en que te puedo ayudar hoy?`
                );
}

async function handleIncomingMessage(from, message) {
        const session = getSession(from);
        const type = message.type;

  const rawText =
            type === 'text'
            ? message.text.body.trim()
              : type === 'interactive' && message.interactive?.button_reply
            ? message.interactive.button_reply.title
              : type === 'interactive' && message.interactive?.list_reply
            ? message.interactive.list_reply.title
              : '';
        const lower = rawText.toLowerCase();

  if (['menu', 'inicio', 'reiniciar', 'start'].includes(lower)) {
            resetSession(from);
            return sendGreeting(from);
  }

  if (type === 'location') {
            const { latitude, longitude } = message.location;
            const nearby = nearestByCoords(latitude, longitude, 3);
            const reply = !nearby.length
              ? 'Aun no tenemos agencias cargadas cerca de tu ubicacion.'
                        : 'Estas son las agencias mas cercanas a tu ubicacion:\n\n' +
                          nearby.map(formatAgency).join('\n\n');
            await sendText(from, reply);
            const history = [...(session.history || [])];
            history.push({ role: 'user', content: '[Comparti su ubicacion GPS]' });
            history.push({ role: 'assistant', content: reply });
            updateSession(from, { history });
            return;
  }

                          if (!rawText) {
                                    await sendText(
                                                from,
                                                'Por ahora solo puedo leer mensajes de texto o ubicacion. Me lo escribis, porfa?'
                                              );
                                    return;
                          }

  const wordCount = rawText.split(/\s+/).filter(Boolean).length;
        const cityMatches = wordCount <= 4 ? searchByText(rawText, 3) : [];
        if (cityMatches.length > 0) {
                  const reply =
                              'Estas son las agencias que encontre:\n\n' +
                              cityMatches.map((a) => formatAgency(a)).join('\n\n');
                  await sendText(from, reply);
                  const history = [...(session.history || [])];
                  history.push({ role: 'user', content: rawText });
                  history.push({ role: 'assistant', content: reply });
                  updateSession(from, { history, lastAssistantText: reply });
                  return;
        }

  try {
            const history = [...(session.history || [])];
            const reply = await getAssistantReply(history, rawText);

          history.push({ role: 'user', content: rawText });
            history.push({ role: 'assistant', content: reply });
            updateSession(from, { history, lastAssistantText: reply });

          await sendSplit(from, reply);

          // Clasificacion de etapa + ficha del cliente. Corre despues de mandar la
          // respuesta para no sumarle latencia al mensaje del cliente. Si falla,
          // no rompe nada: simplemente la etapa/ficha no se actualiza este turno.
          const classification = await classifyConversation(history);
            if (classification) {
                        updateSession(from, { stage: classification.stage, card: classification.card });
            }
  } catch (err) {
            console.error('Error llamando a la IA (diagnostico):', {
                        message: err.message,
                        name: err.name,
                        status: err.status,
                        code: err.code,
                        cause: err.cause ? String(err.cause) : undefined,
                        causeCode: err.cause && err.cause.code,
                        stack: err.stack,
            });
            await sendText(
                        from,
                        'Disculpa, tuve un problema para responderte. Me repetis eso en un momento?'
                      );
  }
}

module.exports = { handleIncomingMessage };

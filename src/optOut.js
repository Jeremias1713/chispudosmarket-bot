// Detecta cuando un cliente pide, con palabras claras, que no le escribamos
// mas. Sin opt-out, esos clientes seguian recibiendo remarketing, recordatorios
// y masivos, y terminaban bloqueando o reportando el numero (lo que mas pesa en
// la calidad de Meta). Solo frases claras: ante la duda NO se marca.
'use strict';

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const PATTERNS = [
  /\bno me (escriban|escribas|escriba|manden|mandes|envien|envies|molesten|molestes) mas\b/,
  /\b(dejen|deja|dejar) de (escribirme|mandarme|enviarme)( mensajes)?\b/,
  /\b(no quiero|no deseo) (recibir )?(mas )?(mensajes|publicidad|promociones)\b/,
  /\b(sacame|sacarme|eliminame|eliminarme|borrame|borrarme|quitame|quitarme) de (la lista|sus listas|su lista|la base)\b/,
];
const WHOLE_MESSAGE = /^(stop|baja|parar|cancelar suscripcion)$/;

function detectOptOut(text) {
  const t = normalize(text);
  if (!t) return false;
  if (PATTERNS.some((re) => re.test(t))) return true;
  // Mensaje que es SOLO la palabra (con signos o espacios alrededor, nada mas).
  const bare = t.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return WHOLE_MESSAGE.test(bare);
}

module.exports = { detectOptOut };

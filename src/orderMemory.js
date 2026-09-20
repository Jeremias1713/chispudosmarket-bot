const agencies = require('./agencies');

const WORD_QUANTITIES = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

function fold(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function blankOrder() {
  return {
    product: null,
    presentation: null,
    quantity: null,
    city: null,
    agency: null,
    courier: null,
    modality: 'agency_pickup',
    total: null,
    quotedQuantity: null,
    accepted: false,
    needsHumanPayment: false,
  };
}

function extractMoney(text) {
  const raw = String(text || '');
  const matches = [
    raw.match(/(\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(?:bs\.?|bol[ií]vares)/i),
    raw.match(/(?:bs\.?|bol[ií]vares)\s*(\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/i),
  ];
  const value = matches.find(Boolean)?.[1];
  if (!value) return null;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(value)) return Number(value.replace(/\./g, '').replace(',', '.'));
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(value)) return Number(value.replace(/,/g, ''));
  return Number(value.replace(',', '.'));
}

function isRetraction(text) {
  return /\bno\s+(me\s+lo\s+)?(mandes|envies|proceses|confirmes|cierres|pidas)\b|\btodavia\s+no\b|\baun\s+no\b|\bespera(te)?\b|\bsolo\s+(estoy\s+)?consultando\b|\bcancela/i.test(fold(text));
}

function isCurrentTermsAcceptance(text, precedingAssistantText) {
  const norm = fold(text).trim();
  if (!norm || norm === '[sticker]' || isRetraction(norm) || /\?$/.test(norm)) return false;
  if (/\b(quiero|dame|llevo|confirmo|procede|procesa|haz|hace)\b/.test(norm)) return true;
  const short = /^(si|sip|dale|ok|okay|listo|perfecto|correcto|de acuerdo|esta bien)[.!\s]*$/.test(norm);
  return short && /\b(confirmas|confirmame|procedemos|cerramos|asi queda|pedido)\b/.test(fold(precedingAssistantText));
}

function extractQuantity(text, precedingAssistantText) {
  const menu = /tengo una duda antes de pedir|responde(me)?\s+con\s+el\s+numero\s*1,?\s*2\s*(o|,)\s*3/i.test(fold(precedingAssistantText));
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let result = null;
  for (const line of lines) {
    const normalized = fold(line).replace(/[.!?]+$/g, '').trim();
    if (menu && /^[123]$/.test(normalized)) continue;
    const withUnit = normalized.match(/\b([1-9]|[12]\d|30)\s*(frascos?|unidades?|potes?|combos?|cajas?)\b/);
    if (withUnit) { result = Number(withUnit[1]); continue; }
    const word = normalized.match(/\b(un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b(?:\s*(frascos?|unidades?|potes?|combos?|cajas?))?/);
    if (word && (word[2] || Object.prototype.hasOwnProperty.call(WORD_QUANTITIES, normalized))) {
      result = WORD_QUANTITIES[word[1]];
      continue;
    }
    // Los numeros sueltos de identidad/plazo no son cantidades. Las formas
    // con unidad se evaluan antes para admitir mensajes compactos como
    // "quiero 2 frascos, cedula..., telefono...".
    if (/\b(agencia|opcion)\s*(numero\s*)?\d+\b/.test(normalized) || /^la\s+\d+$/.test(normalized)) continue;
    if (/\b(cedula|telefono|tlf|plazo|dias?|horas?)\b/.test(normalized)) continue;
    const short = normalized.match(/^(?:quiero|dame|serian|mejor|llevo|quiero mejor|dale,?\s*)?\s*([1-9]|[12]\d|30)$/);
    if (short) result = Number(short[1]);
  }
  return result;
}

function normalizePhone(digits) {
  let value = String(digits || '').replace(/\D/g, '');
  if (value.startsWith('58') && value.length >= 12) value = value.slice(2);
  if (value.length === 10 && value.startsWith('4')) value = `0${value}`;
  return /^0?4\d{9}$/.test(value) ? value : null;
}

function extractIdentity(text, existing = {}) {
  const raw = String(text || '');
  const result = { nombre: existing.nombre || null, cedula: existing.cedula || null, telefono: existing.telefono || null };
  const phoneMatch = raw.match(/(?:\+?58[\s.-]*)?0?4(?:12|14|16|24|26)(?:[\s.()\-]*\d){7}/i);
  if (phoneMatch) result.telefono = normalizePhone(phoneMatch[0]);

  const cedulaLabel = raw.match(/(?:cedula|c[eé]dula|ci)\s*[:#-]?\s*[vVeE-]*\s*((?:\d[\s.\-]*){6,9})/i);
  if (cedulaLabel) result.cedula = cedulaLabel[1].replace(/\D/g, '');
  if (!result.cedula) {
    const withoutPhone = phoneMatch ? raw.replace(phoneMatch[0], ' ') : raw;
    const candidates = withoutPhone.match(/(?<!\d)\d(?:[.\-]?\d){5,8}(?!\d)/g) || [];
    const cedula = candidates.map((v) => v.replace(/\D/g, '')).find((v) => v.length >= 6 && v.length <= 9);
    if (cedula) result.cedula = cedula;
  }

  const nameLabel = raw.match(/(?:nombre(?:\s+y\s+apellido)?|soy)\s*[:#-]?\s*([\p{L}][\p{L}' -]{2,60}?)(?=\s*(?:\r?\n|,|;|cedula|c[eé]dula|telefono|tel[eé]fono|tlf|\d|$))/iu);
  if (nameLabel) result.nombre = nameLabel[1].trim();
  if (!result.nombre && (result.cedula || result.telefono)) {
    const prefix = raw.split(/\d/)[0].replace(/^(hola|buenas|mi nombre es|soy)\s+/i, '').trim().replace(/[,:;-]+$/g, '').trim();
    const words = prefix.match(/[\p{L}][\p{L}'-]*/gu) || [];
    if (words.length >= 2 && words.length <= 6) result.nombre = words.join(' ');
  }
  return result;
}

function extractDestinationCity(text) {
  const raw = String(text || '');
  const clauses = raw.split(/[\n,;.!?]+/).map((part) => part.trim()).filter(Boolean);
  for (let i = clauses.length - 1; i >= 0; i -= 1) {
    const clause = fold(clauses[i]);
    if (/\b(no estoy|no vivo|ustedes estan|estan ubicados|queda en)\b/.test(clause) && !/\b(estoy|vivo|soy|mand(?:a|alo)|envi(?:a|alo))\b.*\b(pero|yo)\b/.test(clause)) continue;
    if (/\b(estoy|vivo|soy de|me encuentro|mandalo a|envialo a|para)\b/.test(clause)) {
      const city = agencies.findKnownCityKey(clause);
      if (city) return city;
    }
  }
  return null;
}

function agencyOptions(assistantText) {
  return String(assistantText || '').split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)[.)]\s*(.+)$/);
    return match ? { index: Number(match[1]), label: match[2].trim() } : null;
  }).filter(Boolean);
}

function editDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[right.length];
}

const AGENCY_SELECTION_FILLERS = new Set([
  'a', 'agencia', 'ahi', 'esa', 'ese', 'esta', 'este', 'de', 'del', 'en',
  'el', 'la', 'las', 'los', 'me', 'oficina', 'por', 'favor', 'prefiero',
  'queda', 'quedo', 'quiero', 'sirve', 'voy',
]);

function selectionWords(value) {
  return fold(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !AGENCY_SELECTION_FILLERS.has(word));
}

function fuzzyPhraseMatches(left, right) {
  if (!left || !right || Math.min(left.length, right.length) < 4) return false;
  const tolerance = Math.min(2, Math.max(1, Math.floor(Math.max(left.length, right.length) / 9)));
  return editDistance(left, right) <= tolerance;
}

function directAgencyNameSelection(userText, options) {
  if (!options.length) return null;
  const answerWords = selectionWords(userText);
  if (!answerWords.length || answerWords.length > 5) return null;
  const answer = answerWords.join(' ');

  const scored = options.map((option) => {
    const primary = fold(option.label).split(/\s+(?:—|-)\s+|,/)[0];
    const optionWords = selectionWords(primary);
    const optionName = optionWords.join(' ');
    let score = 0;
    if (answer === optionName) score = 100;
    else if (fuzzyPhraseMatches(answer, optionName)) score = 90;
    else if (answerWords.every((word) => optionWords.includes(word))) score = 70;
    else if (optionWords.every((word) => answerWords.includes(word))) score = 65;
    return { option, score };
  }).filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  // Una respuesta parcial como "Merida" puede parecerse a "Merida" y a
  // "Merida Norte". Solo se elige automaticamente cuando el mejor match
  // es claramente superior; los empates quedan para aclaracion humana.
  if (scored[1] && scored[0].score === scored[1].score) return null;
  return scored[0].option.label;
}

function extractAgencySelection(userText, assistantText) {
  const options = agencyOptions(assistantText);
  const normalized = fold(userText).trim();
  const numbered = normalized.match(/\b(?:la|agencia|opcion)\s*(?:numero\s*)?(\d+)\b/);
  if (numbered) return options.find((option) => option.index === Number(numbered[1]))?.label || null;
  const yes = /^(si|sip|dale|ok|okay|perfecto|claro|correcto)[.!\s]*$/.test(normalized);
  if (yes && options.length === 1 && /agencia/.test(fold(assistantText))) return options[0].label;
  return directAgencyNameSelection(userText, options);
}

function applyOrderMessage({ currentOrder, text, precedingAssistantText, knownCustomer }) {
  const order = { ...blankOrder(), ...(currentOrder || {}) };
  const previousQuantity = order.quantity;
  const quotedTotal = extractMoney(precedingAssistantText);
  if (quotedTotal && previousQuantity) {
    order.total = quotedTotal;
    order.quotedQuantity = previousQuantity;
  }
  const quantity = extractQuantity(text, precedingAssistantText);
  if (quantity && quantity !== previousQuantity) {
    order.quantity = quantity;
    order.total = null;
    order.quotedQuantity = null;
    order.accepted = false;
  }

  const city = extractDestinationCity(text);
  if (city && city !== order.city) {
    order.city = city;
    order.agency = null;
  }

  const agency = extractAgencySelection(text, precedingAssistantText);
  if (agency) {
    order.agency = agency;
    // Las opciones numeradas que presenta el bot provienen del directorio
    // de agencias Tealca. Si el cliente primero pregunto por MRW/Zoom y
    // despues eligio una de estas oficinas, esa eleccion posterior resuelve
    // el transportista y no debe dejar activo el bloqueo de pago humano.
    order.courier = 'Tealca';
    order.modality = 'agency_pickup';
    order.needsHumanPayment = false;
  }

  const norm = fold(text);
  if (isRetraction(norm)) order.accepted = false;
  else if (isCurrentTermsAcceptance(text, precedingAssistantText)) order.accepted = true;
  if (/\b(mrw|zoom)\b/.test(norm)) {
    order.courier = /\bmrw\b/.test(norm) ? 'MRW' : 'Zoom';
    order.modality = 'agency_pickup';
    order.needsHumanPayment = true;
  } else if (/\btealca\b/.test(norm)) {
    order.courier = 'Tealca';
    order.modality = 'agency_pickup';
    order.needsHumanPayment = false;
  }

  const identity = extractIdentity(text, knownCustomer);
  return { order, identity };
}

module.exports = {
  blankOrder,
  extractQuantity,
  extractIdentity,
  extractDestinationCity,
  extractAgencySelection,
  extractMoney,
  isCurrentTermsAcceptance,
  applyOrderMessage,
};

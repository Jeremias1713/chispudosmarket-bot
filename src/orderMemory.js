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
    accepted: false,
    needsHumanPayment: false,
  };
}

function extractQuantity(text, precedingAssistantText) {
  const menu = /tengo una duda antes de pedir|responde(me)?\s+con\s+el\s+numero\s*1,?\s*2\s*(o|,)\s*3/i.test(fold(precedingAssistantText));
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let result = null;
  for (const line of lines) {
    const normalized = fold(line).replace(/[.!?]+$/g, '').trim();
    if (menu && /^[123]$/.test(normalized)) continue;
    if (/\b(agencia|opcion)\s*(numero\s*)?\d+\b/.test(normalized) || /^la\s+\d+$/.test(normalized)) continue;
    if (/\b(cedula|telefono|tlf|plazo|dias?|horas?)\b/.test(normalized)) continue;
    const withUnit = normalized.match(/\b([1-9]|[12]\d|30)\s*(frascos?|unidades?|potes?|combos?|cajas?)\b/);
    if (withUnit) { result = Number(withUnit[1]); continue; }
    const word = normalized.match(/\b(un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b(?:\s*(frascos?|unidades?|potes?|combos?|cajas?))?/);
    if (word && (word[2] || Object.prototype.hasOwnProperty.call(WORD_QUANTITIES, normalized))) {
      result = WORD_QUANTITIES[word[1]];
      continue;
    }
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

function extractAgencySelection(userText, assistantText) {
  const options = agencyOptions(assistantText);
  const normalized = fold(userText).trim();
  const numbered = normalized.match(/\b(?:la|agencia|opcion)\s*(?:numero\s*)?(\d+)\b/);
  if (numbered) return options.find((option) => option.index === Number(numbered[1]))?.label || null;
  const yes = /^(si|sip|dale|ok|okay|perfecto|claro|correcto)[.!\s]*$/.test(normalized);
  if (yes && options.length === 1 && /agencia/.test(fold(assistantText))) return options[0].label;
  return null;
}

function applyOrderMessage({ currentOrder, text, precedingAssistantText, knownCustomer }) {
  const order = { ...blankOrder(), ...(currentOrder || {}) };
  const quantity = extractQuantity(text, precedingAssistantText);
  if (quantity) order.quantity = quantity;

  const city = extractDestinationCity(text);
  if (city && city !== order.city) {
    order.city = city;
    order.agency = null;
  }

  const agency = extractAgencySelection(text, precedingAssistantText);
  if (agency) order.agency = agency;

  const norm = fold(text);
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
  applyOrderMessage,
};

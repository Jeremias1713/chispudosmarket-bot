// Red de seguridad de codigo para el cierre del pedido.
//
// Problema real: el prompt le pide al modelo pedir nombre, cedula y telefono
// antes de cerrar, pero es una instruccion probabilistica. Se vieron pedidos
// cerrados (mensaje de resumen + guia de Tealca) SIN haber pedido los datos,
// o con un dato faltante (por ejemplo, la cedula tomada como telefono). Aca
// se revisa, con codigo, que los tres datos esten realmente en la
// conversacion antes de dejar pasar un mensaje de cierre.

const SAME_NUMBER_RE = /\beste\s+(?:n[uú]mero|mismo|whats|tel)|\bes\s+este\b|\bel\s+mismo\b|\bmismo\s+n[uú]mero\b|\bpor\s+aqu[ií]\b|\beste\s+es\b/i;

function normalizeText(value) {
  return String(value || '').trim();
}

// Busca grupos de digitos (permitiendo espacios, puntos y guiones entre
// ellos, como "84 587 941", "V-25.379.216" o "0412-1741-347") y los
// clasifica por largo: 6-9 digitos = cedula, 10-11 = telefono.
function extractNumbers(text) {
  const out = { cedula: false, telefono: false };
  const matches = String(text || '').match(/\d[\d.\-\s]{4,}\d/g) || [];
  for (const m of matches) {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 11 && /^(0?4)/.test(digits)) out.telefono = true;
    else if (digits.length >= 6 && digits.length <= 9) out.cedula = true;
  }
  return out;
}

// Un nombre es texto con letras, al menos dos palabras (nombre y apellido)
// una vez sacados los numeros.
function hasFullName(text) {
  const letters = String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[\d.\-_/:,;()+]/g, ' ')
    .split(/\s+/)
    .filter((w) => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}$/.test(w));
  return letters.length >= 2;
}

// Devuelve que datos faltan: subconjunto de ['nombre','cedula','telefono'].
// - card: ficha ya guardada del cliente (puede traer los datos de antes).
// - history/userText: la conversacion. Solo se miran los mensajes del
//   CLIENTE posteriores al primer pedido de datos del bot (o todos, si no
//   se pudo ubicar), para no confundir el numero de una cantidad o un
//   precio con una cedula.
function missingOrderData({ card, history, userText, requestMarker }) {
  const c = card || {};
  const have = {
    nombre: Boolean(normalizeText(c.nombre)),
    cedula: Boolean(normalizeText(c.cedula)),
    telefono: Boolean(normalizeText(c.telefono)),
  };

  const all = [...(history || []), { role: 'user', content: userText }];
  // Posicion del primer mensaje del bot que pidio los datos.
  let start = 0;
  let requestFound = !requestMarker;
  if (requestMarker) {
    const idx = all.findIndex((m) => m.role !== 'user' && requestMarker(String(m.content || '')));
    if (idx >= 0) { start = idx + 1; requestFound = true; }
  }

  for (const m of all.slice(start)) {
    if (m.role !== 'user') continue;
    const text = String(m.content || '');
    const nums = extractNumbers(text);
    if (nums.cedula) have.cedula = true;
    if (nums.telefono) have.telefono = true;
    if (SAME_NUMBER_RE.test(text)) have.telefono = true;
    if (hasFullName(text) && !/^\s*(s[ií]|no|ok|dale|listo|perfecto|correcto|gracias)\b/i.test(text)) {
      // Solo cuenta si ademas el mensaje no es una frase de conversacion
      // cualquiera: se exige que traiga al menos un numero (los datos suelen
      // venir juntos) o que sea corto (solo el nombre).
      const words = text.trim().split(/\s+/).length;
      if (nums.cedula || nums.telefono || (requestFound && words <= 5)) have.nombre = true;
    }
  }

  return ['nombre', 'cedula', 'telefono'].filter((k) => !have[k]);
}

const FIELD_LABEL = { nombre: 'nombre y apellido', cedula: 'cédula', telefono: 'número de teléfono' };

function missingDataMessage(missing) {
  const labels = missing.map((k) => FIELD_LABEL[k]);
  const list = labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`
    : labels[0];
  return `Perfecto 🙌 Para procesar tu pedido solo me falta tu ${list}. ¿Me lo pasas?`;
}

module.exports = { missingOrderData, missingDataMessage, extractNumbers, hasFullName };

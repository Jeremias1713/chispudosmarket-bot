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

// Busca numeros en el texto y los clasifica: telefono (celular venezolano con
// codigo de operadora, con o sin espacios/puntos/guiones, o cualquier numero
// de 10-13 digitos como "+573151130288") y cedula (6-9 digitos, tambien
// escrita en grupos: "13 818 930", "V-25.379.216").
const PHONE_RE = /(?<!\d)(?:\+?58[\s.\-,_]*)?0?4\d\d(?:[\s.\-,_]*\d){7}(?!\d)/g;

function extractNumbers(text) {
  const out = { cedula: false, telefono: false };
  // Los links (tiktok, etc.) traen digitos que no son cedula ni telefono.
  let rest = String(text || '').replace(/https?:\/\/\S+/gi, ' ');
  if (PHONE_RE.test(rest)) out.telefono = true;
  PHONE_RE.lastIndex = 0;
  rest = rest.replace(PHONE_RE, ' ');
  // Un numero (separadores internos simples: punto o guion) y, pegados con un
  // solo espacio, grupos cortos de hasta 4 digitos ("13 818 930").
  const groups = rest.match(/\d+(?:[.\-_]\d+)*(?:[ ](?!0\d{3}\b)\d{1,4}\b(?![.\-_]\d))*/g) || [];
  for (const g of groups) {
    const d = g.replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 13) out.telefono = true;
    else if (d.length >= 6 && d.length <= 9) out.cedula = true;
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

  for (const [i, m] of all.entries()) {
    const text = String(m.content || '');
    if (m.role !== 'user') {
      // El bot ya repitio los datos que el cliente dio (resumen del pedido):
      // eso tambien cuenta como dato presente.
      if (/c[eé]dula\s*:\s*\**\s*\d{6,}/i.test(text)) have.cedula = true;
      if (/tel[eé]fono\s*:\s*\**\s*\+?\d{9,}/i.test(text)) have.telefono = true;
      if (/nombre[^:\n]*:\s*\**\s*[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}/i.test(text)) have.nombre = true;
      continue;
    }
    const nums = extractNumbers(text);
    if (nums.cedula) have.cedula = true;
    if (nums.telefono) have.telefono = true;
    if (i >= start && SAME_NUMBER_RE.test(text)) have.telefono = true;
    if (hasFullName(text) && !/^\s*(s[ií]|no|ok|dale|listo|perfecto|correcto|gracias)\b/i.test(text)) {
      const words = text.trim().split(/\s+/).length;
      if (nums.cedula || nums.telefono || (requestFound && i >= start && words <= 5)) have.nombre = true;
    }
  }

  return ['nombre', 'cedula', 'telefono'].filter((k) => !have[k]);
}

// Solo se bloquea un mensaje que de verdad CIERRA el pedido (resumen/confirmacion),
// no una respuesta suelta que menciona Tealca, el pago y la guia (por ejemplo
// al explicar como funciona el envio).
const ORDER_SUMMARY_RE = /resumen|confirmad|confirmo|confirmamos|apartad|apart[eé]|registrad|anotad|has pedido|pediste|tu pedido (?:es|queda|est[aá])|pedido (?:queda|est[aá]) (?:listo|confirmado)/i;

function looksLikeOrderSummary(text) {
  return ORDER_SUMMARY_RE.test(String(text || ''));
}

const FIELD_LABEL = { nombre: 'nombre y apellido', cedula: 'cédula', telefono: 'número de teléfono' };

function missingDataMessage(missing) {
  const labels = missing.map((k) => FIELD_LABEL[k]);
  const list = labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`
    : labels[0];
  return `Perfecto 🙌 Para procesar tu pedido solo me falta tu ${list}. ¿Me lo pasas?`;
}

// El texto menciona los tres campos (nombre, cedula, telefono) como palabras
// sueltas, sin datos reales: es un pedido de datos en prosa.
function mentionsAllDataFields(text) {
  const t = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\bnombre\b/.test(t) && /\bcedula\b/.test(t) && /\btelefono\b/.test(t) && !/\d{6,}/.test(t);
}

module.exports = { mentionsAllDataFields, looksLikeOrderSummary, missingOrderData, missingDataMessage, extractNumbers, hasFullName };

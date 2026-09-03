// Envio masivo de una plantilla de WhatsApp, pero PERSONALIZADO por cliente
// (a diferencia de /api/broadcasts en broadcasts.js, que manda las mismas
// variables a todo el mundo). El negocio sube un Excel con una fila por
// cliente (telefono, nombre, apellido, monto, o los que necesite), y cada
// uno recibe la plantilla con SUS propios datos en los {{1}} {{2}} {{3}...}
// que correspondan, en el orden que el negocio indique desde el panel.
//
// No inventa a quien mandarle nada: si falta el telefono en una fila, esa
// fila se marca como invalida y no se manda (se lo avisa antes de confirmar).
const { sendTemplate } = require('./whatsapp');
const { appendMessage } = require('./state');

function foldHeader(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Deja solo digitos (y el + inicial si lo tenia) para que no importe si en
// el Excel el telefono viene con espacios, guiones o parentesis.
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const plus = s.startsWith('+') ? '+' : '';
  return plus + s.replace(/[^\d]/g, '');
}

function findCol(header, ...keys) {
  return header.findIndex((h) => keys.some((k) => h.includes(k)));
}

// Columnas que reconoce de entrada (podes tener mas columnas en el Excel,
// las que no reconoce simplemente se ignoran). Si el negocio necesita otra
// variable mas adelante (ej. "producto"), se agrega aca una entrada nueva.
const CAMPOS_CONOCIDOS = [
  { key: 'telefono', keys: ['telefono', 'celular', 'whatsapp', 'numero'] },
  { key: 'nombre', keys: ['nombre'] },
  { key: 'apellido', keys: ['apellido'] },
  { key: 'monto', keys: ['monto', 'deuda', 'saldo', 'total', 'precio'] },
];

// Devuelve { rows, camposDetectados } donde cada row tiene { telefono,
// nombre, apellido, monto, valido, motivo } (los campos que no se hayan
// detectado en el Excel quedan como cadena vacia, no null, para que sea mas
// facil armar los parametros de la plantilla despues).
function parsePersonalizedList(buffer) {
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('El Excel no tiene hojas.');
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rows.length) throw new Error('La hoja esta vacia.');

  const header = rows[0].map(foldHeader);
  const idx = {};
  const camposDetectados = [];
  for (const campo of CAMPOS_CONOCIDOS) {
    const i = findCol(header, ...campo.keys);
    idx[campo.key] = i;
    if (i !== -1) camposDetectados.push(campo.key);
  }

  if (idx.telefono === -1) {
    throw new Error('No encontre una columna de telefono (probe con "telefono", "celular", "whatsapp", "numero"). Revisa el encabezado del Excel.');
  }

  const parsed = rows.slice(1).map((r, i) => {
    const telefono = normalizePhone(r[idx.telefono]);
    const nombre = idx.nombre !== -1 ? String(r[idx.nombre] ?? '').trim() : '';
    const apellido = idx.apellido !== -1 ? String(r[idx.apellido] ?? '').trim() : '';
    const monto = idx.monto !== -1 ? String(r[idx.monto] ?? '').trim() : '';
    const vacia = !telefono && !nombre && !apellido && !monto;
    let valido = true;
    let motivo = null;
    if (!vacia && !telefono) {
      valido = false;
      motivo = 'sin_telefono';
    }
    return { fila: i + 2, telefono, nombre, apellido, monto, valido, motivo, vacia };
  }).filter((r) => !r.vacia);

  return { rows: parsed, camposDetectados };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Espera entre cada envio (mismo criterio que broadcasts.js/dropanas.js) para
// no mandar todo de una y que WhatsApp lo tome como spam.
const DELAY_MS = 1200;

// order: array con el orden de variables de la plantilla, ej.
// ['nombre','apellido','monto'] si la plantilla aprobada tiene {{1}}=nombre,
// {{2}}=apellido, {{3}}=monto. Cada elemento tiene que ser una de las claves
// que devuelve parsePersonalizedList (telefono/nombre/apellido/monto).
async function sendPersonalized({ templateName, languageCode, order, rows }) {
  const results = [];
  for (const row of rows) {
    if (!row.telefono) {
      results.push({ fila: row.fila, telefono: row.telefono, ok: false, error: 'Sin telefono' });
      continue;
    }
    const params = order.map((campo) => row[campo] || '');
    try {
      await sendTemplate(row.telefono, templateName, languageCode || 'es', params);
      appendMessage(row.telefono, 'human', `[plantilla masiva personalizada] ${templateName} (${params.join(', ')})`);
      results.push({ fila: row.fila, telefono: row.telefono, ok: true });
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      results.push({ fila: row.fila, telefono: row.telefono, ok: false, error: detail });
    }
    await sleep(DELAY_MS);
  }
  return results;
}

module.exports = { parsePersonalizedList, sendPersonalized };

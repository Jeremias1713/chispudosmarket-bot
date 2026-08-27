// Script para enviar un aviso masivo (plantilla ya aprobada por Meta) a una
// lista de numeros de clientes. Uso:
//
//   node src/broadcast.js nombre_plantilla data/clientes.csv "Valor variable 1" "Valor variable 2"
//
// data/clientes.csv debe tener una columna "phone" (numero en formato
// internacional, ej. 573001112233, sin "+" ni espacios).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sendTemplate } = require('./whatsapp');

function parsePhonesCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header.split(',').map((c) => c.trim().toLowerCase());
  const phoneIdx = cols.indexOf('phone');
  if (phoneIdx === -1) {
    throw new Error('El CSV debe tener una columna "phone".');
  }
  return rows
  .filter(Boolean)
  .map((row) => row.split(',')[phoneIdx].trim())
  .filter(Boolean);
}

async function main() {
  const [templateName, csvPath, ...params] = process.argv.slice(2);
  if (!templateName || !csvPath) {
    console.error(
      'Uso: node src/broadcast.js <nombre_plantilla> <ruta_csv_clientes> [valor1] [valor2] ...'
      );
    process.exit(1);
  }

const phones = parsePhonesCsv(path.resolve(csvPath));
  console.log(`Enviando plantilla "${templateName}" a ${phones.length} clientes...`);

let ok = 0;
  let fail = 0;
  for (const phone of phones) {
    try {
      await sendTemplate(phone, templateName, 'es', params);
      ok += 1;
      console.log(`OK -> ${phone}`);
    } catch (err) {
      fail += 1;
      const detail = err.response?.data || err.message;
      console.error(`FALLO -> ${phone}:`, detail);
    }
    // Pequena pausa para no saturar el rate limit de la API.
  await new Promise((r) => setTimeout(r, 250));
  }

console.log(`Listo. Enviados: ${ok}. Fallidos: ${fail}.`);
}

main();

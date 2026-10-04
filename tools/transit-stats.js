#!/usr/bin/env node
// Solo lectura. Uso: node tools/transit-stats.js <ruta a sessions.json | .json.gz>
// Imprime, por region de agencia, cuantos pedidos hay y los dias habiles de
// transito (p25, mediana, p75), y un JSON listo para pegar en transitDaysByRegion.
const fs = require('fs');
const zlib = require('zlib');

const file = process.argv[2];
if (!file) {
  console.error('Uso: node tools/transit-stats.js <sessions.json>');
  process.exit(1);
}
let raw = fs.readFileSync(file);
if (file.endsWith('.gz')) raw = zlib.gunzipSync(raw);
const data = JSON.parse(raw.toString('utf8'));
const sessions = Array.isArray(data) ? data : Object.values(data);
const { compute } = require('../src/transitStats');
const result = compute(sessions);
for (const r of result.regions) {
  const f = (n) => (n === null ? '-' : Number(n).toFixed(1));
  console.log(`${r.region.padEnd(22)} n=${String(r.n).padStart(4)}  p25=${f(r.p25)}  mediana=${f(r.median)}  p75=${f(r.p75)}${r.usesDefault ? '  (pocos datos: usa el default)' : ''}`);
}
console.log('\ntransitDaysByRegion sugerido:');
console.log(JSON.stringify(result.suggested, null, 2));

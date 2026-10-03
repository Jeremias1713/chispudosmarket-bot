#!/usr/bin/env node
// Auditoria de etapas de los chats (SOLO LECTURA): no escribe nada.
// Uso:  node tools/audit-stages.js C:\ruta\sessions.json   (o sessions.json.gz)
// Imprime conteos y hasta 10 telefonos de ejemplo (enmascarados: solo los
// ultimos 4 digitos) por cada caso que suele indicar una etapa mal puesta.
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const file = process.argv[2];
if (!file) {
  console.error('Uso: node tools/audit-stages.js <ruta a sessions.json>');
  process.exit(1);
}
let raw = fs.readFileSync(file);
if (file.endsWith('.gz')) raw = zlib.gunzipSync(raw);
const data = JSON.parse(raw.toString('utf8'));
const sessions = Object.entries(data).map(([phone, s]) => ({ ...s, phone: s.phone || phone }));

const DAY = 86400000;
const now = Date.now();
const mask = (p) => `…${String(p).slice(-4)}`;
const days = (iso) => (iso ? (now - Date.parse(iso)) / DAY : null);
const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// Copia del criterio de isClosingMessage (src/ai.js) para no arrastrar el resto del bot.
const isClosing = (t) => { const n = norm(t); return n.includes('tealca') && n.includes('pago') && n.includes('guia'); };
const RANK1 = ['vendido', 'vendido_fecha_futura', 'esperando_guia', 'tienda_maracaibo'];

const report = [];
function add(title, list) {
  report.push({ title, count: list.length, examples: list.slice(0, 10).map((s) => mask(s.phone)) });
}

// 1) candados por motivo
const locked = sessions.filter((s) => s.stageLocked === true);
const byReason = {};
for (const s of locked) {
  const r = String(s.stageReason || '(sin motivo)');
  const key = /^DroPanas:/.test(r) ? 'DroPanas:' : /^Aviso de llegada/.test(r) ? 'Aviso de llegada' : /^Fijada desde el panel/.test(r) ? 'Fijada desde el panel' : 'otros';
  (byReason[key] = byReason[key] || []).push(s);
}
for (const [k, list] of Object.entries(byReason)) add(`Chats con candado (stageLocked) - motivo: ${k}`, list);

// 2) vendido/esperando_guia viejos sin guia
add('En vendido/esperando_guia hace mas de 4 dias y sin guia', sessions.filter((s) => ['vendido', 'esperando_guia'].includes(s.stage) && (days(s.soldAt) ?? 0) > 4 && !s.card?.guia));

// 3) guia cargada pero etapa de rango 1
add('Con guia cargada pero en etapa de rango 1 (deberia ser en_camino o mas)', sessions.filter((s) => s.card?.guia && RANK1.includes(s.stage)));

// 4) llegada perdida
add('En camino hace mas de 7 dias desde el aviso de despacho (llegada perdida?)', sessions.filter((s) => s.stage === 'en_camino' && (days(s.shippingNotifiedAt) ?? 0) > 7));

// 5) posible recompra no detectada
add('Pedido cerrado cuyo ultimo cierre del bot es posterior en mas de 24 h a soldAt (posible recompra no detectada)', sessions.filter((s) => {
  if (s.orderClosed !== true || !s.soldAt) return false;
  const h = Array.isArray(s.history) ? s.history : [];
  for (let i = h.length - 1; i >= 0; i -= 1) {
    if (h[i].role === 'assistant' && isClosing(h[i].content)) return Date.parse(h[i].at || '') - Date.parse(s.soldAt) > DAY;
  }
  return false;
}));

// 6) entrega no registrada
const delivered = /ya lo retir|ya me lleg|ya lo busqu/;
add('En esperando_retiro con un mensaje del cliente que dice que ya lo retiro/recibio (entrega no registrada)', sessions.filter((s) => s.stage === 'esperando_retiro' && (s.history || []).some((m) => m.role === 'user' && delivered.test(norm(m.content)))));

console.log(`Chats leidos: ${sessions.length}\n`);
for (const r of report) {
  console.log(`- ${r.title}: ${r.count}`);
  if (r.examples.length) console.log(`    ejemplos: ${r.examples.join(', ')}`);
}

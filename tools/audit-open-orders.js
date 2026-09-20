'use strict';

// Auditoria estrictamente de solo lectura. No importa state.js para evitar
// cualquier inicializacion/escritura accidental: lee el JSON directamente y
// emite identificadores enmascarados, nunca nombre/cedula/telefono completos.
const fs = require('fs');
const path = require('path');

const dataDir = process.env.BOT_DATA_DIR || path.join(__dirname, '..', 'data');
const sessionsPath = path.join(dataDir, 'sessions.json');

function maskedId(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

function candidateReasons(session) {
  if (!session || session.orderClosed === true) return [];
  if (['vendido', 'esperando_guia', 'tienda_maracaibo', 'en_camino', 'esperando_retiro', 'entregado'].includes(session.stage)) return [];
  const order = session.currentOrder || {};
  const card = session.card || {};
  const reasons = [];
  if (order.product || card.producto) reasons.push('producto registrado');
  if (Number(order.quantity) > 0) reasons.push('cantidad registrada');
  if (order.agency || card.agenciaConfirmadaEnChat || card.agencia) reasons.push('agencia registrada');
  if (card.nombre && card.cedula && card.telefono) reasons.push('identidad completa');
  if (Number(order.total) > 0 || Number(card.monto) > 0) reasons.push('total registrado');
  if (order.accepted === true) reasons.push('aceptacion vigente registrada');
  const lastBot = [...(session.history || [])].reverse().find((m) => m.role === 'assistant');
  if (lastBot && /pedido.{0,40}(confirmado|listo|procesado)|contra entrega|pagas? al recibir/i.test(String(lastBot.content || ''))) {
    reasons.push('ultimo mensaje del bot parece un cierre');
  }
  return reasons.length >= 4 ? reasons : [];
}

let sessions;
try {
  sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
} catch (err) {
  console.error(`No se pudo leer ${sessionsPath}: ${err.message}`);
  process.exit(1);
}

const candidates = Object.entries(sessions).flatMap(([phone, session]) => {
  const reasons = candidateReasons(session);
  return reasons.length ? [{ id: maskedId(phone), stage: session.stage || null, reasons }] : [];
});

process.stdout.write(`${JSON.stringify({ source: sessionsPath, readOnly: true, candidates }, null, 2)}\n`);

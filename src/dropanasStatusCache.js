'use strict';

// S7: cache compartido del estado actual de cada pedido en DroPanas.
// Bug real: pickupReminders.officeStatus hacia como maximo 40 consultas
// pedido por pedido cuando el listado no esta autorizado, asi que con mas de
// 40 chats esperando retiro el resto quedaba sin confirmar y sin
// recordatorio. Ahora el reconciliador (S8) llena este cache y
// pickupReminders/lastNotice lo leen: si el dato tiene menos de 2 horas, no
// consultan DroPanas.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./dataDir');
const { classifyStatus } = require('./dropanasStatus');

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const filePath = () => path.join(DATA_DIR, 'dropanas-status-cache.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8')) || {};
  } catch (err) {
    return {};
  }
}

function save(cache) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const entries = Object.entries(cache)
      .sort((a, b) => String(b[1]?.fetchedAt).localeCompare(String(a[1]?.fetchedAt)))
      .slice(0, MAX_ENTRIES);
    const temp = `${filePath()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(entries)));
    fs.renameSync(temp, filePath());
  } catch (err) {
    console.error('No se pudo guardar el cache de estados DroPanas:', err.message);
  }
}

// orders: lista de ordenes mapeadas (dropanasApi.mapOrder).
function putMany(orders, now = new Date()) {
  const cache = load();
  const fetchedAt = now.toISOString();
  for (const order of orders || []) {
    if (!order || order.dropanasId == null) continue;
    cache[String(order.dropanasId)] = {
      estadoPedido: order.estadoPedido || '',
      kind: classifyStatus(order.estadoPedido).kind,
      guia: order.guia || '',
      updatedAt: order.updatedAt || null,
      fetchedAt,
    };
  }
  save(cache);
}

// Devuelve una orden minima { dropanasId, estadoPedido, guia, updatedAt } si
// el dato tiene menos de TTL_MS, o null.
function getFresh(id, now = Date.now(), cache = load()) {
  const row = cache[String(id)];
  if (!row) return null;
  const at = Date.parse(row.fetchedAt || '');
  if (!Number.isFinite(at) || now - at > TTL_MS) return null;
  return { dropanasId: String(id), estadoPedido: row.estadoPedido, guia: row.guia, updatedAt: row.updatedAt, _fromCache: true };
}

module.exports = { load, putMany, getFresh, TTL_MS };

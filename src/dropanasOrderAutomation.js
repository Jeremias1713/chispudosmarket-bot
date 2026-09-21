'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { getSession, updateSession, listSessions } = require('./state');
const settingsStore = require('./settings');
const dropanasApi = require('./dropanasApi');
const { SOLD_STAGES } = require('./stageRules');

const CACHE_MS = 5 * 60 * 1000;
let cache = null;
let cachePromise = null;
const locks = new Set();

function fold(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function defaultMappings() {
  return [
    { id: 'turkesterone', label: 'Turkesterone', aliases: ['turkesterone'], productId: 20702, warehouseId: 1, prices: { 1: 39900 }, enabled: true },
    { id: 'shilajit', label: 'Shilajit Viking', aliases: ['shilajit', 'shilajit viking'], productId: 20343, warehouseId: 1, prices: { 1: 36900, 2: 51900 }, enabled: true },
  ];
}

function settings() {
  const current = settingsStore.getSettings();
  return {
    uploadEnabled: Boolean(current.dropanasOrderUploadEnabled),
    autoCreateEnabled: Boolean(current.dropanasOrderAutoCreateEnabled),
    activatedAt: current.dropanasOrderActivatedAt || null,
    mappings: Array.isArray(current.dropanasOrderMappings) && current.dropanasOrderMappings.length
      ? current.dropanasOrderMappings : defaultMappings(),
  };
}

function normalizeMapping(row, index) {
  const productId = Number(row?.productId);
  const warehouseId = Number(row?.warehouseId || 1);
  const prices = {};
  for (const [quantity, total] of Object.entries(row?.prices || {})) {
    const q = Number(quantity);
    const value = Number(total);
    if (Number.isInteger(q) && q > 0 && Number.isFinite(value) && value > 0) prices[q] = value;
  }
  return {
    id: String(row?.id || `producto-${index + 1}`).trim(),
    label: String(row?.label || '').trim(),
    aliases: [...new Set((Array.isArray(row?.aliases) ? row.aliases : String(row?.aliases || '').split(','))
      .map((item) => String(item || '').trim()).filter(Boolean))],
    productId: Number.isInteger(productId) && productId > 0 ? productId : null,
    warehouseId: Number.isInteger(warehouseId) && warehouseId > 0 ? warehouseId : 1,
    prices,
    enabled: row?.enabled !== false,
  };
}

function validateConfig(input) {
  const mappings = (Array.isArray(input?.mappings) ? input.mappings : []).map(normalizeMapping);
  const errors = [];
  if (!mappings.length) errors.push('Agrega al menos un producto.');
  for (const row of mappings) {
    if (!row.label) errors.push('Cada producto necesita un nombre visible.');
    if (!row.productId) errors.push(`${row.label || row.id}: falta el ID de producto DroPanas.`);
    if (!row.aliases.length) errors.push(`${row.label || row.id}: agrega al menos un alias.`);
    if (!Object.keys(row.prices).length) errors.push(`${row.label || row.id}: agrega al menos un precio por cantidad.`);
  }
  return { mappings, errors };
}

function saveConfig(input) {
  const { mappings, errors } = validateConfig(input);
  if (errors.length) throw new Error(errors.join(' '));
  const previous = settings();
  const uploadEnabled = Boolean(input.uploadEnabled);
  const autoCreateEnabled = uploadEnabled && Boolean(input.autoCreateEnabled);
  let activatedAt = previous.activatedAt;
  if (autoCreateEnabled && !previous.autoCreateEnabled) activatedAt = new Date().toISOString();
  if (!autoCreateEnabled) activatedAt = null;
  settingsStore.updateSettings({
    dropanasOrderUploadEnabled: uploadEnabled,
    dropanasOrderAutoCreateEnabled: autoCreateEnabled,
    dropanasOrderActivatedAt: activatedAt,
    dropanasOrderMappings: mappings,
  });
  cache = null;
  cachePromise = null;
  return settings();
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { nombre: parts.slice(0, -1).join(' '), apellido: parts.at(-1) };
}

function localPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('58') && digits.length === 12) digits = `0${digits.slice(2)}`;
  if (digits.length === 10 && digits.startsWith('4')) digits = `0${digits}`;
  return /^0(?:412|414|416|422|424|426)\d{7}$/.test(digits) ? digits : null;
}

function findMapping(productName, mappings) {
  const value = fold(productName);
  if (!value) return null;
  const matches = mappings.filter((row) => row.enabled && [row.label, ...(row.aliases || [])]
    .some((alias) => {
      const normalized = fold(alias);
      return normalized && (value === normalized || value.includes(normalized) || normalized.includes(value));
    }));
  return matches.length === 1 ? matches[0] : null;
}

function historyOrderFacts(history = []) {
  let quantity = null;
  let total = null;
  let agency = null;
  const messages = Array.isArray(history) ? history : [];
  let previousAssistant = '';
  for (const message of messages) {
    const content = String(message?.content || '');
    const normalized = fold(content);
    if (message?.role === 'user') {
      const numeric = normalized.match(/\b([1-9]|[12]\d)\s*(?:frascos?|potes?|unidades?)\b/);
      const word = normalized.match(/\b(un|una|uno|dos|tres|cuatro|cinco)\s*(?:frascos?|potes?|unidades?)?\b/);
      const values = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };
      if (numeric) quantity = Number(numeric[1]);
      else if (word && (/frasco|pote|unidad|combo|llevo|quiero|necesito/.test(normalized))) quantity = values[word[1]];
      else if (/cuantos?|cantidad|frascos?|potes?/.test(fold(previousAssistant))) {
        const short = normalized.match(/^(?:solo\s+)?(1|2|3|un|una|uno|dos|tres)(?:\s+para\s+probar)?$/);
        if (short) quantity = Number(short[1]) || values[short[1]];
      }
    }
    const moneyMatches = [...content.matchAll(/(\d{1,3}(?:[.,]\d{3})+|\d{4,6})\s*(?:Bs\.?|bol[ií]vares)/gi)];
    if (message?.role !== 'user' && moneyMatches.length) {
      const raw = moneyMatches.at(-1)[1];
      total = Number(raw.replace(/[.,](?=\d{3}(?:\D|$))/g, '').replace(',', '.')) || total;
    }
    if (message?.role !== 'user') {
      const isAgencyConfirmation = !/(^|\n)\s*\d+[.)]\s/.test(content)
        && /reserv|apart|retir|retiro|envi|entreg|resumen|pedido/i.test(content);
      const match = content.match(/(?:retirar|retiro)\s+en\s+(?:la\s+)?agencia\s+(?:de\s+)?([^\n.!?]+)/i)
        || (isAgencyConfirmation
          ? content.match(/(?:para|en)\s+(?:la\s+)?agencia(?:\s+tealca)?\s+(?:de\s+)?([^\n.!?,;]+)/i)
          : null);
      if (match) agency = match[1].trim();
      previousAssistant = content;
    }
  }
  return { quantity, total, agency };
}

function baseDraft(phone, session, config = settings()) {
  const card = session.card || {};
  const order = session.currentOrder || {};
  const historyFacts = historyOrderFacts(session.history);
  const name = card.nombre || session.name || '';
  const identity = splitName(name);
  const productName = order.product || card.producto || '';
  const mapping = findMapping(productName, config.mappings);
  const quantity = Number(order.quantity || historyFacts.quantity || 0);
  const mappedTotal = mapping?.prices?.[quantity];
  // El precio estructurado del mapeo es el respaldo seguro. No se toma un
  // monto suelto del historial porque los mensajes promocionales suelen
  // mostrar varios precios a la vez y elegir "el último" sería peligroso.
  const rememberedTotal = Number(order.total ?? card.monto);
  const total = Number.isFinite(rememberedTotal) && rememberedTotal > 0 ? rememberedTotal : Number(mappedTotal || 0);
  const agency = String(order.agency || card.agenciaConfirmadaEnChat || card.agencia || historyFacts.agency || '').trim();
  const issues = [];
  if (session.orderClosed !== true && !SOLD_STAGES.includes(session.stage || '')) {
    issues.push('La compra todavía no está confirmada.');
  }
  if (!identity) issues.push('Falta nombre y apellido.');
  if (!String(card.cedula || '').replace(/\D/g, '').match(/^\d{6,9}$/)) issues.push('Falta una cédula válida.');
  if (!localPhone(card.telefono || phone)) issues.push('Falta un teléfono venezolano válido.');
  if (!mapping) issues.push('El producto no tiene un mapeo único a DroPanas.');
  if (!Number.isInteger(quantity) || quantity < 1) issues.push('Falta confirmar la cantidad.');
  if (!total) issues.push('Falta configurar el precio para esa cantidad.');
  if (!agency) issues.push('Falta confirmar una oficina de retiro.');
  if (session.dropanasOrder?.id) issues.push(`Ya fue subido como pedido #${session.dropanasOrder.id}.`);
  return {
    phone, name, identity, cedula: String(card.cedula || '').replace(/\D/g, ''),
    customerPhone: localPhone(card.telefono || phone), productName, mapping,
    quantity, total, agency, soldAt: session.soldAt || null,
    current: session.dropanasOrder || null, issues,
  };
}

async function apiGet(endpoint, config, params) {
  const response = await axios.get(`${config.baseUrl}/${endpoint}`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' }, params,
    timeout: config.timeoutMs, validateStatus: (status) => status >= 200 && status < 300,
  });
  const mode = String(response.headers['x-dropanas-mode'] || '').toLowerCase();
  if (mode !== config.tokenMode) throw new Error(`Modo DroPanas inesperado: ${mode || 'sin identificar'}`);
  return response.data?.data ?? response.data;
}

async function snapshot(config = dropanasApi.configFromEnv()) {
  dropanasApi.assertReadOnlyEnabled(config);
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (cachePromise) return cachePromise;
  cachePromise = (async () => {
    const current = settings();
    const productIds = [...new Set(current.mappings.filter((m) => m.enabled).map((m) => Number(m.productId)).filter(Boolean))];
    const warehouseIds = [...new Set(current.mappings.filter((m) => m.enabled).map((m) => Number(m.warehouseId)).filter(Boolean))];
    const [products, offices, inventories] = await Promise.all([
      Promise.all(productIds.map(async (id) => apiGet(`productos/${id}`, config))),
      apiGet('oficinas', config, { carrier: 'tealca' }),
      Promise.all(warehouseIds.map(async (id) => ({ warehouseId: id, rows: await apiGet(`bodegas/${id}/inventario`, config) }))),
    ]);
    const value = { products, offices: Array.isArray(offices) ? offices : [], inventories };
    cache = { at: Date.now(), value };
    return value;
  })();
  try {
    return await cachePromise;
  } finally {
    cachePromise = null;
  }
}

function resolveOffice(label, offices) {
  const query = fold(label);
  if (!query) return null;
  const matches = offices.filter((office) => {
    const name = fold(office.nombre);
    const address = fold(office.direccion);
    return (name && (query.includes(name) || name.includes(query))) || (address && query.length > 8 && address.includes(query));
  });
  return matches.length === 1 ? matches[0] : null;
}

async function prepareDraft(phone, session = getSession(phone)) {
  const draft = baseDraft(phone, session);
  if (draft.current?.id || !draft.mapping || !draft.agency) return draft;
  try {
    const live = await snapshot();
    const product = live.products.find((item) => Number(item?.id) === Number(draft.mapping.productId));
    if (!product) draft.issues.push(`El producto ${draft.mapping.productId} ya no existe en DroPanas.`);
    const inventory = live.inventories.find((item) => Number(item.warehouseId) === Number(draft.mapping.warehouseId));
    const stock = (inventory?.rows || []).filter((row) => Number(row?.producto?.id) === Number(draft.mapping.productId))
      .reduce((sum, row) => sum + Number(row.cantidad || 0), 0);
    if (stock < draft.quantity) draft.issues.push(`Inventario insuficiente: quedan ${stock}.`);
    const office = resolveOffice(draft.agency, live.offices);
    if (!office) draft.issues.push('La oficina mencionada no coincide de forma única con el catálogo oficial de Tealca.');
    draft.official = { product, stock, office };
  } catch (error) {
    draft.issues.push(`No se pudo validar con DroPanas: ${error.message}`);
  }
  return draft;
}

async function listDrafts() {
  const rows = listSessions().filter((session) => SOLD_STAGES.includes(session.stage || '') || session.orderClosed === true);
  const drafts = await Promise.all(rows.map((session) => prepareDraft(session.phone, session)));
  return drafts.sort((a, b) => new Date(b.soldAt || 0) - new Date(a.soldAt || 0));
}

function externalReference(draft) {
  const stamp = String(draft.soldAt || new Date().toISOString()).replace(/\D/g, '').slice(0, 14);
  return `CHISPUDOS-${String(draft.phone).slice(-10)}-${stamp}`.slice(0, 80);
}

async function createForPhone(phone, { automatic = false } = {}) {
  if (locks.has(phone)) throw new Error('Ese pedido ya se está procesando.');
  locks.add(phone);
  try {
    const config = settings();
    if (!config.uploadEnabled) throw new Error('La subida de pedidos está desactivada en el panel.');
    if (automatic && !config.autoCreateEnabled) return { skipped: true, reason: 'automatico_desactivado' };
    const session = getSession(phone);
    const draft = await prepareDraft(phone, session);
    if (draft.current?.id) return { ok: true, duplicate: true, order: draft.current };
    if (draft.issues.length) throw new Error(draft.issues.join(' '));
    const office = draft.official.office;
    const persisted = session.dropanasOrder || {};
    const idempotencyKey = persisted.idempotencyKey || crypto.randomUUID();
    const reference = persisted.externalReference || externalReference(draft);
    updateSession(phone, { dropanasOrder: { ...persisted, status: 'subiendo', idempotencyKey, externalReference: reference, attemptedAt: new Date().toISOString() } });
    const apiConfig = dropanasApi.configFromEnv();
    dropanasApi.assertReadOnlyEnabled(apiConfig);
    if (apiConfig.tokenMode !== 'live') {
      throw new Error('La creación de pedidos exige la API de producción de DroPanas.');
    }
    const response = await axios.post(`${apiConfig.baseUrl}/ordenes`, {
      external_reference: reference,
      cliente: { ...draft.identity, telefono: draft.customerPhone, documento: { tipo: 'V', numero: draft.cedula } },
      direccion: {
        state_id: Number(office.state_id), city_id: Number(office.city_id),
        direccion: office.direccion || office.nombre, referencia: `Retiro en oficina Tealca ${office.nombre}`,
      },
      productos: [{ producto_id: Number(draft.mapping.productId), cantidad: draft.quantity, precio_venta_ves: draft.total / draft.quantity }],
      bodega_origen_id: Number(draft.mapping.warehouseId),
      tipo_entrega: 'oficina', shipping_type_id: 3, oficina_id: Number(office.id),
      tipo_pago: 'con_recaudo', requiere_aprobacion: true,
      nota_cliente: 'Pedido creado por ChispudosMarket. Revisar antes de aprobar.',
    }, {
      headers: { Authorization: `Bearer ${apiConfig.token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      timeout: apiConfig.timeoutMs, validateStatus: (status) => status >= 200 && status < 300,
    });
    const mode = String(response.headers['x-dropanas-mode'] || '').toLowerCase();
    if (mode !== 'live') throw new Error(`DroPanas respondió en modo ${mode || 'desconocido'}; se detuvo la operación.`);
    const created = response.data?.data ?? response.data;
    if (created?.estado_aprobacion !== 'pendiente_aprobacion') throw new Error('DroPanas no confirmó que la orden quedara pendiente de aprobación.');
    const order = { id: created.id, status: created.estado_aprobacion, externalReference: reference, createdAt: new Date().toISOString(), automatic: Boolean(automatic) };
    updateSession(phone, { dropanasOrder: order });
    return { ok: true, order };
  } catch (error) {
    const session = getSession(phone);
    if (!session.dropanasOrder?.id) updateSession(phone, { dropanasOrder: { ...(session.dropanasOrder || {}), status: 'error', error: error.message, failedAt: new Date().toISOString() } });
    throw error;
  } finally {
    locks.delete(phone);
  }
}

function maybeCreate(phone) {
  const config = settings();
  if (!config.uploadEnabled || !config.autoCreateEnabled || !config.activatedAt) return;
  const session = getSession(phone);
  if (!session.soldAt || new Date(session.soldAt) < new Date(config.activatedAt)) return;
  setImmediate(() => createForPhone(phone, { automatic: true }).catch((error) => {
    console.error(`Pedido DroPanas no creado para ${phone}:`, error.message);
  }));
}

module.exports = { defaultMappings, settings, validateConfig, saveConfig, baseDraft, prepareDraft, listDrafts, createForPhone, maybeCreate, splitName, localPhone, findMapping, resolveOffice, historyOrderFacts };

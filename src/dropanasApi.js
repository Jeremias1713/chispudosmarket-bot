'use strict';

const axios = require('axios');
const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://app.dropanas.com/api/v1';
const DELIVERY_TO_CARRIER = Object.freeze({
  oficina: 'tealca',
  domicilio: 'pidelo-y-punto',
  zoom: 'zoom',
  menssajero: 'mrw',
});

function bool(value) {
  return String(value || '').toLowerCase() === 'true';
}

function configFromEnv(env = process.env) {
  const token = String(env.DROPANAS_API_TOKEN || '').trim();
  const tokenMode = token.startsWith('live_sk_') ? 'live' : token.startsWith('test_sk_') ? 'sandbox' : null;
  return {
    enabled: bool(env.DROPANAS_API_ENABLED),
    readOnlyAck: bool(env.DROPANAS_API_READ_ONLY_ACK),
    token,
    tokenMode,
    baseUrl: String(env.DROPANAS_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    timeoutMs: Math.max(1000, Number(env.DROPANAS_API_TIMEOUT_MS || 20000)),
    maxPages: Math.max(1, Number(env.DROPANAS_API_MAX_PAGES || 1000)),
  };
}

function assertReadOnlyEnabled(config) {
  if (!config.enabled || !config.readOnlyAck || !config.token || !config.tokenMode) {
    throw new Error('API Dropanas bloqueada: exige DROPANAS_API_ENABLED=true, DROPANAS_API_READ_ONLY_ACK=true y un token test_sk_/live_sk_ válido');
  }
  if (config.baseUrl !== DEFAULT_BASE_URL) {
    throw new Error(`Base URL de Dropanas no autorizada: ${config.baseUrl}`);
  }
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^0\d{10}$/.test(digits)) return `58${digits.slice(1)}`;
  if (/^58\d{10}$/.test(digits)) return digits;
  return digits || '';
}

function inferCarrier(tipoEntrega) {
  return DELIVERY_TO_CARRIER[String(tipoEntrega || '').trim().toLowerCase()] || 'desconocida';
}

function productLabel(products) {
  if (!Array.isArray(products)) return '';
  return products
    .map((item) => {
      const name = String(item?.nombre || '').trim();
      const quantity = Number(item?.cantidad || 1);
      return name ? (quantity > 1 ? `${quantity} × ${name}` : name) : '';
    })
    .filter(Boolean)
    .join(', ');
}

function mapOrder(item) {
  if (!item || item.id == null) throw new Error('Orden Dropanas sin id');
  const client = item.cliente || {};
  const tracking = item.tracking || {};
  const fullName = `${client.nombre || ''} ${client.apellido || ''}`.replace(/\s+/g, ' ').trim();
  return {
    dropanasId: String(item.id),
    guia: String(tracking.numero_guia || '').trim(),
    cliente: fullName,
    telefono: normalizePhone(client.telefono),
    ciudad: '',
    producto: productLabel(item.productos),
    estadoPedido: String(tracking.status || item.status || '').trim(),
    totalVentaBs: item.precio_venta_ves ?? '',
    bodegaDestino: '',
    carrier: inferCarrier(item.tipo_entrega),
    tipoEntrega: String(item.tipo_entrega || '').trim(),
    oficinaId: item.oficina_id ?? item.oficina_zoom_id ?? item.agencia_menssajero_id ?? null,
    estadoAprobacion: String(item.estado_aprobacion || '').trim(),
    externalReference: String(item.external_reference || item.referencia_externa || '').trim(),
    updatedAt: item.updated_at || null,
    _source: 'dropanas-api-readonly',
  };
}

function mapNovelty(item) {
  if (!item || item.id == null) throw new Error('Novedad Dropanas sin id');
  return {
    id: String(item.id),
    orderId: item.orden_id == null ? null : String(item.orden_id),
    status: String(item.status || '').trim(),
    type: String(item.tipo_novedad || '').trim(),
    updatedAt: item.updated_at || null,
  };
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validatePage(payload, requestedPage) {
  if (!payload || !Array.isArray(payload.data) || !payload.links || !payload.meta) {
    throw new Error('Contrato Dropanas inesperado: se esperaban data, links y meta');
  }
  const currentPage = Number(payload.meta.current_page);
  const lastPage = Number(payload.meta.last_page);
  const perPage = Number(payload.meta.per_page);
  const total = Number(payload.meta.total);
  if (![currentPage, lastPage, perPage, total].every(Number.isFinite)
      || currentPage !== requestedPage || currentPage < 1 || lastPage < currentPage
      || perPage < 1 || total < 0) {
    throw new Error('Metadatos de paginación Dropanas inválidos');
  }
  return { currentPage, lastPage, perPage, total, next: payload.links.next || null };
}

function headerValue(headers, name) {
  if (!headers) return '';
  return String(headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? '').trim().toLowerCase();
}

async function fetchPage(endpoint, page, { config = configFromEnv(), client = axios } = {}) {
  assertReadOnlyEnabled(config);
  const response = await client.get(`${config.baseUrl}/${endpoint}`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    params: { per_page: 100, page },
    timeout: config.timeoutMs,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const responseMode = headerValue(response.headers, 'x-dropanas-mode');
  if (responseMode !== config.tokenMode) {
    throw new Error(`Modo Dropanas inesperado: token ${config.tokenMode}, respuesta ${responseMode || 'sin header'}`);
  }
  return { rows: response.data.data, page: validatePage(response.data, page), responseMode };
}

async function fetchAll(endpoint, options = {}) {
  const config = options.config || configFromEnv();
  const rows = [];
  let page = 1;
  let declaredTotal = null;
  let responseMode = null;
  for (;;) {
    if (page > config.maxPages) throw new Error(`Paginación Dropanas abortada tras ${config.maxPages} páginas`);
    const result = await fetchPage(endpoint, page, { ...options, config });
    rows.push(...result.rows);
    declaredTotal = result.page.total;
    responseMode = result.responseMode;
    if (page >= result.page.lastPage) {
      if (rows.length !== declaredTotal) {
        throw new Error(`Lectura Dropanas incompleta: declaró ${declaredTotal} filas y se leyeron ${rows.length}`);
      }
      return { rows, total: declaredTotal, pages: page, mode: responseMode };
    }
    if (!result.page.next) throw new Error(`Lectura Dropanas incompleta: página ${page} sin enlace next`);
    page += 1;
  }
}

async function fetchOrders(options = {}) {
  const result = await fetchAll('ordenes', options);
  return { ...result, orders: result.rows.map(mapOrder) };
}

async function fetchOrder(orderId, { config = configFromEnv(), client = axios } = {}) {
  assertReadOnlyEnabled(config);
  if (!/^\d+$/.test(String(orderId))) throw new Error('ID de orden Dropanas invalido');
  const response = await client.get(`${config.baseUrl}/ordenes/${orderId}`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    timeout: config.timeoutMs,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const responseMode = headerValue(response.headers, 'x-dropanas-mode');
  if (responseMode !== config.tokenMode) throw new Error('Modo Dropanas inesperado en detalle de orden');
  if (!response.data?.data) throw new Error('Contrato Dropanas inesperado en detalle de orden');
  return { order: mapOrder(response.data.data), mode: responseMode };
}

async function fetchNovelties(options = {}) {
  const result = await fetchAll('novedades', options);
  return { ...result, novelties: result.rows.map(mapNovelty) };
}

async function fetchTracking(orderId, { config = configFromEnv(), client = axios } = {}) {
  assertReadOnlyEnabled(config);
  if (!/^\d+$/.test(String(orderId))) throw new Error('ID de orden Dropanas inválido');
  const response = await client.get(`${config.baseUrl}/ordenes/${orderId}/tracking`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    timeout: config.timeoutMs,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const responseMode = headerValue(response.headers, 'x-dropanas-mode');
  if (responseMode !== config.tokenMode) throw new Error('Modo Dropanas inesperado en tracking');
  return response.data?.data || null;
}

module.exports = {
  DEFAULT_BASE_URL,
  configFromEnv,
  assertReadOnlyEnabled,
  normalizePhone,
  inferCarrier,
  mapOrder,
  mapNovelty,
  fingerprint,
  validatePage,
  fetchAll,
  fetchOrders,
  fetchOrder,
  fetchNovelties,
  fetchTracking,
};

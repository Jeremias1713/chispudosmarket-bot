'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const dropanasApi = require('./dropanasApi');
const { MEDIA_DIR } = require('./library');

const OUTPUT_DIR = path.join(MEDIA_DIR, 'guias');
const MAX_PDF_BYTES = 5 * 1024 * 1024;

function bool(value) {
  return String(value || '').toLowerCase() === 'true';
}

function configFromEnv(env = process.env) {
  return {
    ...dropanasApi.configFromEnv(env),
    guideEnabled: bool(env.DROPANAS_GUIDE_ENABLED),
    guideTimeoutMs: Math.max(3000, Number(env.DROPANAS_GUIDE_TIMEOUT_MS || 30000)),
  };
}

function status() {
  const config = configFromEnv();
  const configured = Boolean(config.token && config.tokenMode);
  return {
    enabled: config.guideEnabled && config.enabled && config.readOnlyAck && configured,
    configured,
    mode: config.tokenMode,
    source: 'official-api',
  };
}

function assertEnabled(config) {
  if (!config.guideEnabled) {
    throw new Error('Descarga de etiquetas bloqueada: configura DROPANAS_GUIDE_ENABLED=true');
  }
  dropanasApi.assertReadOnlyEnabled(config);
}

function compactTracking(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function headerValue(headers, name) {
  if (!headers) return '';
  return String(headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? '').trim().toLowerCase();
}

function extractLabelMetadata(text) {
  const clean = String(text || '').replace(/\r/g, '');
  const phoneSection = clean.match(/TEL[EÉ]FONO\s*([+\d][\d\s().-]{8,24})/i);
  const phone = dropanasApi.normalizePhone(phoneSection?.[1]);
  const nameSection = clean.match(/NOMBRE\s+([^\n]{2,80})/i);
  const client = String(nameSection?.[1] || '')
    .replace(/\s{2,}.*$/, '')
    .replace(/\bENTREGA\b.*$/i, '')
    .trim();
  return { phone, client };
}

async function renderVerifiedPdf(pdfBuffer, expectedTracking) {
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('Dropanas no devolvió un PDF de etiqueta válido');
  }
  const mupdf = await import('mupdf');
  const document = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
  const pages = document.countPages();
  if (pages !== 1) throw new Error(`La etiqueta tiene ${pages} páginas; requiere revisión manual`);
  const page = document.loadPage(0);
  const text = page.toStructuredText().asText();
  const expected = compactTracking(expectedTracking);
  if (!expected || !compactTracking(text).includes(expected)) {
    throw new Error('El PDF descargado no contiene el número de guía esperado');
  }
  const pixmap = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
  const png = Buffer.from(pixmap.asPNG());
  if (png.length < 1000) throw new Error('La imagen generada de la etiqueta está incompleta');
  return { png, pages, text, ...extractLabelMetadata(text) };
}

async function capture({ orderId, expectedTracking, expectedCarrier, config = configFromEnv(), client = axios } = {}) {
  if (!/^\d+$/.test(String(orderId || ''))) throw new Error('ID de pedido Dropanas inválido');
  if (!compactTracking(expectedTracking)) throw new Error('Número de guía Dropanas inválido');
  assertEnabled(config);

  const response = await client.get(`${config.baseUrl}/ordenes/${orderId}/guia.pdf`, {
    responseType: 'arraybuffer',
    headers: dropanasApi.requestHeaders(config.token, 'application/pdf'),
    timeout: config.guideTimeoutMs,
    maxContentLength: MAX_PDF_BYTES,
    maxBodyLength: MAX_PDF_BYTES,
    validateStatus: (statusCode) => statusCode >= 200 && statusCode < 300,
  });

  const responseMode = headerValue(response.headers, 'x-dropanas-mode');
  if (responseMode !== config.tokenMode) {
    throw new Error(`Modo Dropanas inesperado en guía: token ${config.tokenMode}, respuesta ${responseMode || 'sin header'}`);
  }
  const guideCarrier = headerValue(response.headers, 'x-guia-transportadora');
  const guideOrigin = headerValue(response.headers, 'x-guia-origen');
  const wantedCarrier = String(expectedCarrier || '').trim().toLowerCase();
  if (config.tokenMode === 'live' && wantedCarrier && guideOrigin !== 'transportadora') {
    throw new Error('La etiqueta oficial de la transportadora todavía no está disponible');
  }
  if (config.tokenMode === 'live' && wantedCarrier && guideCarrier && guideCarrier !== wantedCarrier) {
    throw new Error(`Dropanas devolvió una guía de ${guideCarrier} para un pedido de ${wantedCarrier}`);
  }

  const contentType = headerValue(response.headers, 'content-type');
  if (!contentType.includes('application/pdf')) {
    throw new Error(`Dropanas devolvió ${contentType || 'un formato desconocido'} en vez de la etiqueta PDF`);
  }
  const pdf = Buffer.from(response.data);
  if (pdf.length > MAX_PDF_BYTES) throw new Error('La etiqueta PDF excede el límite de 5 MB');
  const rendered = await renderVerifiedPdf(pdf, expectedTracking);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filename = `guia-${crypto.randomUUID()}.png`;
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), rendered.png, { flag: 'wx' });
  return {
    filename: `guias/${filename}`,
    pages: rendered.pages,
    bytes: rendered.png.length,
    carrier: guideCarrier || null,
    origin: guideOrigin || null,
    mode: responseMode,
    phone: rendered.phone,
    client: rendered.client,
  };
}

module.exports = { OUTPUT_DIR, configFromEnv, status, extractLabelMetadata, renderVerifiedPdf, capture };

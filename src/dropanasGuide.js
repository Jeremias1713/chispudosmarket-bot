'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { MEDIA_DIR } = require('./library');

const BASE_URL = 'https://app.dropanas.com';
const LOGIN_URL = `${BASE_URL}/login`;
const ORDERS_URL = `${BASE_URL}/orders`;
const OUTPUT_DIR = path.join(MEDIA_DIR, 'guias');
const MAX_PDF_BYTES = 5 * 1024 * 1024;

let authenticatedClient = null;
let authenticationPromise = null;

function bool(value) {
  return String(value || '').toLowerCase() === 'true';
}

function configFromEnv(env = process.env) {
  return {
    enabled: bool(env.DROPANAS_GUIDE_ENABLED),
    email: String(env.DROPANAS_GUIDE_EMAIL || '').trim(),
    password: String(env.DROPANAS_GUIDE_PASSWORD || ''),
    timeoutMs: Math.max(3000, Number(env.DROPANAS_GUIDE_TIMEOUT_MS || 30000)),
  };
}

function status() {
  const config = configFromEnv();
  const configured = Boolean(config.email && config.password);
  return { enabled: config.enabled && configured, configured, authenticated: Boolean(authenticatedClient) };
}

function assertEnabled(config) {
  if (!config.enabled || !config.email || !config.password) {
    throw new Error('Descarga de etiquetas bloqueada: configura DROPANAS_GUIDE_ENABLED=true, DROPANAS_GUIDE_EMAIL y DROPANAS_GUIDE_PASSWORD en Render');
  }
}

function extractCsrf(html) {
  const input = String(html || '').match(/<input\b[^>]*\bname=["']_token["'][^>]*>/i)
    || String(html || '').match(/<input\b[^>]*\bvalue=["'][^"']+["'][^>]*\bname=["']_token["'][^>]*>/i);
  const value = input?.[0]?.match(/\bvalue=["']([^"']+)["']/i)?.[1];
  if (!value) throw new Error('Dropanas cambió el formulario de acceso: no se encontró el token CSRF');
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function finalUrl(response) {
  return String(response?.request?.res?.responseUrl || response?.config?.url || '');
}

function makeClient(config) {
  return wrapper(axios.create({
    jar: new CookieJar(),
    withCredentials: true,
    timeout: config.timeoutMs,
    maxRedirects: 5,
    maxContentLength: MAX_PDF_BYTES,
    maxBodyLength: MAX_PDF_BYTES,
    headers: { 'User-Agent': 'ChispudosMarketBot/1.0', Accept: 'text/html,application/pdf' },
  }));
}

async function authenticate(options = {}) {
  const config = options.config || configFromEnv();
  assertEnabled(config);
  if (authenticatedClient) return authenticatedClient;
  if (authenticationPromise) return authenticationPromise;

  authenticationPromise = (async () => {
    const client = options.client || makeClient(config);
    const loginPage = await client.get(LOGIN_URL);
    const csrf = extractCsrf(loginPage.data);
    const body = new URLSearchParams({ _token: csrf, email: config.email, password: config.password });
    const response = await client.post(LOGIN_URL, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BASE_URL,
        Referer: LOGIN_URL,
      },
    });
    const url = finalUrl(response);
    if (/\/login(?:$|[?#])/.test(url) || /name=["']password["']/i.test(String(response.data || ''))) {
      throw new Error('Dropanas rechazó el acceso para descargar etiquetas');
    }
    const orders = await client.get(ORDERS_URL);
    if (/\/login(?:$|[?#])/.test(finalUrl(orders))) throw new Error('La sesión web de Dropanas no quedó autenticada');
    authenticatedClient = client;
    return client;
  })();

  try {
    return await authenticationPromise;
  } finally {
    authenticationPromise = null;
  }
}

function compactTracking(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
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
  return { png, pages };
}

async function capture({ orderId, expectedTracking, config, client } = {}) {
  if (!/^\d+$/.test(String(orderId || ''))) throw new Error('ID de pedido Dropanas inválido');
  if (!compactTracking(expectedTracking)) throw new Error('Número de guía Dropanas inválido');
  const activeClient = client || await authenticate({ config });
  let response = await activeClient.get(`${BASE_URL}/pedido/tracking-tealca-oficial/${orderId}`, {
    responseType: 'arraybuffer',
    headers: { Accept: 'application/pdf' },
  });
  if (/\/login(?:$|[?#])/.test(finalUrl(response))) {
    authenticatedClient = null;
    response = await (await authenticate({ config })).get(`${BASE_URL}/pedido/tracking-tealca-oficial/${orderId}`, {
      responseType: 'arraybuffer',
      headers: { Accept: 'application/pdf' },
    });
  }
  const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
  if (!contentType.includes('pdf')) throw new Error(`Dropanas devolvió ${contentType || 'un formato desconocido'} en vez de la etiqueta PDF`);
  const pdf = Buffer.from(response.data);
  if (pdf.length > MAX_PDF_BYTES) throw new Error('La etiqueta PDF excede el límite de 5 MB');
  const rendered = await renderVerifiedPdf(pdf, expectedTracking);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filename = `guia-${crypto.randomUUID()}.png`;
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), rendered.png, { flag: 'wx' });
  return { filename: `guias/${filename}`, pages: rendered.pages, bytes: rendered.png.length };
}

function resetSessionForTests() {
  authenticatedClient = null;
  authenticationPromise = null;
}

module.exports = {
  BASE_URL,
  LOGIN_URL,
  ORDERS_URL,
  OUTPUT_DIR,
  configFromEnv,
  status,
  extractCsrf,
  authenticate,
  renderVerifiedPdf,
  capture,
  resetSessionForTests,
};

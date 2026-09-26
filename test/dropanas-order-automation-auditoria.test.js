'use strict';
// Pruebas de los arreglos de la auditoría de subida de pedidos a DroPanas
// (23-sep-2026). Todo usa datos simulados: axios se reemplaza por respuestas
// falsas y los datos viven en una carpeta temporal. Nunca se llama a
// DroPanas ni a WhatsApp de verdad.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-order-auditoria');
const fs = require('node:fs');
const path = require('node:path');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'agencies.csv'), path.join(dataDir, 'agencies.csv'));
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const automation = require('../src/dropanasOrderAutomation');
const state = require('../src/state');

const originalGet = axios.get;
const originalPost = axios.post;
after(() => {
  axios.get = originalGet;
  axios.post = originalPost;
  cleanup(dataDir);
});

const PHONE = '584227167341';
const SOLD_AT = '2026-09-20T12:00:00.000Z';

function soldSession(overrides = {}) {
  return {
    name: 'Jorge Luis Carbajal', stage: 'vendido', orderClosed: true, soldAt: SOLD_AT,
    card: { nombre: 'Jorge Luis Carbajal', cedula: '26448320', telefono: '04227167341', producto: 'Shilajit Viking', agencia: 'TURMERO' },
    currentOrder: { product: 'Shilajit Viking', quantity: 2, total: 51900, agency: 'TURMERO' },
    ...overrides,
  };
}

let posts = [];
let postResponse = null;
let geoCalls = 0;
let geoFails = true;

function okHeaders() {
  return { 'x-dropanas-mode': 'live' };
}

function installFakeApi({ officesBlocked = false } = {}) {
  axios.get = async (url) => {
    if (url.endsWith('/oficinas')) {
      if (officesBlocked) throw Object.assign(new Error('403'), { response: { status: 403, data: {} } });
      return { headers: okHeaders(), data: { data: [{ id: 9, nombre: 'Turmero', direccion: 'Av. Principal', state_id: 1, city_id: 2 }] } };
    }
    if (url.includes('/geo/estados')) {
      geoCalls += 1;
      if (geoFails) throw Object.assign(new Error('403'), { response: { status: 403, data: {} } });
      if (url.endsWith('/geo/estados')) return { headers: okHeaders(), data: { data: [{ id: 5, nombre: 'Aragua' }] } };
      return { headers: okHeaders(), data: { data: [{ id: 50, nombre: 'Dr. Montoya' }] } };
    }
    if (url.includes('/productos/')) return { headers: okHeaders(), data: { data: { id: Number(url.split('/').pop()) } } };
    if (url.includes('/inventario')) {
      return { headers: okHeaders(), data: { data: [20343, 20448, 20702].map((id) => ({ producto: { id }, cantidad: 50 })) } };
    }
    throw new Error(`URL inesperada en la prueba: ${url}`);
  };
  axios.post = async (url, body, options) => {
    posts.push({ url, body, key: options.headers['Idempotency-Key'] });
    if (postResponse instanceof Error) throw postResponse;
    return postResponse;
  };
}

function enableUpload({ auto = false } = {}) {
  process.env.DROPANAS_API_ENABLED = 'true';
  process.env.DROPANAS_API_READ_ONLY_ACK = 'true';
  process.env.DROPANAS_API_TOKEN = 'live_sk_prueba';
  // Guardar la configuración también limpia los cachés del módulo.
  automation.saveConfig({ uploadEnabled: true, autoCreateEnabled: auto, mappings: automation.defaultMappings() });
}

beforeEach(() => {
  posts = [];
  geoCalls = 0;
  geoFails = true;
  postResponse = { headers: okHeaders(), data: { data: { id: 777, estado_aprobacion: 'pendiente_aprobacion' } } };
  installFakeApi();
  enableUpload();
  // Sin copia guardada de oficinas: cada prueba decide si DroPanas responde.
  fs.rmSync(path.join(dataDir, 'dropanas-oficinas.json'), { force: true });
  automation.resetOfficeCache();
});

// ---------- 1. ventas que ya existen en DroPanas ----------

test('no ofrece subir una venta que ya tiene guía', () => {
  const draft = automation.baseDraft(PHONE, soldSession({ card: { ...soldSession().card, guia: '123456' } }));
  assert.ok(draft.issues.some((issue) => issue.includes('ya tiene guía')));
});

test('una venta en etapa de despacho sin guía no se bloquea (la IA salta ahí sola) pero avisa', () => {
  for (const stage of ['esperando_retiro', 'en_camino', 'entregado', 'novedad', 'pendiente_devolucion', 'tienda_maracaibo']) {
    const draft = automation.baseDraft(PHONE, soldSession({ stage }));
    assert.deepEqual(draft.issues, [], stage);
    assert.ok(draft.attemptNotes.some((note) => note.includes('NO la subas de nuevo')), stage);
  }
  assert.deepEqual(automation.baseDraft(PHONE, soldSession({ stage: 'esperando_guia' })).attemptNotes, []);
});

// ---------- 2. respuesta OK de DroPanas siempre guarda el número ----------

test('si DroPanas crea la orden con otro estado, el número se guarda igual y no se puede volver a subir', async () => {
  const phone = '584120000002';
  state.updateSession(phone, soldSession({ card: { ...soldSession().card, telefono: '04120000002' } }));
  postResponse = { headers: okHeaders(), data: { data: { id: 888, estado_aprobacion: 'aprobada' } } };
  const result = await automation.createForPhone(phone);
  assert.equal(result.order.id, 888);
  assert.match(result.warning, /aprobada/);
  const stored = state.getSession(phone).dropanasOrder;
  assert.equal(stored.id, 888);
  assert.equal(stored.status, 'aprobada');
  const again = await automation.prepareDraft(phone);
  assert.ok(again.issues.some((issue) => issue.includes('#888')));
  assert.ok(again.warnings.some((warning) => warning.includes('aprobada')));
});

test('si DroPanas responde en otro modo pero con número, el número se guarda con aviso', async () => {
  const phone = '584120000003';
  state.updateSession(phone, soldSession({ card: { ...soldSession().card, telefono: '04120000003' } }));
  postResponse = { headers: { 'x-dropanas-mode': '' }, data: { data: { id: 889, estado_aprobacion: 'pendiente_aprobacion' } } };
  const result = await automation.createForPhone(phone);
  assert.equal(state.getSession(phone).dropanasOrder.id, 889);
  assert.match(result.warning, /modo/);
});

test('una respuesta OK sin número queda marcada como "pudo haberse enviado"', async () => {
  const phone = '584120000004';
  state.updateSession(phone, soldSession({ card: { ...soldSession().card, telefono: '04120000004' } }));
  postResponse = { headers: okHeaders(), data: { data: {} } };
  await assert.rejects(automation.createForPhone(phone), /sin número/);
  const stored = state.getSession(phone).dropanasOrder;
  assert.equal(stored.status, 'error');
  assert.equal(stored.requestMaybeSent, true);
  const draft = await automation.prepareDraft(phone);
  assert.ok(draft.warnings.some((warning) => warning.includes('Revisa en DroPanas')));
});

// ---------- 3. una compra nueva no reutiliza la clave de la vieja ----------

test('una compra nueva usa su propia referencia y clave, y guarda la anterior en el historial', async () => {
  const phone = '584120000005';
  state.updateSession(phone, soldSession({ card: { ...soldSession().card, telefono: '04120000005' } }));
  postResponse = { headers: okHeaders(), data: { data: { id: 901, estado_aprobacion: 'pendiente_aprobacion' } } };
  await automation.createForPhone(phone);
  const firstKey = posts[0].key;
  const firstRef = posts[0].body.external_reference;

  // Nueva venta del mismo cliente: nueva fecha de cierre.
  state.updateSession(phone, { soldAt: '2026-10-01T10:00:00.000Z' });
  const draft = automation.baseDraft(phone, state.getSession(phone));
  assert.equal(draft.current, null);
  assert.equal(draft.previous.id, 901);
  assert.deepEqual(draft.issues, []);

  postResponse = { headers: okHeaders(), data: { data: { id: 902, estado_aprobacion: 'pendiente_aprobacion' } } };
  await automation.createForPhone(phone);
  assert.notEqual(posts[1].key, firstKey);
  assert.notEqual(posts[1].body.external_reference, firstRef);
  const session = state.getSession(phone);
  assert.equal(session.dropanasOrder.id, 902);
  assert.equal(session.dropanasOrderHistory.at(-1).id, 901);
});

test('un intento fallido de una venta vieja no presta su clave a la venta nueva', async () => {
  const phone = '584120000006';
  state.updateSession(phone, soldSession({ card: { ...soldSession().card, telefono: '04120000006' } }));
  postResponse = Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' });
  await assert.rejects(automation.createForPhone(phone));
  const oldKey = posts[0].key;
  state.updateSession(phone, { soldAt: '2026-10-02T10:00:00.000Z' });
  postResponse = { headers: okHeaders(), data: { data: { id: 903, estado_aprobacion: 'pendiente_aprobacion' } } };
  await automation.createForPhone(phone);
  assert.notEqual(posts[1].key, oldKey);
});

test('reintentar la MISMA venta manda exactamente la misma clave', async () => {
  const phone = '584120000007';
  state.updateSession(phone, soldSession({ card: { ...soldSession().card, telefono: '04120000007' } }));
  postResponse = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
  await assert.rejects(automation.createForPhone(phone));
  postResponse = { headers: okHeaders(), data: { data: { id: 904, estado_aprobacion: 'pendiente_aprobacion' } } };
  await automation.createForPhone(phone);
  assert.equal(posts[0].key, posts[1].key);
});

// ---------- 4. combos escritos en una sola línea ----------

test('un combo escrito en texto libre se bloquea en vez de subirse como un solo producto', () => {
  const draft = automation.baseDraft(PHONE, soldSession({
    currentOrder: { product: 'Turkesterone + Shilajit Viking', quantity: 2, total: 76800, agency: 'TURMERO' },
  }));
  assert.ok(draft.issues.some((issue) => issue.includes('combo')));
});

test('"Shilajit de resina" no se confunde con un combo de Shilajit Viking', () => {
  const pool = automation.matchableMappings();
  assert.equal(automation.mentionedProducts('Shilajit resina', pool).length, 1);
  assert.equal(automation.mentionedProducts('2 frascos de Shilajit Viking', pool).length, 1);
  assert.equal(automation.mentionedProducts('Turkesterone y shilajit', pool).length, 2);
});

// ---------- 5. monto acordado vs. precio de la tabla ----------

test('si el monto de la ficha no coincide con el precio que se cobraría, no se sube', () => {
  const draft = automation.baseDraft(PHONE, soldSession({
    currentOrder: null,
    card: { ...soldSession().card, monto: 45000, productos: [{ nombre: 'Shilajit Viking', cantidad: 2 }] },
  }));
  assert.equal(draft.total, 51900);
  assert.ok(draft.issues.some((issue) => issue.includes('no coincide')));
});

test('si el monto de la ficha coincide, no molesta', () => {
  const draft = automation.baseDraft(PHONE, soldSession({
    currentOrder: null,
    card: { ...soldSession().card, monto: 51900, productos: [{ nombre: 'Shilajit Viking', cantidad: 2 }] },
  }));
  assert.deepEqual(draft.issues, []);
});

// ---------- 7. un error de "geo" no queda guardado ----------

test('un 403 de geo no queda guardado: cuando DroPanas habilite el permiso, funciona sin reiniciar', async () => {
  installFakeApi({ officesBlocked: true });
  automation.saveConfig({ uploadEnabled: true, autoCreateEnabled: false, mappings: automation.defaultMappings() });
  const phone = '584120000008';
  state.updateSession(phone, soldSession({ card: { ...soldSession().card, telefono: '04120000008' } }));
  await automation.prepareDraft(phone);
  await automation.prepareDraft(phone);
  assert.equal(geoCalls, 2, 'cada borrador vuelve a consultar mientras siga fallando');
  geoFails = false;
  const draft = await automation.prepareDraft(phone);
  assert.ok(!draft.issues.some((issue) => issue.includes('bloqueó la consulta')), draft.issues.join(' | '));
});

// ---------- 8. intentos anteriores visibles ----------

test('un intento anterior fallido se muestra como aviso en la bandeja', async () => {
  const phone = '584120000009';
  state.updateSession(phone, soldSession({
    card: { ...soldSession().card, telefono: '04120000009' },
    dropanasOrder: { status: 'error', error: 'timeout', requestMaybeSent: true, externalReference: automation.externalReference({ phone, soldAt: SOLD_AT }) },
  }));
  const draft = await automation.prepareDraft(phone);
  assert.ok(draft.warnings.some((warning) => warning.includes('Revisa en DroPanas')));
});

test('un intento que se está subiendo ahora mismo bloquea un segundo clic', () => {
  const draft = automation.baseDraft(PHONE, soldSession({
    dropanasOrder: { status: 'subiendo', attemptedAt: new Date().toISOString(), externalReference: automation.externalReference({ phone: PHONE, soldAt: SOLD_AT }) },
  }));
  assert.ok(draft.issues.some((issue) => issue.includes('subiendo en este momento')));
});

// ---------- 9. reintento automático ----------

test('el modo automático reintenta cuando el dato que faltaba ya está, y no reintenta envíos dudosos', async () => {
  enableUpload({ auto: true });
  const phone = '584120000010';
  // Venta cerrada después de activar el modo automático, pero sin cédula.
  state.updateSession(phone, soldSession({ soldAt: new Date(Date.now() + 1000).toISOString(), card: { ...soldSession().card, telefono: '04120000010', cedula: null } }));
  await assert.rejects(automation.createForPhone(phone, { automatic: true }), /cédula/);
  assert.equal(state.getSession(phone).dropanasOrder.autoAttempts, 1);
  assert.equal(posts.length, 0);

  // Todavía falta la cédula: no se reintenta.
  let result = await automation.retryAutomatic();
  assert.equal(result.results.filter((row) => row.phone === phone).length, 0);

  // El cliente manda la cédula: se reintenta solo.
  state.updateSession(phone, { card: { ...state.getSession(phone).card, cedula: '26448320' } });
  postResponse = { headers: okHeaders(), data: { data: { id: 950, estado_aprobacion: 'pendiente_aprobacion' } } };
  result = await automation.retryAutomatic();
  assert.equal(result.results.find((row) => row.phone === phone).order.id, 950);

  // Un envío que pudo haber llegado a DroPanas nunca se reintenta solo.
  const other = '584120000011';
  state.updateSession(other, soldSession({ soldAt: new Date(Date.now() + 1000).toISOString(), card: { ...soldSession().card, telefono: '04120000011' } }));
  postResponse = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
  await assert.rejects(automation.createForPhone(other, { automatic: true }));
  const before = posts.length;
  await automation.retryAutomatic();
  assert.equal(posts.length, before);
});

test('el reintento automático se detiene después del máximo de intentos', async () => {
  enableUpload({ auto: true });
  installFakeApi({ officesBlocked: true }); // la oficina no se puede validar: falla siempre
  const phone = '584120000012';
  state.updateSession(phone, soldSession({ soldAt: new Date(Date.now() + 1000).toISOString(), card: { ...soldSession().card, telefono: '04120000012' } }));
  await assert.rejects(automation.createForPhone(phone, { automatic: true }));
  for (let i = 0; i < automation.AUTO_RETRY_MAX + 3; i += 1) await automation.retryAutomatic();
  assert.equal(state.getSession(phone).dropanasOrder.autoAttempts, automation.AUTO_RETRY_MAX);
});

// ---------- 10–12. montos y documento ----------

test('el precio por unidad se redondea a céntimos y un total que no se reparte parejo se bloquea', () => {
  const uneven = automation.baseDraft(PHONE, soldSession({ currentOrder: { product: 'Shilajit Viking', quantity: 3, total: 100000, agency: 'TURMERO' } }));
  assert.ok(uneven.issues.some((issue) => issue.includes('partes iguales')));
  const draft = automation.baseDraft(PHONE, soldSession());
  draft.official = { office: { id: 9, state_id: 1, city_id: 2, nombre: 'Turmero' } };
  assert.equal(automation.buildPayload(draft, 'R').productos[0].precio_venta_ves, 25950);
});

test('un monto escrito con punto de miles (51.900 → 51,9) se bloquea', () => {
  const draft = automation.baseDraft(PHONE, soldSession({ currentOrder: { product: 'Shilajit Viking', quantity: 2, total: 51.9, agency: 'TURMERO' } }));
  assert.ok(draft.issues.some((issue) => issue.includes('demasiado bajo')));
});

test('la cédula E- se envía como E y un prefijo raro se bloquea', () => {
  assert.equal(automation.documentType('26448320'), 'V');
  assert.equal(automation.documentType('V-26.448.320'), 'V');
  assert.equal(automation.documentType('e 84123456'), 'E');
  assert.equal(automation.documentType('J-12345678'), null);
  const draft = automation.baseDraft(PHONE, soldSession({ card: { ...soldSession().card, cedula: 'E-84123456' } }));
  draft.official = { office: { id: 9, state_id: 1, city_id: 2, nombre: 'Turmero' } };
  assert.equal(automation.buildPayload(draft, 'R').cliente.documento.tipo, 'E');
  const bad = automation.baseDraft(PHONE, soldSession({ card: { ...soldSession().card, cedula: 'J-12345678' } }));
  assert.ok(bad.issues.some((issue) => issue.includes('prefijo')));
});

// ---------- 15. conversaciones fantasma ----------

test('subir un teléfono que no existe no crea una conversación vacía', async () => {
  await assert.rejects(automation.createForPhone('999'), /No existe una conversación/);
  assert.equal(state.listSessions().some((session) => session.phone === '999'), false);
});

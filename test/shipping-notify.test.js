// Avisos automaticos de logistica (shipping.js): el aviso de DESPACHO
// (maybeNotifyShipping, etapa en_camino) y el aviso de LLEGADA
// (maybeNotifyArrival, etapa esperando_retiro) tienen que ser mensajes
// DISTINTOS, cada uno con su propia marca de "ya avisado" para no
// duplicarse ni mezclarse (Hallazgo 4 del reporte). Ademas, un envio que
// falla nunca puede quedar registrado como si se hubiera avisado con exito.
'use strict';
const { setupTempDataDir, writeJson, readJson, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('shipping-notify');
const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const metaTemplates = require('../src/metaTemplates');
const whatsapp = require('../src/whatsapp');
const { updateSettings } = require('../src/settings');
const shipping = require('../src/shipping');

after(() => cleanup(dataDir));

const PLANTILLA_GUIA = {
  name: 'guia_del_pedido',
  language: 'es',
  status: 'APPROVED',
  components: [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Hola {{1}}, tu pedido de {{2}} (guia {{3}}) ya salio hacia {{4}}. A pagar: {{5}}.' },
  ],
};
const PLANTILLA_LLEGADA = {
  name: 'pedido_ha_llegado_a_tealca',
  language: 'es',
  status: 'APPROVED',
  components: [
    { type: 'BODY', text: 'Hola {{1}}, tu pedido de {{2}} (guia {{3}}) ya llego y esta listo para retirar. A pagar: {{4}}.' },
  ],
};

let sendTemplateOriginal;
beforeEach(() => {
  metaTemplates._setCacheForTests([PLANTILLA_GUIA, PLANTILLA_LLEGADA]);
  sendTemplateOriginal = whatsapp.sendTemplate;
  updateSettings({ shippingTemplateName: 'guia_del_pedido', pickupTemplateName: 'pedido_ha_llegado_a_tealca' });
});
afterEach(() => {
  whatsapp.sendTemplate = sendTemplateOriginal;
  metaTemplates._setCacheForTests([]);
});

const { getSession } = require('../src/state');

// Escribe la sesion DIRECTO en sessions.json (no solo en memoria): las
// funciones de shipping.js terminan llamando a updateSession, que fusiona el
// patch sobre lo que ya haya persistido en disco para ese telefono -- si
// nunca se escribio nada ahi, updateSession fusiona sobre una sesion en
// blanco y se pierde el card.guia que le pasamos en memoria. Devuelve el
// telefono para encadenar getSession(phone) despues.
let contadorTelefono = 20;
function seedSesionCerrada(overrides) {
  const phone = `58412000${contadorTelefono++}`;
  let existing = {};
  try { existing = readJson(dataDir, 'sessions.json'); } catch (err) { existing = {}; }
  writeJson(dataDir, 'sessions.json', {
    ...existing,
    [phone]: {
      step: 'IDLE', cart: [], history: [], name: 'Carlos', stage: 'vendido', stageLocked: false,
      stageReason: null, paused: false, pausedReason: null,
      card: { nombre: 'Carlos', producto: 'Shilajit', guia: 'GU-100', agencia: 'Tealca Centro', monto: 38900, guiaImageUrl: 'https://cdn.example.com/g.jpg' },
      adCode: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    },
  });
  return phone;
}

test('maybeNotifyShipping (despacho) manda la plantilla de guia y marca shippingNotifiedAt, nunca arrivalNotifiedAt', async () => {
  whatsapp.sendTemplate = async () => ({ wamid: 'wamid.DESPACHO-1' });
  const phone = seedSesionCerrada();
  const result = await shipping.maybeNotifyShipping(phone, getSession(phone));

  assert.equal(result.sent, true);
  assert.equal(result.viaTemplate, true);
  const updated = getSession(phone);
  assert.ok(updated.shippingNotifiedAt);
  assert.ok(!updated.arrivalNotifiedAt);
});

test('maybeNotifyArrival (llegada) manda una plantilla DISTINTA a la de despacho', async () => {
  const nombresUsados = [];
  whatsapp.sendTemplate = async (to, templateName) => {
    nombresUsados.push(templateName);
    return { wamid: 'wamid.LLEGADA-1' };
  };
  const phone = seedSesionCerrada();
  const result = await shipping.maybeNotifyArrival(phone, getSession(phone));

  assert.equal(result.sent, true);
  assert.deepEqual(nombresUsados, ['pedido_ha_llegado_a_tealca']);
});

test('el despacho y la llegada usan marcas separadas: avisar uno no marca el otro como avisado', async () => {
  whatsapp.sendTemplate = async () => ({ wamid: 'wamid.X' });

  const phone = seedSesionCerrada();
  await shipping.maybeNotifyShipping(phone, getSession(phone));
  const updated = getSession(phone);
  assert.ok(updated.shippingNotifiedAt, 'debe quedar marcado el aviso de despacho');
  assert.ok(!updated.arrivalNotifiedAt, 'el aviso de llegada NO debe quedar marcado solo por avisar el despacho');

  // Ahora, sobre esa misma sesion ya avisada de despacho, avisar la llegada
  // tiene que poder mandarse igual (no esta bloqueada por shippingNotifiedAt).
  const resultLlegada = await shipping.maybeNotifyArrival(phone, updated);
  assert.equal(resultLlegada.sent, true, 'el aviso de llegada no debe quedar bloqueado por el de despacho, son eventos distintos');
});

test('repetir el mismo aviso no lo duplica (queda registrado como "ya_avisado")', async () => {
  let vecesLlamado = 0;
  whatsapp.sendTemplate = async () => { vecesLlamado++; return { wamid: 'wamid.DUP' }; };

  const phone = seedSesionCerrada();
  await shipping.maybeNotifyShipping(phone, getSession(phone));
  const primero = getSession(phone);
  assert.equal(vecesLlamado, 1);

  const segundo = await shipping.maybeNotifyShipping(phone, primero);
  assert.equal(segundo.sent, false);
  assert.equal(segundo.reason, 'ya_avisado');
  assert.equal(vecesLlamado, 1, 'no debe volver a llamar a WhatsApp si ya se habia avisado con exito');
});

test('lo mismo aplica al aviso de llegada: repetirlo no lo duplica', async () => {
  let vecesLlamado = 0;
  whatsapp.sendTemplate = async () => { vecesLlamado++; return { wamid: 'wamid.DUP2' }; };

  const phone = seedSesionCerrada();
  await shipping.maybeNotifyArrival(phone, getSession(phone));
  const primero = getSession(phone);
  assert.equal(vecesLlamado, 1);

  const segundo = await shipping.maybeNotifyArrival(phone, primero);
  assert.equal(segundo.sent, false);
  assert.equal(segundo.reason, 'ya_avisado');
  assert.equal(vecesLlamado, 1);
});

test('un fallo de envio (Meta rechaza la plantilla) NO queda registrado como notificacion exitosa', async () => {
  whatsapp.sendTemplate = async () => {
    const err = new Error('Request failed with status code 400');
    err.response = { data: { error: { message: 'Param required' } } };
    throw err;
  };

  const phone = seedSesionCerrada();
  const result = await shipping.maybeNotifyShipping(phone, getSession(phone));

  assert.equal(result.sent, false);
  assert.equal(result.reason, 'error');
  const updated = getSession(phone);
  assert.ok(!updated.shippingNotifiedAt, 'BUG si esto quedo marcado: un envio fallido no debe registrarse como avisado');
});

test('lo mismo para el aviso de llegada: un fallo no marca arrivalNotifiedAt', async () => {
  whatsapp.sendTemplate = async () => { throw new Error('network error'); };

  const phone = seedSesionCerrada();
  const result = await shipping.maybeNotifyArrival(phone, getSession(phone));

  assert.equal(result.sent, false);
  const updated = getSession(phone);
  assert.ok(!updated.arrivalNotifiedAt, 'BUG si esto quedo marcado: un envio fallido no debe registrarse como avisado');
});

test('entregado, novedad y pendiente de devolución usan plantillas de dos variables y marcas separadas', async () => {
  const calls = [];
  whatsapp.sendTemplate = async (to, name, language, values) => {
    calls.push({ to, name, language, values });
    return { wamid: `wamid.${name}` };
  };
  metaTemplates._setCacheForTests([
    ...[PLANTILLA_GUIA, PLANTILLA_LLEGADA],
    ...['pedido_entregado_gracias', 'novedad_no_contactado', 'pedido_pendiente_devolucion'].map((name) => ({
      name, language: 'es', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hola {{1}}, pedido {{2}}.' }],
    })),
  ]);
  const phone = seedSesionCerrada();
  await shipping.maybeNotifyDelivered(phone, getSession(phone));
  await shipping.maybeNotifyNovelty(phone, getSession(phone));
  await shipping.maybeNotifyReturnPending(phone, getSession(phone));

  assert.deepEqual(calls.map((call) => call.name), [
    'pedido_entregado_gracias', 'novedad_no_contactado', 'pedido_pendiente_devolucion',
  ]);
  assert.ok(calls.every((call) => call.values.length === 2));
  const updated = getSession(phone);
  assert.ok(updated.deliveredNotifiedAt && updated.noveltyNotifiedAt && updated.returnPendingNotifiedAt);
});

test('entregado: si el cliente escribio en las ultimas 24h va como mensaje normal, sin plantilla', async () => {
  const plantillas = [];
  const textos = [];
  whatsapp.sendTemplate = async (to, name) => { plantillas.push(name); return { wamid: 'wamid.T' }; };
  const flow = require('../src/flow');
  const sendRawReplyOriginal = flow.sendRawReply;
  flow.sendRawReply = async (to, text) => { textos.push(text); };
  try {
    const phone = seedSesionCerrada({
      stage: 'esperando_retiro',
      history: [{ role: 'user', content: 'ya lo busque', at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }],
    });
    const result = await shipping.maybeNotifyDelivered(phone, getSession(phone));
    assert.equal(result.sent, true);
    assert.equal(result.viaTemplate, false);
    assert.deepEqual(plantillas, []);
    assert.equal(textos.length >= 1, true);
    assert.match(textos[0], /Carlos/);
    assert.match(textos[0], /Shilajit/);
    assert.ok(getSession(phone).deliveredNotifiedAt);
  } finally {
    flow.sendRawReply = sendRawReplyOriginal;
  }
});

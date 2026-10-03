// Integracion de la guardia de envios automaticos: avisos logisticos con
// "marcar antes de enviar", opt-out por webhook, 131050 y envios masivos.
'use strict';
const { setupTempDataDir, writeJson, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('guardia-integracion');
process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
process.env.WHATSAPP_TOKEN = 'x';

const { test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const metaTemplates = require('../src/metaTemplates');
const whatsapp = require('../src/whatsapp');
const { updateSettings } = require('../src/settings');
const state = require('../src/state');
const shipping = require('../src/shipping');
const broadcasts = require('../src/broadcasts');
const personalized = require('../src/personalizedBroadcast');
const { app } = require('../src/server');

after(() => { cleanup(dataDir); setTimeout(() => process.exit(0), 50).unref(); });

const LLEGADA = { name: 'pedido_ha_llegado_a_tealca', language: 'es', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hola {{1}} {{2}} {{3}} {{4}}' }] };
let original;
beforeEach(() => {
  metaTemplates._setCacheForTests([LLEGADA]);
  original = whatsapp.sendTemplate;
  updateSettings({ pickupTemplateName: 'pedido_ha_llegado_a_tealca', qualityGuardActive: false });
});
afterEach(() => { whatsapp.sendTemplate = original; metaTemplates._setCacheForTests([]); });

function seed(phone, extra = {}) {
  let existing = {};
  try { existing = state.listSessions().reduce((a, s) => ({ ...a, [s.phone]: s }), {}); } catch (e) { /* vacio */ }
  writeJson(dataDir, 'sessions.json', { ...existing, [phone]: {
    step: 'IDLE', cart: [], history: [], name: 'Carlos', stage: 'en_camino', paused: false,
    card: { nombre: 'Carlos', producto: 'Shilajit', guia: 'GU-1', agencia: 'Tealca', monto: 1000 },
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', ...extra,
  } });
  return phone;
}

test('aviso de llegada: la marca queda ANTES de enviar (se ve durante el envio)', async () => {
  const phone = seed('584120009001');
  let markerDuringSend = null;
  whatsapp.sendTemplate = async () => { markerDuringSend = state.getSession(phone).arrivalNotifiedAt; return { wamid: 'w1' }; };
  const r = await shipping.maybeNotifyArrival(phone, state.getSession(phone));
  assert.equal(r.sent, true);
  assert.ok(markerDuringSend, 'la marca ya estaba guardada cuando salio el mensaje');
});

test('aviso de llegada: si el envio falla, se quita la marca y se anota el fallo', async () => {
  const phone = seed('584120009002');
  whatsapp.sendTemplate = async () => { throw new Error('Meta caido'); };
  const r = await shipping.maybeNotifyArrival(phone, state.getSession(phone));
  assert.equal(r.sent, false);
  const s = state.getSession(phone);
  assert.equal(s.arrivalNotifiedAt, null);
  assert.ok(s.arrivalNotifiedAtFailedAt);
});

test('aviso de llegada: si el guardado de la marca falla, NO se manda nada', async () => {
  const phone = seed('584120009003');
  let enviados = 0;
  whatsapp.sendTemplate = async () => { enviados += 1; return { wamid: 'w' }; };
  const real = state.updateSession;
  // shipping.js importo updateSession por desestructuracion: se prueba rompiendo el disco.
  const fs = require('node:fs');
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (p, ...rest) {
    if (String(p).endsWith('sessions.json.tmp')) { const e = new Error('no space'); e.code = 'EIO'; throw e; }
    return realWrite.call(fs, p, ...rest);
  };
  try {
    const r = await shipping.maybeNotifyArrival(phone, state.getSession(phone));
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'error_guardado');
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(enviados, 0);
  assert.equal(typeof real, 'function');
});

test('el opt-out NO frena el aviso de llegada (el cliente compro y necesita saber de su pedido)', async () => {
  const phone = seed('584120009004', { optOut: true });
  whatsapp.sendTemplate = async () => ({ wamid: 'w' });
  const r = await shipping.maybeNotifyArrival(phone, state.getSession(phone));
  assert.equal(r.sent, true);
});

test('masivo: salta opt-out y lo deja en resultados con su motivo', async () => {
  const a = seed('584120009010', { optOut: true });
  const b = seed('584120009011');
  const llamados = [];
  whatsapp.sendTemplate = async (to) => { llamados.push(to); return { wamid: 'w' }; };
  const run = await broadcasts.startRun({ templateName: 'pedido_ha_llegado_a_tealca', languageCode: 'es', params: ['a'], target: { scope: 'all' } });
  assert.ok(run.id);
  // esperar a que termine el run en segundo plano
  for (let i = 0; i < 100; i += 1) {
    const r = broadcasts.listRuns().find((x) => x.id === run.id);
    if (r && r.status === 'done') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  const final = broadcasts.listRuns().find((x) => x.id === run.id);
  assert.equal(final.status, 'done');
  const skipped = final.results.find((x) => x.phone === a);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'opt_out');
  assert.ok(llamados.includes(b));
  assert.ok(!llamados.includes(a));
});

test('masivo personalizado: omite opt-out con motivo', async () => {
  const a = seed('584120009020', { optOut: true });
  whatsapp.sendTemplate = async () => ({ wamid: 'w' });
  const results = await personalized.sendPersonalized({ templateName: 'pedido_ha_llegado_a_tealca', languageCode: 'es', order: ['nombre'], rows: [{ fila: 2, telefono: a, nombre: 'X' }] });
  assert.equal(results[0].skipped, true);
  assert.equal(results[0].reason, 'opt_out');
});

function webhook(body) {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/webhook' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return handler({ body, get: () => undefined, rawBody: Buffer.from(JSON.stringify(body)) }, { sendStatus() { return this; } });
}

test('status failed con codigo 131050 marca opt-out en el dueno del wamid', async () => {
  const phone = seed('584120009030');
  state.appendMessage(phone, 'human', '[plantilla]', { template: { name: 'x', wamid: 'wamid.131050', status: 'sent' } });
  await webhook({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.131050', status: 'failed', errors: [{ code: 131050, title: 'user stopped marketing' }] }] } }] }] });
  const s = state.getSession(phone);
  assert.equal(s.optOut, true);
  assert.equal(s.optOutSource, 'meta_131050');
});

test('webhook procesa TODOS los entry y changes, y los eventos de calidad', async () => {
  const p = seed('584120009040');
  state.appendMessage(p, 'human', '[plantilla]', { template: { name: 'x', wamid: 'wamid.E2', status: 'sent' } });
  await webhook({ entry: [
    { changes: [{ field: 'messages', value: { statuses: [{ id: 'nada', status: 'sent' }] } }] },
    { changes: [
      { field: 'messages', value: { statuses: [{ id: 'wamid.E2', status: 'delivered' }] } },
      { field: 'phone_number_quality_update', value: { event: 'DOWNGRADE', current_limit: 'TIER_1K' } },
      { field: 'message_template_quality_update', value: { message_template_name: 'guia_del_pedido', previous_quality_score: 'GREEN', new_quality_score: 'YELLOW' } },
      { field: 'message_template_status_update', value: { message_template_name: 'guia_del_pedido', event: 'PAUSED' } },
    ] },
  ] });
  const msgs = state.getSession(p).history;
  assert.equal(msgs[msgs.length - 1].template.status, 'delivered');
  const { getSettings } = require('../src/settings');
  const st = getSettings();
  assert.equal(st.qualityGuardActive, true);
  assert.equal(st.whatsappQuality.event, 'DOWNGRADE');
  assert.equal(st.templateQuality.guia_del_pedido.score, 'YELLOW');
  assert.equal(st.templateStatus.guia_del_pedido.event, 'PAUSED');
  updateSettings({ qualityGuardActive: false });
});

test('metaEvents: UPGRADE no apaga la guardia; mas de 10 fallos en el dia avisa una vez', () => {
  const ev = require('../src/metaEvents');
  const store = { qualityGuardActive: true };
  const pushes = [];
  const deps = {
    settings: { getSettings: () => store, updateSettings: (p) => Object.assign(store, p) },
    notifyAdmin: (t, b) => pushes.push([t, b]),
    now: () => new Date('2026-10-03T12:00:00Z'),
  };
  ev.handleAccountChange({ field: 'phone_number_quality_update', value: { event: 'UPGRADE' } }, deps);
  assert.equal(store.qualityGuardActive, true);
  ev.resetFailureCounter();
  for (let i = 0; i < 15; i += 1) ev.noteFailedStatus({ status: 'failed', errors: [{ code: 131049 }] }, deps);
  const fallos = pushes.filter(([t]) => /Fallos/.test(t));
  assert.equal(fallos.length, 1);
  assert.match(fallos[0][1], /131049/);
});

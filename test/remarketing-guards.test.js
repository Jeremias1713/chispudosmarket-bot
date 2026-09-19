// Punto 4 del pedido: demostrar (no solo describir) que los seguimientos
// automaticos de remarketing.js respetan orderClosed, las conversaciones
// pausadas, el rechazo del cliente (etapa "perdido"), y las fechas/promesas
// futuras ("escribir_mas_tarde") -- llamando de verdad a revisarUnaVez()
// contra sesiones fabricadas, con sendRawReply mockeado para poder contar
// cuantos envios de verdad se hicieron.
'use strict';
process.env.PANEL_USER = process.env.PANEL_USER || 'admin';
process.env.PANEL_PASS = process.env.PANEL_PASS || 'clave-de-prueba';
process.env.PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || 'secreto-de-prueba';

const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('remarketing-guards');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const catalogMod = require('../src/catalog');
const flowMod = require('../src/flow');
const { updateSettings } = require('../src/settings');
const { getSession } = require('../src/state');

// PRODUCTO fijo devuelto por findProduct para todas las sesiones de esta
// suite: alcanza con un objeto simple, remarketing.js solo lee estos campos.
const PRODUCTO_TEST = {
  id: 'p1',
  name: 'Shilajit',
  remarketingEnabled: true,
  remarketing2h: 'Che, seguis interesado en el Shilajit? Cualquier duda me escribis.',
  remarketing5h: 'Ultimo empujoncito: si todavia queres el Shilajit, avisame y te lo aparto.',
};
catalogMod.findProduct = () => PRODUCTO_TEST;

// sendRawReply mockeado ANTES de requerir remarketing.js: remarketing.js
// hace `const { sendRawReply } = require('./flow')` al cargarse, asi que si
// se pisa DESPUES la referencia vieja queda pegada (mismo caveat que anota
// flow-classifier-guard.test.js para whatsapp/ai/classifier).
const enviosHechos = [];
flowMod.sendRawReply = async (to, texto) => { enviosHechos.push({ to, texto }); };

const remarketing = require('../src/remarketing');

after(() => cleanup(dataDir));

// Activa remarketing "desde siempre" (una fecha bien vieja) para que las
// sesiones fabricadas de esta suite (con updatedAt tambien viejo, pero
// posterior a esta activacion) no queden excluidas por
// activatedAtMs/remarketingActivatedAt.
function activarRemarketingDesdeSiempre() {
  updateSettings({
    replyDelayMs: 5,
    remarketingEnabled: true,
    botEnabled: true,
    remarketingHourStart: 0,
    remarketingHourEnd: 24, // todo el dia habilitado, no depende de la hora real de la corrida
    remarketingActivatedAt: '2000-01-01T00:00:00.000Z',
  });
}

function haceHoras(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function sesionColgada(overrides) {
  return {
    step: 'IDLE', cart: [], history: [], name: 'Cliente',
    stage: 'interesado', stageLocked: false, stageReason: null,
    paused: false, pausedReason: null,
    card: {},
    linkedProductId: 'p1',
    adCode: null,
    createdAt: haceHoras(6),
    updatedAt: haceHoras(6), // 6 horas sin novedad: ya paso la marca de 5h
    ...overrides,
  };
}

test('una conversacion NO cerrada (colgada hace 6h) SI recibe el recordatorio de remarketing', async () => {
  activarRemarketingDesdeSiempre();
  const phone = '584130000001';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionColgada() }));
  enviosHechos.length = 0;

  await remarketing.revisarUnaVez();

  const enviado = enviosHechos.find((e) => e.to === phone);
  assert.ok(enviado, 'caso de control: sin ningun guardrail de por medio, el remarketing SI tiene que dispararse');
  const session = getSession(phone);
  assert.ok(session.remarketingSentAt5h, 'el flag de las 5h tiene que quedar guardado');
});

test('orderClosed=true bloquea el remarketing aunque la ETAPA no este en SOLD_STAGES (caso: operador fijo otra etapa a mano despues del cierre)', async () => {
  activarRemarketingDesdeSiempre();
  const phone = '584130000002';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionColgada({ stage: 'necesita_atencion', orderClosed: true }),
  }));
  enviosHechos.length = 0;

  await remarketing.revisarUnaVez();

  assert.equal(enviosHechos.find((e) => e.to === phone), undefined, 'BUG si se mando: orderClosed=true significa que ya es una venta cerrada, sin importar la etapa fijada a mano');
});

test('una etapa de SOLD_STAGES (ej. "entregado") tambien bloquea el remarketing', async () => {
  activarRemarketingDesdeSiempre();
  const phone = '584130000003';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionColgada({ stage: 'entregado' }),
  }));
  enviosHechos.length = 0;

  await remarketing.revisarUnaVez();

  assert.equal(enviosHechos.find((e) => e.to === phone), undefined);
});

test('rechazo explicito ("perdido") bloquea el remarketing', async () => {
  activarRemarketingDesdeSiempre();
  const phone = '584130000004';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionColgada({ stage: 'perdido' }),
  }));
  enviosHechos.length = 0;

  await remarketing.revisarUnaVez();

  assert.equal(enviosHechos.find((e) => e.to === phone), undefined);
});

test('"escribir_mas_tarde" (el cliente prometio una fecha futura) bloquea el remarketing automatico', async () => {
  activarRemarketingDesdeSiempre();
  const phone = '584130000005';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionColgada({ stage: 'escribir_mas_tarde' }),
  }));
  enviosHechos.length = 0;

  await remarketing.revisarUnaVez();

  assert.equal(
    enviosHechos.find((e) => e.to === phone),
    undefined,
    'BUG si se mando: el cliente ya dijo que iba a escribir/comprar mas adelante, no hay que insistirle con el recordatorio automatico'
  );
});

test('conversacion pausada (un humano la tomo desde el panel) bloquea el remarketing', async () => {
  activarRemarketingDesdeSiempre();
  const phone = '584130000006';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    [phone]: sesionColgada({ paused: true, pausedReason: 'manual' }),
  }));
  enviosHechos.length = 0;

  await remarketing.revisarUnaVez();

  assert.equal(enviosHechos.find((e) => e.to === phone), undefined);
});

test('cada paso (2h, 5h) se manda COMO MUCHO UNA VEZ en toda la vida de la conversacion: correr revisarUnaVez dos veces seguidas no duplica el envio', async () => {
  activarRemarketingDesdeSiempre();
  const phone = '584130000007';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionColgada() }));
  enviosHechos.length = 0;

  await remarketing.revisarUnaVez();
  await remarketing.revisarUnaVez(); // corrida siguiente, sin que haya pasado tiempo real

  const enviosAEstePhone = enviosHechos.filter((e) => e.to === phone);
  assert.equal(enviosAEstePhone.length, 1, 'BUG si esto es mas de 1: el flag remarketingSentAt5h tiene que evitar un segundo envio del mismo paso');
});

test('conversaciones colgadas desde ANTES de activar remarketing (remarketingActivatedAt) nunca reciben nada, aunque sigan colgadas', async () => {
  const phone = '584130000008';
  writeRaw(dataDir, 'sessions.json', JSON.stringify({ [phone]: sesionColgada() }));
  // Se activa remarketing AHORA MISMO (fecha actual), es decir DESPUES de la
  // ultima interaccion de esta conversacion (hace 6h): tiene que quedar
  // afuera para siempre, sin importar cuanto mas pase colgada.
  updateSettings({
    replyDelayMs: 5, remarketingEnabled: true, botEnabled: true,
    remarketingHourStart: 0, remarketingHourEnd: 24,
    remarketingActivatedAt: new Date().toISOString(),
  });
  enviosHechos.length = 0;

  await remarketing.revisarUnaVez();

  assert.equal(enviosHechos.find((e) => e.to === phone), undefined, 'BUG si se mando: esta conversacion ya estaba colgada ANTES de activar remarketing');
});

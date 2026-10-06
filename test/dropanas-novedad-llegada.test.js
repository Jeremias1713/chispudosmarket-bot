// Fase 5: "En novedad" en DroPanas/Tealca casi siempre significa que el paquete
// ya esta en la oficina. El bot avisa la LLEGADA (no la plantilla de novedad) y
// el chat pasa a esperando_retiro (entra en los recordatorios 1, 3 y 5).
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-novedad-llegada');
const { test, after } = require('node:test');

const assert = require('node:assert/strict');
const auto = require('../src/dropanasAuto');

function run(session, { notice = { sent: true }, pending = 'kn', order = {} } = {}) {
  const calls = { arrival: 0, novelty: 0, patches: [], pushes: [] };
  return auto.processChanges(
    [{ key: pending, order: { dropanasId: '60', guia: 'NN60', telefono: '04120000060', estadoPedido: 'En novedad', carrier: 'tealca', ...order } }],
    {
      env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
      matchRows: (rows) => rows,
      listSessions: () => [session],
      updateSession: (_p, patch) => { calls.patches.push(patch); return { ...session, ...patch, card: patch.card || session.card }; },
      maybeNotifyArrival: async () => { calls.arrival += 1; return notice; },
      maybeNotifyNovelty: async () => { calls.novelty += 1; return { sent: true }; },
      notifyAdmin: (title, body) => calls.pushes.push(body),
    }
  ).then((result) => ({ result, calls }));
}

const base = { phone: '584120000060', card: { guia: 'NN60', nombre: 'Rosa' } };

test('chat en camino + novedad: avisa la llegada una vez, pasa a esperando_retiro sin candado y guarda noveltyAt', async () => {
  const { result, calls } = await run({ ...base, stage: 'en_camino', orderClosed: true });
  assert.equal(calls.arrival, 1);
  assert.equal(calls.novelty, 0);
  const p = calls.patches.find((x) => x.stage);
  assert.equal(p.stage, 'esperando_retiro');
  assert.equal(p.stageLocked, false);
  assert.equal(p.stageSource, 'dropanas_novedad');
  assert.ok(p.noveltyAt);
  assert.equal(p.noveltyStatus, 'En novedad');
  assert.ok(p.pickupReminderAnchorDate, 'dia 0 de los recordatorios');
  assert.deepEqual(result.acknowledged, ['kn']);
  assert.equal(calls.pushes.length, 1);
  assert.match(calls.pushes[0], /Rosa.*NN60.*sí/);
});

test('chat esperando_retiro con aviso de llegada: no manda nada, no cambia la etapa, ack', async () => {
  const { result, calls } = await run({ ...base, stage: 'esperando_retiro', arrivalNotifiedAt: '2026-09-20T00:00:00Z' });
  assert.equal(calls.arrival, 0);
  assert.equal(calls.patches.some((x) => x.stage), false);
  assert.ok(calls.patches.some((x) => x.noveltyAt));
  assert.deepEqual(result.acknowledged, ['kn']);
});

test('chat vendido sin guia con novedad que trae guia: completa la guia, avisa llegada y pasa a esperando_retiro', async () => {
  let enviado = null;
  const session = { phone: '584120000060', stage: 'vendido', orderClosed: true, card: { nombre: 'Rosa' } };
  const calls = { patches: [] };
  const result = await auto.processChanges(
    [{ key: 'kv', order: { dropanasId: '60', guia: 'NN60', telefono: '04120000060', estadoPedido: 'En novedad', carrier: 'tealca' } }],
    {
      env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
      matchRows: (rows) => rows,
      listSessions: () => [session],
      updateSession: (_p, patch) => { calls.patches.push(patch); return { ...session, ...patch, card: patch.card || session.card }; },
      maybeNotifyArrival: async (_p, s) => { enviado = s; return { sent: true }; },
      notifyAdmin: () => {},
    }
  );
  assert.equal(enviado.card.guia, 'NN60');
  assert.ok(calls.patches.some((x) => x.stage === 'esperando_retiro'));
  assert.deepEqual(result.acknowledged, ['kv']);
});

test('chat entregado: no se toca y se confirma el evento', async () => {
  const { result, calls } = await run({ ...base, stage: 'entregado' });
  assert.equal(calls.arrival, 0);
  assert.equal(calls.patches.length, 0);
  assert.equal(result.results[0].reason, 'ya_finalizado');
  assert.deepEqual(result.acknowledged, ['kn']);
});

test('si el aviso de llegada falla, no se cambia la etapa y el evento queda pendiente', async () => {
  const { result, calls } = await run({ ...base, stage: 'en_camino', orderClosed: true }, { notice: { sent: false, reason: 'error' }, pending: 'kf' });
  assert.equal(calls.patches.some((x) => x.stage), false);
  assert.deepEqual(result.acknowledged, []);
});

test('maybeNotifyNovelty nunca se usa en este flujo', async () => {
  for (const stage of ['en_camino', 'vendido', 'esperando_retiro']) {
    const { calls } = await run({ ...base, stage, orderClosed: true, arrivalNotifiedAt: stage === 'esperando_retiro' ? '2026-09-20T00:00:00Z' : undefined }, { pending: `kx-${stage}` });
    assert.equal(calls.novelty, 0);
  }
});

after(() => cleanup(dataDir));

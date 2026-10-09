'use strict';
// S7: ack de un aviso de guia ya enviado, horario configurable, cache de
// estados compartido, alertas persistentes y disco lleno.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-detalles-s7');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const auto = require('../src/dropanasAuto');
const monitor = require('../src/dropanasMonitor');
const settings = require('../src/settings');
const statusCache = require('../src/dropanasStatusCache');
const reminders = require('../src/pickupReminders');

after(() => cleanup(dataDir));

test('aviso de guia que ya se habia mandado (ya_avisado) se confirma y sale de la cola', async () => {
  const result = await auto.processChanges(
    [{ key: 'ya1', order: { dropanasId: '601', guia: 'G601', carrier: 'tealca', estadoPedido: 'En tránsito' } }],
    {
      env: { DROPANAS_AUTO_SEND_ENABLED: 'true' },
      matchRows: (rows) => rows.map((row) => ({ ...row, matchType: 'exacto', matchEvidence: 'telefono', phone: '584120000601', sendEligible: true })),
      getSession: () => ({ phone: '584120000601', stage: 'vendido', orderClosed: true, card: {} }),
      updateSession: (_p, patch) => ({ phone: '584120000601', ...patch }),
      capture: async () => ({ filename: 'g.png' }),
      mediaUrl: (f) => `https://x/${f}`,
      maybeNotifyShipping: async () => ({ sent: false, reason: 'ya_avisado' }),
      listSessions: () => [],
    }
  );
  assert.deepEqual(result.acknowledged, ['ya1']);
});

test('el horario de avisos de DroPanas sale de la configuracion', () => {
  settings.updateSettings({ autoSendHourStart: 6, autoSendHourEnd: 22 });
  // 07:00 en Caracas = 11:00Z ; 21:30 Caracas = 01:30Z del dia siguiente.
  assert.equal(monitor.isQuietHours(new Date('2026-10-06T11:00:00Z')), false);
  assert.equal(monitor.isQuietHours(new Date('2026-10-07T01:30:00Z')), false);
  assert.equal(monitor.isQuietHours(new Date('2026-10-07T02:30:00Z')), true);
  settings.updateSettings({ autoSendHourStart: 8, autoSendHourEnd: 20 });
  assert.equal(monitor.isQuietHours(new Date('2026-10-06T11:00:00Z')), true);
});

test('officeStatus usa el cache fresco y no consulta DroPanas pedido por pedido', async () => {
  statusCache.putMany([{ dropanasId: '777', estadoPedido: 'En oficina', guia: 'G777' }]);
  let lookups = 0;
  const result = await reminders.officeStatus(
    [{ phone: '584120000777', card: { dropanasId: '777', guia: 'G777' } }],
    { fetchOrders: async () => { throw new Error('403'); }, fetchOrder: async () => { lookups += 1; return { order: null }; } }
  );
  assert.equal(lookups, 0);
  assert.equal(result.get('584120000777').state, 'en_oficina');
});

test('un dato del cache de hace mas de 2 horas no sirve', () => {
  statusCache.putMany([{ dropanasId: '778', estadoPedido: 'En oficina' }], new Date(Date.now() - 3 * 60 * 60 * 1000));
  assert.equal(statusCache.getFresh('778'), null);
});

test('las alertas enviadas quedan guardadas (sobreviven un reinicio)', () => {
  assert.equal(monitor.wasAlerted('novelty', '9001'), false);
  monitor.markAlerted('novelty', '9001');
  const raw = JSON.parse(fs.readFileSync(monitor.STATE_PATH, 'utf8'));
  assert.deepEqual(raw.alerted.novelty, ['9001']);
  assert.equal(monitor.wasAlerted('novelty', '9001'), true);
});

test('saveState con disco lleno limpia y reintenta una vez', () => {
  let writes = 0;
  let cleaned = 0;
  const writeFileSync = (file, data) => {
    writes += 1;
    if (writes === 1) { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; }
    fs.writeFileSync(file, data);
  };
  monitor.saveState(monitor.loadState(), { writeFileSync, janitor: { markEnospc: () => {}, runOnce: () => { cleaned += 1; } } });
  assert.equal(writes, 2);
  assert.equal(cleaned, 1);
});

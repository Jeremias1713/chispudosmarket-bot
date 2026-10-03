const test = require('node:test');
const assert = require('node:assert/strict');
const { setupTempDataDir } = require('./helpers/tempDataDir');

setupTempDataDir('pickup-reminders');
const reminders = require('../src/pickupReminders');

const settings = {
  pickupReminderEnabled: true,
  pickupReminderHour: 10,
  pickupReminderMaxDays: 5,
  pickupReminderActivatedAt: '2026-09-21T12:00:00.000Z',
  pickupTemplateName: 'pedido_ha_llegado_a_tealca',
};
const NOW = new Date('2026-09-23T14:10:00.000Z'); // 10:10 en Venezuela
// Llego el 22 -> el 23 es el dia 1 de los recordatorios (dias 1, 3 y 5).
const ARRIVED_D1 = '2026-09-22T14:00:00.000Z';
const inOffice = (extra = {}) => ({ phone: '584120000001', stage: 'esperando_retiro', card: { guia: '84800001', nombre: 'Ana Perez' }, arrivalNotifiedAt: ARRIVED_D1, ...extra });

test('con DroPanas confirmando "en oficina" recuerda el dia 1 desde el aviso de llegada', () => {
  assert.equal(reminders.eligible(inOffice(), settings, NOW, 'en_oficina'), true);
});

test('no recuerda si DroPanas dice que ya no esta en oficina, ni si no es "esperando_retiro"', () => {
  assert.equal(reminders.eligible(inOffice(), settings, NOW, 'otro_estado'), false);
  assert.equal(reminders.eligible(inOffice({ stage: 'en_camino' }), settings, NOW, 'en_oficina'), false);
  assert.equal(reminders.eligible(inOffice({ card: {} }), settings, NOW, 'en_oficina'), false);
  assert.equal(reminders.eligible(inOffice(), { ...settings, pickupReminderEnabled: false }, NOW, 'en_oficina'), false);
});

test('solo salen los dias 1, 3 y 5: dia 2 no, dia 3 si, dia 6 no', () => {
  const day = (n) => new Date(Date.parse('2026-09-22T14:10:00.000Z') + n * 86400000);
  assert.equal(reminders.eligible(inOffice(), settings, day(0), 'en_oficina'), false); // el dia del aviso
  assert.equal(reminders.eligible(inOffice(), settings, day(1), 'en_oficina'), true);
  assert.equal(reminders.eligible(inOffice({ pickupReminderCount: 1, pickupReminderGuia: '84800001' }), settings, day(2), 'en_oficina'), false);
  assert.equal(reminders.eligible(inOffice({ pickupReminderCount: 1, pickupReminderGuia: '84800001' }), settings, day(3), 'en_oficina'), true);
  assert.equal(reminders.eligible(inOffice({ pickupReminderCount: 2, pickupReminderGuia: '84800001' }), settings, day(5), 'en_oficina'), true);
  assert.equal(reminders.eligible(inOffice({ pickupReminderCount: 3, pickupReminderGuia: '84800001' }), settings, day(5), 'en_oficina'), false);
  assert.equal(reminders.eligible(inOffice({ pickupReminderCount: 2, pickupReminderGuia: '84800001' }), settings, day(6), 'en_oficina'), false);
  // un dia perdido no se recupera: el dia 3 sale aunque el dia 1 no salio
  assert.equal(reminders.eligible(inOffice(), settings, day(3), 'en_oficina'), true);
});

test('un cliente que escribio ayer esta en conversacion: no se le recuerda', () => {
  const hist = [{ role: 'user', content: 'ya voy', at: '2026-09-22T20:00:00.000Z' }];
  assert.equal(reminders.eligible(inOffice({ history: hist }), settings, NOW, 'en_oficina'), false);
  // si escribio hace mas de 48 h, o antes del aviso de llegada, si se recuerda
  assert.equal(reminders.eligible(inOffice({ history: [{ role: 'user', content: 'hola', at: '2026-09-22T10:00:00.000Z' }] }), settings, NOW, 'en_oficina'), true);
});

test('sin aviso de llegada del bot, la fecha ancla nueva es el dia 0 y no manda', () => {
  const s = inOffice({ arrivalNotifiedAt: undefined, pickupReminderAnchorDate: '2026-09-23' });
  assert.equal(reminders.eligible(s, settings, NOW, 'en_oficina'), false);
  assert.equal(reminders.eligible(inOffice({ arrivalNotifiedAt: undefined }), settings, NOW, 'en_oficina'), false); // sin ancla todavia
  assert.equal(reminders.eligible(inOffice({ arrivalNotifiedAt: undefined, pickupReminderAnchorDate: '2026-09-22' }), settings, NOW, 'en_oficina'), true);
});

test('sin confirmacion de DroPanas solo recuerda si el bot aviso la llegada', () => {
  assert.equal(reminders.eligible(inOffice({ arrivalNotifiedAt: undefined }), settings, NOW, null), false);
  assert.equal(reminders.eligible(inOffice(), settings, NOW, null), true);
});

test('no duplica el mismo dia y respeta el tope', () => {
  assert.equal(reminders.eligible(inOffice({ pickupReminderLastDate: '2026-09-23' }), settings, NOW, 'en_oficina'), false);
  // Si la guia cambio (compra nueva), el contador vuelve a cero.
  assert.equal(reminders.eligible(inOffice({ pickupReminderCount: 99, pickupReminderGuia: 'OTRA' }), settings, NOW, 'en_oficina'), true);
});

function fakeDeps({ sessions, orders, failSend = false }) {
  const store = new Map(sessions.map((s) => [s.phone, { ...s }]));
  const sent = [];
  return {
    sent,
    store,
    deps: {
      settings,
      lookupPauseMs: 0,
      listSessions: () => [...store.values()],
      updateSession: (phone, patch) => { const next = { ...store.get(phone), ...patch }; store.set(phone, next); return next; },
      appendMessage: () => {},
      sendTemplateWithSnapshot: async (args) => { if (failSend) throw new Error('Meta caido'); sent.push(args); return { wamid: 'w', snapshot: {} }; },
      fetchOrders: async () => {
        if (orders === null) throw new Error('403');
        return { orders };
      },
      fetchOrder: async (id) => {
        const order = (orders || []).find((o) => o.dropanasId === String(id));
        if (!order) throw new Error('404');
        return { order };
      },
    },
  };
}

test('run manda la plantilla una sola vez por dia solo a los que DroPanas confirma en oficina', async () => {
  reminders.resetDecided();
  const { deps, sent, store } = fakeDeps({
    sessions: [
      inOffice({ phone: '58412000001', card: { guia: '84800001', nombre: 'Ana' } }),
      inOffice({ phone: '58412000002', card: { guia: '84800002', nombre: 'Luis' } }),
      inOffice({ phone: '58412000003', card: { guia: 'DP7003', nombre: 'Rosa' } }),
      { phone: '58412000004', stage: 'en_camino', card: { guia: '84800004' } },
    ],
    orders: [
      { dropanasId: '7001', guia: '84800001', estadoPedido: 'En oficina' },
      { dropanasId: '7002', guia: '84800002', estadoPedido: 'Entregado' },
      { dropanasId: '7003', guia: '84800003', estadoPedido: 'En Oficina' },
    ],
  });
  const results = await reminders.run(NOW, deps);
  assert.deepEqual(results.map((r) => r.phone).sort(), ['58412000001', '58412000003']);
  assert.equal(sent.length, 2);
  // La conversacion con guia DP pasa a mostrar la guia real de Tealca.
  const rosa = sent.find((args) => args.to === '58412000003');
  assert.equal(rosa.values[2], '84800003');
  assert.equal(store.get('58412000003').card.guiaDropanas, 'DP7003');
  assert.equal(rosa.templateName, 'pedido_ha_llegado_a_tealca');
  // Segundo chequeo del mismo dia: no repite nada.
  const again = await reminders.run(new Date('2026-09-23T15:10:00.000Z'), deps);
  assert.equal(again.length, 0);
  assert.equal(sent.length, 2);
  // El dia 2 no toca; el dia 3 vuelve a recordar.
  const day2 = await reminders.run(new Date('2026-09-24T14:05:00.000Z'), deps);
  assert.equal(day2.length, 0);
  const day3 = await reminders.run(new Date('2026-09-25T14:05:00.000Z'), deps);
  assert.equal(day3.length, 2);
  assert.equal(store.get('58412000001').pickupReminderCount, 2);
  assert.equal(store.get('58412000001').autoSends.count, 1); // el contador diario es por dia
});

test('no manda antes de la hora configurada ni de noche', async () => {
  reminders.resetDecided();
  const { deps, sent } = fakeDeps({ sessions: [inOffice()], orders: [{ dropanasId: '1', guia: '84800001', estadoPedido: 'En oficina' }] });
  await reminders.run(new Date('2026-09-23T13:30:00.000Z'), deps); // 9:30
  await reminders.run(new Date('2026-09-24T00:30:00.000Z'), deps); // 20:30
  assert.equal(sent.length, 0);
  await reminders.run(new Date('2026-09-23T20:00:00.000Z'), deps); // 16:00, se recupera si estuvo caido a las 10
  assert.equal(sent.length, 1);
});

test('si DroPanas no responde, solo recuerda llegadas recientes y vuelve a intentar despues', async () => {
  reminders.resetDecided();
  const { deps, sent } = fakeDeps({
    sessions: [
      inOffice({ phone: '58412000011', arrivalNotifiedAt: '2026-09-22T14:00:00.000Z' }),
      inOffice({ phone: '58412000012', arrivalNotifiedAt: undefined }),
    ],
    orders: null,
  });
  const results = await reminders.run(NOW, deps);
  assert.deepEqual(results.map((r) => r.phone), ['58412000011']);
  assert.equal(sent.length, 1);
});

test('un envio que falla no se reintenta el mismo dia (la marca va antes) y no cuenta para el maximo', async () => {
  reminders.resetDecided();
  const { deps, store } = fakeDeps({ sessions: [inOffice()], orders: [{ dropanasId: '1', guia: '84800001', estadoPedido: 'En oficina' }], failSend: true });
  for (let i = 0; i < 5; i += 1) await reminders.run(new Date(NOW.getTime() + i * 15 * 60 * 1000), deps);
  const s = store.get('584120000001');
  assert.equal(s.pickupReminderFailCount, 1);
  assert.equal(s.pickupReminderLastDate, '2026-09-23');
  assert.equal(s.pickupReminderCount, 0);
});

test('si el guardado de la marca falla, NO se manda nada', async () => {
  reminders.resetDecided();
  const { deps, sent } = fakeDeps({ sessions: [inOffice()], orders: [{ dropanasId: '1', guia: '84800001', estadoPedido: 'En oficina' }] });
  deps.updateSession = () => { throw new Error('ENOSPC'); };
  await reminders.run(NOW, deps);
  assert.equal(sent.length, 0);
});

test('con opt-out igual se recuerda? No: es marketing y se salta', async () => {
  reminders.resetDecided();
  const { deps, sent } = fakeDeps({ sessions: [inOffice({ optOut: true })], orders: [{ dropanasId: '1', guia: '84800001', estadoPedido: 'En oficina' }] });
  await reminders.run(NOW, deps);
  assert.equal(sent.length, 0);
});

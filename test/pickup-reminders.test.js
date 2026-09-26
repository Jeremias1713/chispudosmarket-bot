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
const inOffice = (extra = {}) => ({ phone: '584120000001', stage: 'esperando_retiro', card: { guia: '84800001', nombre: 'Ana Perez' }, ...extra });

test('con DroPanas confirmando "en oficina" recuerda a todos, aunque el bot no haya avisado la llegada', () => {
  assert.equal(reminders.eligible(inOffice(), settings, NOW, 'en_oficina'), true);
  assert.equal(reminders.eligible(inOffice({ arrivalNotifiedAt: '2026-09-10T14:00:00.000Z' }), settings, NOW, 'en_oficina'), true);
});

test('no recuerda si DroPanas dice que ya no esta en oficina, ni si no es "esperando_retiro"', () => {
  assert.equal(reminders.eligible(inOffice(), settings, NOW, 'otro_estado'), false);
  assert.equal(reminders.eligible(inOffice({ stage: 'en_camino' }), settings, NOW, 'en_oficina'), false);
  assert.equal(reminders.eligible(inOffice({ card: {} }), settings, NOW, 'en_oficina'), false);
  assert.equal(reminders.eligible(inOffice(), { ...settings, pickupReminderEnabled: false }, NOW, 'en_oficina'), false);
});

test('sin confirmacion de DroPanas solo recuerda llegadas recientes avisadas por el bot', () => {
  assert.equal(reminders.eligible(inOffice(), settings, NOW, null), false);
  assert.equal(reminders.eligible(inOffice({ arrivalNotifiedAt: '2026-09-22T14:00:00.000Z' }), settings, NOW, null), true);
  assert.equal(reminders.eligible(inOffice({ arrivalNotifiedAt: '2026-09-10T14:00:00.000Z' }), settings, NOW, null), false);
});

test('no duplica el mismo dia, ni el dia de la llegada, y respeta los topes', () => {
  assert.equal(reminders.eligible(inOffice({ pickupReminderLastDate: '2026-09-23' }), settings, NOW, 'en_oficina'), false);
  assert.equal(reminders.eligible(inOffice({ arrivalNotifiedAt: '2026-09-23T12:00:00.000Z' }), settings, NOW, 'en_oficina'), false);
  assert.equal(reminders.eligible(inOffice({ pickupReminderCount: reminders.CONFIRMED_MAX_REMINDERS, pickupReminderGuia: '84800001' }), settings, NOW, 'en_oficina'), false);
  // Si la guia cambio (compra nueva), el contador vuelve a cero.
  assert.equal(reminders.eligible(inOffice({ pickupReminderCount: 99, pickupReminderGuia: 'OTRA' }), settings, NOW, 'en_oficina'), true);
  assert.equal(reminders.eligible(inOffice({ arrivalNotifiedAt: '2026-09-18T14:00:00.000Z', pickupReminderCount: 5 }), settings, NOW, null), false);
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
  // Al dia siguiente vuelve a recordar.
  const tomorrow = await reminders.run(new Date('2026-09-24T14:05:00.000Z'), deps);
  assert.equal(tomorrow.length, 2);
  assert.equal(store.get('58412000001').pickupReminderCount, 2);
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
      inOffice({ phone: '58412000012' }),
    ],
    orders: null,
  });
  const results = await reminders.run(NOW, deps);
  assert.deepEqual(results.map((r) => r.phone), ['58412000011']);
  assert.equal(sent.length, 1);
});

test('un envio que falla se reintenta, con un maximo de 3 intentos por dia', async () => {
  reminders.resetDecided();
  const { deps, store } = fakeDeps({ sessions: [inOffice()], orders: [{ dropanasId: '1', guia: '84800001', estadoPedido: 'En oficina' }], failSend: true });
  for (let i = 0; i < 5; i += 1) await reminders.run(new Date(NOW.getTime() + i * 15 * 60 * 1000), deps);
  assert.equal(store.get('584120000001').pickupReminderFailCount, 3);
  assert.equal(store.get('584120000001').pickupReminderLastDate, undefined);
});

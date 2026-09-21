'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-api');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../src/dropanasApi');
const monitor = require('../src/dropanasMonitor');

after(() => cleanup(dataDir));

const config = {
  enabled: true,
  readOnlyAck: true,
  token: 'live_sk_fake_for_tests',
  tokenMode: 'live',
  baseUrl: api.DEFAULT_BASE_URL,
  timeoutMs: 1000,
  maxPages: 10,
};

test('mapea el esquema real anidado sin confundir bodega origen con destino', () => {
  const mapped = api.mapOrder({
    id: 44,
    status: '3',
    tipo_entrega: 'oficina',
    oficina_id: 312,
    precio_venta_ves: 36900,
    cliente: { nombre: 'Ana', apellido: 'Pérez', telefono: '0412-1234567' },
    productos: [{ nombre: 'Producto A', cantidad: 2 }],
    tracking: { numero_guia: '84800000', status: 'En camino' },
    bodega_origen: { id: 1, nombre: 'Origen' },
  });
  assert.equal(mapped.dropanasId, '44');
  assert.equal(mapped.telefono, '584121234567');
  assert.equal(mapped.guia, '84800000');
  assert.equal(mapped.estadoPedido, 'En camino');
  assert.equal(mapped.carrier, 'tealca');
  assert.equal(mapped.producto, '2 × Producto A');
  assert.equal(mapped.bodegaDestino, '');
});

test('recorre todas las páginas GET y valida X-DroPanas-Mode', async () => {
  const calls = [];
  const client = { get: async (_url, options) => {
    calls.push(options.params.page);
    const page = options.params.page;
    return {
      headers: { 'x-dropanas-mode': 'live' },
      data: {
        data: [{ id: page }],
        links: { next: page === 1 ? 'next' : null },
        meta: { current_page: page, last_page: 2, per_page: 100, total: 2 },
      },
    };
  } };
  const result = await api.fetchAll('ordenes', { config, client });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.total, 2);
  assert.equal(result.mode, 'live');
});

test('rechaza mezcla accidental entre token live y respuesta sandbox', async () => {
  const client = { get: async () => ({
    headers: { 'x-dropanas-mode': 'sandbox' },
    data: { data: [], links: { next: null }, meta: { current_page: 1, last_page: 1, per_page: 100, total: 0 } },
  }) };
  await assert.rejects(() => api.fetchAll('ordenes', { config, client }), /Modo Dropanas inesperado/);
});

test('la primera lectura crea referencia y no genera acciones antiguas', () => {
  const state = monitor.blankState();
  const first = monitor.reconcile(state, [api.mapOrder({ id: 1, status: '1', cliente: {}, productos: [], tracking: {} })], [], '2026-09-17T12:00:00.000Z');
  assert.equal(first.baselineCreated, true);
  assert.equal(first.orderChanges.length, 0);
  assert.equal(state.pending.length, 0);
});

test('solo un cambio posterior entra una vez a la cola', () => {
  const state = monitor.blankState();
  const initial = api.mapOrder({ id: 1, status: '1', cliente: {}, productos: [], tracking: { status: 'Pendiente' } });
  monitor.reconcile(state, [initial], [], '2026-09-17T12:00:00.000Z');
  const changed = { ...initial, guia: '84800000', estadoPedido: 'En camino', updatedAt: '2026-09-17T12:05:00.000Z' };
  const result = monitor.reconcile(state, [changed], [], '2026-09-17T12:05:00.000Z');
  assert.equal(result.orderChanges.length, 1);
  assert.equal(state.pending.length, 1);
  monitor.reconcile(state, [changed], [], '2026-09-17T12:10:00.000Z');
  assert.equal(state.pending.length, 1);
});

test('varios cambios pendientes de la misma orden se compactan al estado más nuevo', () => {
  const state = monitor.blankState();
  const initial = api.mapOrder({ id: 1, cliente: {}, productos: [], tracking: { status: 'Generada' } });
  monitor.reconcile(state, [initial], [], '2026-09-17T12:00:00.000Z');
  const camino = { ...initial, estadoPedido: 'En camino' };
  monitor.reconcile(state, [camino], [], '2026-09-17T12:05:00.000Z');
  const oficina = { ...initial, estadoPedido: 'En oficina' };
  monitor.reconcile(state, [oficina], [], '2026-09-17T12:10:00.000Z');
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].order.estadoPedido, 'En oficina');
});

test('un cambio solo de updated_at no genera una acción falsa', () => {
  const state = monitor.blankState();
  const initial = api.mapOrder({ id: 1, updated_at: '2026-09-17T12:00:00.000Z', cliente: {}, productos: [], tracking: { status: 'En camino' } });
  monitor.reconcile(state, [initial], [], '2026-09-17T12:00:00.000Z');
  const touched = { ...initial, updatedAt: '2026-09-17T12:05:00.000Z' };
  const result = monitor.reconcile(state, [touched], [], '2026-09-17T12:05:00.000Z');
  assert.equal(result.orderChanges.length, 0);
  assert.equal(state.pending.length, 0);
});

test('webhook exige HMAC válido y timestamp reciente', () => {
  const rawBody = Buffer.from('{"evento":"order.status_changed"}');
  const secret = 'secret-test';
  const timestamp = 1_800_000_000;
  const signature = monitor.webhookSignature(rawBody, secret);
  assert.equal(monitor.verifyWebhook({ rawBody, signature, timestamp, secret, now: timestamp * 1000 }), true);
  assert.equal(monitor.verifyWebhook({ rawBody, signature: '00', timestamp, secret, now: timestamp * 1000 }), false);
  assert.equal(monitor.verifyWebhook({ rawBody, signature, timestamp, secret, now: timestamp * 1000 + 301000 }), false);
});

test('consulta una sola orden por id sin depender del listado', async () => {
  let requestedUrl = '';
  const client = { get: async (url, options) => {
    requestedUrl = url;
    assert.equal(options.params, undefined);
    return {
      headers: { 'x-dropanas-mode': 'live' },
      data: {
        data: {
          id: 34622,
          tipo_entrega: 'oficina',
          cliente: { nombre: 'Juan', apellido: 'Branger', telefono: '04125550123' },
          productos: [],
          tracking: { numero_guia: '84804888', status: 'En camino' },
        },
      },
    };
  } };
  const result = await api.fetchOrder('34622', { config, client });
  assert.equal(requestedUrl, `${api.DEFAULT_BASE_URL}/ordenes/34622`);
  assert.equal(result.order.guia, '84804888');
  assert.equal(result.order.telefono, '584125550123');
});

test('un 403 en novedades no bloquea la sincronización de pedidos y guías', async () => {
  const client = { get: async (url, options) => {
    if (url.endsWith('/novedades')) {
      const error = new Error('Forbidden');
      error.response = { status: 403 };
      throw error;
    }
    return {
      headers: { 'x-dropanas-mode': 'live' },
      data: {
        data: [{ id: 99, status: '1', cliente: {}, productos: [], tracking: {} }],
        links: { next: null },
        meta: { current_page: options.params.page, last_page: 1, per_page: 100, total: 1 },
      },
    };
  } };
  const result = await monitor.sync({ config, client });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'live');
  assert.equal(result.totals.orders, 1);
  assert.equal(result.totals.novelties, 0);
  assert.match(monitor.status().lastWarning, /no autorizó la lectura de novedades/);
});

test('webhook de guía consulta solo la orden anunciada y la deja pendiente', async () => {
  delete process.env.DROPANAS_AUTO_SEND_ENABLED;
  const calls = [];
  const client = { get: async (url) => {
    calls.push(url);
    return {
      headers: { 'x-dropanas-mode': 'live' },
      data: {
        data: {
          id: 777,
          tipo_entrega: 'oficina',
          cliente: { nombre: 'Ana', apellido: 'Abreu', telefono: '04125550999' },
          productos: [],
          tracking: { numero_guia: 'GUIA-777', status: 'En camino' },
        },
      },
    };
  } };
  const result = await monitor.processWebhook({
    evento: 'order.guide_generated',
    sandbox: false,
    datos: {
      orden_id: 777,
      pedido: { numero_dropanas: 777, numero_guia: 'GUIA-777', transportadora: 'Tealca' },
    },
  }, { config, client });
  assert.deepEqual(calls, [`${api.DEFAULT_BASE_URL}/ordenes/777`]);
  assert.equal(result.ok, true);
  assert.equal(result.detailWarning, null);
  const pending = monitor.listPending().find((item) => item.order?.dropanasId === '777');
  assert.equal(pending.order.telefono, '584125550999');
  assert.equal(pending.order.guia, 'GUIA-777');
});

test('si falla el detalle, el webhook firmado conserva la guía sin enviarla a ciegas', async () => {
  delete process.env.DROPANAS_AUTO_SEND_ENABLED;
  const client = { get: async () => { throw new Error('Forbidden 403'); } };
  const result = await monitor.processWebhook({
    evento: 'order.guide_generated',
    sandbox: false,
    datos: {
      orden_id: 778,
      pedido: { numero_dropanas: 778, numero_guia: 'GUIA-778', transportadora: 'ZOOM' },
    },
  }, { config, client });
  assert.match(result.detailWarning, /403/);
  const pending = monitor.listPending().find((item) => item.order?.dropanasId === '778');
  assert.equal(pending.order.carrier, 'zoom');
  assert.equal(pending.order.telefono, '');
});

for (const scenario of [
  { event: 'order.status_changed', announced: 'Pendiente de devolución', expected: 'Pendiente de devolución' },
  { event: 'order.delivered', announced: '', expected: 'Entregado' },
  { event: 'incident.created', announced: '', expected: 'En novedad' },
]) {
  test(`webhook ${scenario.event} conserva el estado anunciado y lo deja listo para automatizar`, async () => {
    delete process.env.DROPANAS_AUTO_SEND_ENABLED;
    const client = { get: async () => ({
      headers: { 'x-dropanas-mode': 'live' },
      data: { data: {
        id: 880,
        tipo_entrega: 'oficina',
        cliente: { nombre: 'Ana', apellido: 'Abreu', telefono: '04125550880' },
        productos: [{ nombre: 'Shilajit', cantidad: 1 }],
        tracking: { numero_guia: 'GUIA-880', status: 'En camino' },
      } },
    }) };
    const result = await monitor.processWebhook({
      evento: scenario.event,
      sandbox: false,
      datos: {
        orden_id: 880,
        status_nuevo: scenario.announced,
        pedido: { numero_dropanas: 880, numero_guia: 'GUIA-880', transportadora: 'Tealca' },
      },
    }, { config, client });

    assert.equal(result.ok, true);
    assert.equal(result.event, scenario.event);
    const pending = monitor.listPending().find((item) => item.order?.dropanasId === '880');
    assert.equal(pending.kind, scenario.event);
    assert.equal(pending.order.estadoPedido, scenario.expected);
    assert.equal(pending.order.telefono, '584125550880');
  });
}

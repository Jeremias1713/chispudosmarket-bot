'use strict';
// S3: el polling (listado, a veces atrasado) no pisa un evento mas avanzado que
// llego por webhook, y el mismo estado por las dos vias da un solo evento.
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-sync-order');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../src/dropanasMonitor');

after(() => cleanup(dataDir));

function order(id, estado, extra = {}) {
  return { dropanasId: String(id), guia: `G-${id}`, telefono: '584140005000', cliente: 'Cliente', estadoPedido: estado, carrier: 'tealca', ...extra };
}

function poll(orders) {
  const state = monitor.loadState();
  if (!state.baselineAt) state.baselineAt = new Date().toISOString();
  state.snapshotVersion = monitor.SNAPSHOT_VERSION;
  const result = monitor.reconcile(state, orders, [], new Date().toISOString());
  monitor.saveState(state);
  return result;
}

const pendingOf = (id) => monitor.listPending().filter((item) => item.order && item.order.dropanasId === String(id));

test('webhook "En oficina" en cola + polling "En tránsito": queda "En oficina"', () => {
  monitor.queueWebhookOrder(order(5001, 'En oficina'));
  const result = poll([order(5001, 'En tránsito', { cliente: 'Cliente Listado' })]);
  assert.equal(result.orderChanges.length, 0);
  assert.deepEqual(pendingOf(5001).map((p) => p.order.estadoPedido), ['En oficina']);
});

test('polling "Entregado" despues de un webhook "En oficina": queda "Entregado"', () => {
  monitor.queueWebhookOrder(order(5002, 'En oficina'));
  poll([order(5002, 'Entregado')]);
  assert.deepEqual(pendingOf(5002).map((p) => p.order.estadoPedido), ['Entregado']);
});

test('mismo estado por webhook y por polling: un solo evento', () => {
  monitor.queueWebhookOrder(order(5003, 'En oficina', { cliente: '', producto: '' }));
  const result = poll([order(5003, 'En oficina', { cliente: 'Nombre Completo', producto: 'Shilajit', totalVentaBs: 900 })]);
  assert.equal(result.orderChanges.length, 0);
  assert.equal(pendingOf(5003).length, 1);
});

test('dos webhooks: uno atrasado no reemplaza al mas avanzado; un updatedAt mas nuevo si', () => {
  monitor.queueWebhookOrder(order(5004, 'En oficina'));
  monitor.queueWebhookOrder(order(5004, 'En tránsito'));
  assert.deepEqual(pendingOf(5004).map((p) => p.order.estadoPedido), ['En oficina']);
  assert.equal(monitor.shouldReplace(
    order(5005, 'Entregado', { updatedAt: '2026-10-01T10:00:00Z' }),
    order(5005, 'En oficina', { updatedAt: '2026-10-02T10:00:00Z' }),
  ), true);
});

test('el cambio de formato del hash se toma como linea base en silencio', () => {
  const state = monitor.loadState();
  state.baselineAt = '2026-01-01T00:00:00Z';
  state.snapshotVersion = 1;
  const result = monitor.reconcile(state, [order(5006, 'En oficina')], [], new Date().toISOString());
  assert.equal(result.baselineCreated, true);
  assert.equal(result.orderChanges.length, 0);
  assert.equal(state.snapshotVersion, monitor.SNAPSHOT_VERSION);
});

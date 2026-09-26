'use strict';
// Edicion manual de pedidos en la bandeja: oficina sugerida desde el chat y
// correcciones de nombre, cedula, telefono y productos. Datos simulados, sin red.
const { setupTempDataDir, writeJson, cleanup } = require('./helpers/tempDataDir');
const dataDir = setupTempDataDir('dropanas-order-edicion');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const automation = require('../src/dropanasOrderAutomation');
const { getSession } = require('../src/state');

after(() => cleanup(dataDir));

const OFFICES = [
  { id: 101, nombre: 'Tealca Coro', ciudad: 'Coro', estado: 'Falcón', direccion: 'Av. Manaure' },
  { id: 102, nombre: 'Tealca Punto Fijo', ciudad: 'Punto Fijo', estado: 'Falcón', direccion: 'Calle Comercio' },
  { id: 103, nombre: 'Tealca Valencia Centro', ciudad: 'Valencia', estado: 'Carabobo', direccion: 'Av. Bolívar' },
];

function sold(overrides = {}) {
  return {
    phone: '584141112233', name: 'Ana Perez', stage: 'vendido', orderClosed: true,
    soldAt: '2026-09-26T12:00:00.000Z',
    card: { nombre: 'Ana Perez', cedula: '12345678', telefono: '04141112233', producto: 'Shilajit Viking' },
    currentOrder: { product: 'Shilajit Viking', quantity: 1, total: 36900 },
    history: [],
    ...overrides,
  };
}

test('sugiere la oficina de la ciudad que el cliente nombro en el chat (ej. Coro)', () => {
  const session = sold({ history: [
    { role: 'assistant', content: '¿En qué ciudad te encuentras?' },
    { role: 'user', content: 'Estoy en Coro, Falcón' },
  ] });
  const draft = automation.baseDraft(session.phone, session);
  assert.equal(draft.agency, '');
  const suggestions = automation.suggestOffices(draft, session, OFFICES);
  assert.equal(suggestions[0].id, 101);
  assert.equal(suggestions.some((row) => row.id === 103), false);
});

test('la agencia confirmada pesa mas que una ciudad mencionada de pasada', () => {
  const session = sold({
    card: { ...sold().card, ciudad: 'Coro' },
    history: [{ role: 'assistant', content: 'Resumen:\n- Agencia: Tealca Punto Fijo' }],
  });
  const draft = automation.baseDraft(session.phone, session);
  assert.equal(automation.suggestOffices(draft, session, OFFICES)[0].id, 102);
});

test('la edicion manual reemplaza nombre, cedula, telefono, productos y oficina solo para esta venta', () => {
  const session = sold({
    card: { nombre: 'Ana', cedula: 'x', telefono: '', producto: 'algo raro' },
    currentOrder: {},
  });
  const reference = automation.baseDraft(session.phone, session).reference;
  const edited = automation.baseDraft(session.phone, {
    ...session,
    dropanasOrderEdit: {
      reference, nombre: 'Ana María', apellido: 'Pérez', cedula: '12345678', documentType: 'E', telefono: '04141112233',
      items: [{ mappingId: 'shilajit', quantity: 2, total: 51900 }], officeId: 101, officeLabel: 'Tealca Coro',
    },
  });
  assert.deepEqual(edited.identity, { nombre: 'Ana María', apellido: 'Pérez' });
  assert.equal(edited.cedula, '12345678');
  assert.equal(edited.documentType, 'E');
  assert.equal(edited.customerPhone, '04141112233');
  assert.equal(edited.quantity, 2);
  assert.equal(edited.total, 51900);
  assert.equal(edited.agency, 'Tealca Coro');
  assert.equal(edited.officeId, 101);
  assert.equal(edited.edited, true);
  assert.deepEqual(edited.issues, []);

  // Una venta nueva (otra fecha de cierre) no hereda la edicion anterior.
  const nextSale = automation.baseDraft(session.phone, {
    ...session, soldAt: '2026-10-05T12:00:00.000Z',
    dropanasOrderEdit: { reference, nombre: 'Ana María', apellido: 'Pérez', officeId: 101, officeLabel: 'Tealca Coro' },
  });
  assert.equal(nextSale.officeId, null);
  assert.equal(nextSale.edited, false);
});

test('guardar la edicion valida los datos y la deja en la conversacion', async () => {
  const phone = '584149998877';
  writeJson(dataDir, 'sessions.json', { [phone]: { ...sold({ phone }), step: 'IDLE', cart: [] } });
  await assert.rejects(automation.saveDraftEdit(phone, { cedula: '12' }), /cédula/);
  await assert.rejects(automation.saveDraftEdit(phone, { telefono: '1234' }), /teléfono/);
  await assert.rejects(automation.saveDraftEdit(phone, { nombre: 'Solo' }), /nombre y apellido/);
  await assert.rejects(automation.saveDraftEdit(phone, { items: [{ mappingId: 'no-existe', quantity: 1, total: 1 }] }), /producto/);
  await automation.saveDraftEdit(phone, { nombre: 'Ana', apellido: 'Perez', cedula: 'V-12.345.678', telefono: '0414-111-2233' })
    .catch(() => null); // puede fallar la validacion en vivo (sin red); lo guardado importa
  const saved = getSession(phone).dropanasOrderEdit;
  assert.equal(saved.nombre, 'Ana');
  assert.equal(saved.cedula, '12345678');
  assert.equal(saved.telefono, '04141112233');
  assert.equal(saved.reference, automation.baseDraft(phone, getSession(phone)).reference);
});

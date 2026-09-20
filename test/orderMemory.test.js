const test = require('node:test');
const assert = require('node:assert/strict');
const {
  blankOrder,
  extractQuantity,
  extractIdentity,
  extractDestinationCity,
  extractAgencySelection,
  extractMoney,
  applyOrderMessage,
} = require('../src/orderMemory');

const menu = '1. Un frasco\n2. Dos frascos\n3. Tengo una duda antes de pedir. Respondeme con el numero 1, 2 o 3';

test('opcion 3 del menu no es cantidad, pero Dos posterior si se conserva', () => {
  assert.equal(extractQuantity('3', menu), null);
  let state = applyOrderMessage({ currentOrder: blankOrder(), text: 'Dos', precedingAssistantText: '¿Cuantos queres?' }).order;
  assert.equal(state.quantity, 2);
  state = applyOrderMessage({ currentOrder: state, text: '¿Cuanto tarda?', precedingAssistantText: 'Decime tus datos' }).order;
  assert.equal(state.quantity, 2);
});

test('seleccion de agencia no se confunde con cantidad', () => {
  const bot = '1. Agencia Centro\n2. Agencia Terminal\n¿Cual te queda mejor?';
  assert.equal(extractQuantity('La 2', bot), null);
  assert.equal(extractAgencySelection('La 2', bot), 'Agencia Terminal');
  assert.equal(extractAgencySelection('Si', bot), null, 'si hay varias, un si es ambiguo');
});

test('un si confirma una unica agencia ofrecida', () => {
  const bot = '1. Tealca Carupano - Av. Principal\n¿Te queda bien esta agencia?';
  assert.equal(extractAgencySelection('Sí', bot), 'Tealca Carupano - Av. Principal');
});

test('identidad junta, por lineas y acumulada en varios mensajes', () => {
  assert.deepEqual(extractIdentity('Persona Ejemplo 12345678 04121234567'), {
    nombre: 'Persona Ejemplo', cedula: '12345678', telefono: '04121234567',
  });
  assert.deepEqual(extractIdentity('Nombre: Persona Ejemplo\nCédula: 12.345.678\nTeléfono: +58 412-123-4567'), {
    nombre: 'Persona Ejemplo', cedula: '12345678', telefono: '04121234567',
  });
  let identity = extractIdentity('Nombre: Persona Ejemplo');
  identity = extractIdentity('Cédula: 12345678', identity);
  identity = extractIdentity('Teléfono: 0412-123-4567', identity);
  assert.deepEqual(identity, { nombre: 'Persona Ejemplo', cedula: '12345678', telefono: '04121234567' });
});

test('la ciudad vigente respeta contraste y referencia', () => {
  assert.equal(extractDestinationCity('No estoy en Caracas, estoy en Coro'), 'coro');
  assert.equal(extractDestinationCity('¿Ustedes están en Caracas? Yo estoy en Coro'), 'coro');
});

test('cambiar ciudad invalida agencia, sin borrar cantidad', () => {
  const previous = { ...blankOrder(), city: 'carupano', agency: 'Tealca Carupano', quantity: 2 };
  const next = applyOrderMessage({ currentOrder: previous, text: 'Ahora estoy en Coro', precedingAssistantText: '' }).order;
  assert.equal(next.city, 'coro');
  assert.equal(next.agency, null);
  assert.equal(next.quantity, 2);
});

test('cambio explicito de cantidad actualiza el pedido', () => {
  const previous = { ...blankOrder(), quantity: 2, total: 51900, quotedQuantity: 2, accepted: true };
  const next = applyOrderMessage({ currentOrder: previous, text: 'Mejor 3', precedingAssistantText: '' }).order;
  assert.equal(next.quantity, 3);
  assert.equal(next.total, null);
  assert.equal(next.accepted, false);
});

test('conserva un total cotizado y una aceptacion contextual para las condiciones vigentes', () => {
  const previous = { ...blankOrder(), quantity: 2 };
  const next = applyOrderMessage({
    currentOrder: previous,
    text: 'Sí',
    precedingAssistantText: 'Tu pedido de 2 queda en 51.900 Bs. ¿Confirmas el pedido?',
  }).order;
  assert.equal(extractMoney('Total Bs 51.900'), 51900);
  assert.equal(next.total, 51900);
  assert.equal(next.quotedQuantity, 2);
  assert.equal(next.accepted, true);
});

test('una retractacion invalida la aceptacion sin borrar los demas datos', () => {
  const previous = { ...blankOrder(), quantity: 2, total: 51900, accepted: true, agency: 'Tealca Centro' };
  const next = applyOrderMessage({ currentOrder: previous, text: 'Espera, todavía no lo confirmes', precedingAssistantText: '' }).order;
  assert.equal(next.accepted, false);
  assert.equal(next.quantity, 2);
  assert.equal(next.agency, 'Tealca Centro');
});

test('MRW y Zoom quedan como retiro en agencia con coordinacion humana', () => {
  for (const courier of ['MRW', 'Zoom']) {
    const order = applyOrderMessage({ currentOrder: blankOrder(), text: `Prefiero ${courier}`, precedingAssistantText: '' }).order;
    assert.equal(order.modality, 'agency_pickup');
    assert.equal(order.needsHumanPayment, true);
    assert.equal(order.courier.toLowerCase(), courier.toLowerCase());
  }
});

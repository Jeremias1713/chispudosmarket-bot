// FASE 3: cubre H07 (una guia con aviso fallido desaparece del siguiente
// cruce), H18 (faltan coincidencias legitimas por etapa/nombre intercalado)
// y H05 (el cruce puede elegir a la persona equivocada) en dropanas.js.
'use strict';
const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('dropanas');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const dropanas = require('../src/dropanas');

after(() => cleanup(dataDir));

function sesion(overrides) {
  return {
    step: 'IDLE',
    cart: [],
    history: [],
    name: null,
    stage: 'vendido',
    stageLocked: false,
    stageReason: null,
    paused: false,
    pausedReason: null,
    card: { nombre: null, ciudad: null, telefono: null, cedula: null, producto: null, notas: null },
    adCode: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

test('H07 (reparado) - una guia guardada pero con el aviso FALLIDO (shippingNotifiedAt sin setear) sigue siendo candidata', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': sesion({ card: { nombre: 'Carlos Perez', guia: 'GU-000112' } }), // sin shippingNotifiedAt: el aviso nunca se confirmo
  }));

  const candidatos = dropanas.candidateSessions('GU-000112');
  assert.equal(candidatos.length, 1, 'BUG H07 si esto da 0: la guia con aviso fallido desaparecio del cruce');
});

test('H07 (reparado) - una guia guardada CON el aviso ya confirmado (shippingNotifiedAt) ya no es candidata para la misma guia', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': sesion({
      card: { nombre: 'Carlos Perez', guia: 'GU-000112' },
      shippingNotifiedAt: '2026-08-02T10:00:00.000Z',
    }),
  }));

  const candidatos = dropanas.candidateSessions('GU-000112');
  assert.equal(candidatos.length, 0);
});

test('H18 (reparado) - una conversacion en etapa "interesado" (no en SOLD_STAGES) ahora SI es candidata', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': sesion({ stage: 'interesado', card: { nombre: 'Jose Velasquez' } }),
  }));

  const resultado = dropanas.matchRow({ guia: 'GU-999', cliente: 'Jose Velasquez', ciudad: '', producto: '' });
  assert.equal(resultado.matchType, 'exacto', 'BUG H18 si esto da sin_match: se descarto solo por la etapa');
});

test('H18 (reparado) - un segundo nombre intercalado en la ficha SI matchea "exacto" contra el Excel', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': sesion({ card: { nombre: 'Jose Gregorio Velasquez' } }),
  }));

  const resultado = dropanas.matchRow({ guia: 'GU-999', cliente: 'Jose Velasquez', ciudad: '', producto: '' });
  assert.equal(resultado.matchType, 'exacto');
  assert.equal(resultado.phone, '584120000001');
});

test('H05 (reparado) - "Ana" contra dos sesiones parecidas ("Ana María"/"Ana Isabel") queda "ambiguo", nunca "exacto"', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': sesion({ card: { nombre: 'Ana María' } }),
    '584120000002': sesion({ card: { nombre: 'Ana Isabel' } }),
  }));

  const resultado = dropanas.matchRow({ guia: 'GU-999', cliente: 'Ana', ciudad: '', producto: '' });
  assert.equal(resultado.matchType, 'ambiguo');
  assert.equal(resultado.candidates.length, 2);
});

test('entregado sigue excluido (no hace falta seguir cruzando un pedido ya entregado)', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': sesion({ stage: 'entregado', card: { nombre: 'Ana María' } }),
  }));

  const resultado = dropanas.matchRow({ guia: 'GU-999', cliente: 'Ana María', ciudad: '', producto: '' });
  assert.equal(resultado.matchType, 'sin_match');
});

// Nuevo: desplegable manual para filas "sin_match" (a pedido del negocio,
// para cuando el nombre en Dropanas no se parece en nada al guardado en el
// bot y ninguna comparacion automatica lo va a encontrar sola).
test('listAllCandidates() - trae todas las conversaciones no entregadas, ordenadas por nombre', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': sesion({ stage: 'vendido', card: { nombre: 'Zoraida Perez' } }),
    '584120000002': sesion({ stage: 'interesado', card: { nombre: 'Ana Maria' } }),
    '584120000003': sesion({ stage: 'entregado', card: { nombre: 'Beto Gomez' } }),
  }));

  const lista = dropanas.listAllCandidates();
  assert.deepEqual(lista.map((c) => c.phone), ['584120000002', '584120000001'], 'BUG si aparece el entregado o el orden no es alfabetico');
  assert.equal(lista[0].name, 'Ana Maria');
});

test('listAllCandidates() - una conversacion sin nombre en la ficha ni de whatsapp no rompe el orden', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584120000001': sesion({ stage: 'vendido', card: { nombre: null } }),
    '584120000002': sesion({ stage: 'vendido', card: { nombre: 'Ana Maria' } }),
  }));

  const lista = dropanas.listAllCandidates();
  assert.equal(lista.length, 2);
  // Nombre vacio ('' al comparar) ordena primero que cualquier nombre real.
  assert.equal(lista[0].name, null);
  assert.equal(lista[1].name, 'Ana Maria');
});

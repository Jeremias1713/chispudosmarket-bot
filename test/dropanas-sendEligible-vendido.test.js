// FASE 3f: BUG encontrado -- matchRow() exigia session.stage === 'esperando_guia'
// EXACTO para marcar sendEligible=true, pero esa etapa es de uso MANUAL (se
// fija a mano desde el panel, ver classifier.js): un pedido recien vendido
// se queda en "vendido" hasta que se le carga la guia, nunca pasa solo por
// "esperando_guia". Con el chequeo viejo, el aviso automatico de "guia
// recien generada" (webhook Dropanas + DROPANAS_AUTO_SEND_ENABLED=true)
// nunca se disparaba en el uso real -- el operador nunca ve el mensaje
// salir solo, aunque el resto del cruce (encontrar el telefono correcto)
// funcione perfecto. Estas pruebas reproducen el bug tanto para el match
// por telefono como por nombre, y confirman que "vendido" ahora tambien
// habilita el envio (igual que "esperando_guia"), sin romper el caso de
// una etapa mas avanzada (en_camino) que sigue sin ser elegible aca (ese
// pedido ya tiene guia, no es la primera).
'use strict';
const { setupTempDataDir, writeRaw, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('dropanas-sendEligible-vendido');
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

test('BUG - matchRow por TELEFONO: un pedido "vendido" (normal, recien cerrado, sin marcar a mano) SI queda sendEligible', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584130000010': sesion({ stage: 'vendido', card: { nombre: 'Carla Diaz', telefono: '584130000010' } }),
  }));

  const resultado = dropanas.matchRow({ guia: 'GU-300', cliente: 'Carla Diaz', telefono: '0413-0000010' });

  assert.equal(resultado.matchType, 'exacto');
  assert.equal(resultado.matchEvidence, 'telefono');
  assert.equal(resultado.shippingStage, 'vendido');
  assert.equal(
    resultado.sendEligible,
    true,
    'BUG: un pedido recien vendido (nunca marcado a mano como "esperando_guia") no podia recibir el aviso automatico de guia generada'
  );
});

test('BUG - matchRow por NOMBRE: un pedido "vendido" tambien queda sendEligible', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584130000011': sesion({ stage: 'vendido', card: { nombre: 'Ramon Blanco' } }),
  }));

  const resultado = dropanas.matchRow({ guia: 'GU-301', cliente: 'Ramon Blanco', ciudad: '', producto: '' });

  assert.equal(resultado.matchType, 'exacto');
  assert.equal(resultado.shippingStage, 'vendido');
  assert.equal(resultado.sendEligible, true, 'BUG: el match por nombre tampoco habilitaba el envio para "vendido"');
});

test('"esperando_guia" (fijada a mano) sigue quedando sendEligible, como antes', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584130000012': sesion({ stage: 'esperando_guia', stageLocked: true, card: { nombre: 'Nora Perez', telefono: '584130000012' } }),
  }));

  const resultado = dropanas.matchRow({ guia: 'GU-302', cliente: 'Nora Perez', telefono: '0413-0000012' });

  assert.equal(resultado.sendEligible, true);
});

test('un pedido que YA esta "en_camino" (ya tiene guia, no es la primera) sigue sin ser sendEligible aca', () => {
  writeRaw(dataDir, 'sessions.json', JSON.stringify({
    '584130000013': sesion({ stage: 'en_camino', card: { nombre: 'Tito Suarez', telefono: '584130000013', guia: 'GU-VIEJA' } }),
  }));

  const resultado = dropanas.matchRow({ guia: 'GU-303', cliente: 'Tito Suarez', telefono: '0413-0000013' });

  assert.equal(resultado.sendEligible, false);
});

// FASE 1 (H02): antes, la IA veia y podia "mostrar" con la herramienta
// mostrar_foto CUALQUIER imagen de la biblioteca, incluidas las fotos de
// "Guias de envio" (comprobante de envio de UN PEDIDO PUNTUAL, subido con el
// nombre "Guia de envio - <telefono>" desde el panel, ver web/panel.js). Como
// findImageByName hace match parcial por nombre, un cliente que le pidiera al
// bot "mandame mi guia" (o algo parecido) podia terminar recibiendo la guia
// -con datos- de OTRO pedido/cliente. Ahora esas fotos quedan totalmente
// invisibles para la IA: ni se listan en el prompt (libraryImagesText) ni se
// pueden resolver por nombre (findImageByName / mostrar_foto), aunque siguen
// existiendo normalmente en la biblioteca completa (listImages) para que el
// panel las siga mostrando.
'use strict';
const { setupTempDataDir, cleanup } = require('./helpers/tempDataDir');

const dataDir = setupTempDataDir('library-ai-hidden');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const library = require('../src/library');
const { libraryImagesText, findImageByName, runTool } = require('../src/ai');

after(() => cleanup(dataDir));

// Imagen normal de catalogo (tiene que seguir siendo visible para la IA).
const fotoProducto = library.addImage({
  buffer: Buffer.from('foto-de-producto-fake'),
  mime: 'image/jpeg',
  name: 'Shilajit 30 caps - frasco',
  folder: 'Catalogo',
});

// Guia de envio de un pedido puntual (tiene que quedar oculta para la IA).
const fotoGuia = library.addImage({
  buffer: Buffer.from('foto-de-guia-fake'),
  mime: 'image/jpeg',
  name: 'Guia de envio - 584120000001',
  folder: 'Guias de envio',
});

test('H02 - listAiVisibleImages() incluye las fotos normales pero excluye "Guias de envio"', () => {
  const visibles = library.listAiVisibleImages().map((i) => i.name);
  assert.ok(visibles.includes(fotoProducto.name), 'la foto de catalogo sigue visible para la IA');
  assert.ok(!visibles.includes(fotoGuia.name), 'BUG H02 corregido: la guia de envio NO aparece en las imagenes visibles para la IA');

  // La biblioteca COMPLETA (la que usa el panel) sigue teniendo ambas.
  const todas = library.listImages().map((i) => i.name);
  assert.ok(todas.includes(fotoProducto.name));
  assert.ok(todas.includes(fotoGuia.name), 'el panel sigue viendo la guia normalmente, solo se esconde de la IA');
});

test('H02 - libraryImagesText() (lo que ve el modelo en el prompt) no menciona ninguna guia de envio', () => {
  const texto = libraryImagesText();
  assert.ok(texto.includes(fotoProducto.name), 'la foto de catalogo si aparece en el prompt');
  assert.ok(!texto.includes('Guia de envio'), 'BUG H02 corregido: ninguna guia de envio aparece en el texto que ve el modelo');
});

test('H02 - findImageByName() nunca resuelve una guia de envio, ni por nombre exacto ni parcial', () => {
  assert.equal(findImageByName('Guia de envio - 584120000001'), null, 'nombre exacto de una guia: no se resuelve');
  assert.equal(findImageByName('guia de envio'), null, 'coincidencia parcial que matchearia el nombre de una guia: no se resuelve');
  assert.equal(findImageByName('584120000001'), null, 'buscar solo por el telefono (parte del nombre de la guia): tampoco se resuelve');

  // Control: una foto normal si se sigue resolviendo por nombre parcial.
  const encontrada = findImageByName('shilajit');
  assert.ok(encontrada, 'una foto de catalogo normal si se sigue encontrando por nombre parcial');
  assert.equal(encontrada.id, fotoProducto.id);
});

test('H02 - la herramienta mostrar_foto (la que usa el modelo en la charla) nunca puede mandar una guia de envio', () => {
  const resultado = runTool({
    function: {
      name: 'mostrar_foto',
      arguments: JSON.stringify({ nombre: 'Guia de envio - 584120000001' }),
    },
  });
  assert.equal(resultado.image, null, 'BUG H02 corregido: mostrar_foto nunca devuelve una imagen de "Guias de envio"');
  assert.match(resultado.content, /No se encontro ninguna imagen/, 'el modelo recibe el mismo mensaje de "no encontrada" que para cualquier nombre inexistente');

  // Control: una foto normal si se puede mostrar.
  const resultadoOk = runTool({
    function: {
      name: 'mostrar_foto',
      arguments: JSON.stringify({ nombre: 'Shilajit 30 caps - frasco' }),
    },
  });
  assert.ok(resultadoOk.image, 'una foto de catalogo normal si se puede mostrar con mostrar_foto');
  assert.equal(resultadoOk.image.id, fotoProducto.id);
});

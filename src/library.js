// Biblioteca de imagenes: fotos que el bot puede mandar (enganchadas al
// mensaje inicial de un producto, o a mano desde el panel). Se guardan como
// archivos sueltos en data/media/ y un indice en data/library.json con su
// nombre, mime y fecha. Todo gitignorado: dato de cada instancia, no del
// codigo, y con el mismo caveat de disco no persistente en el plan gratis
// de Render que sessions.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEDIA_DIR = path.join(__dirname, '..', 'data', 'media');
const LIBRARY_PATH = path.join(__dirname, '..', 'data', 'library.json');

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
}

function saveIndex(items) {
  fs.writeFileSync(LIBRARY_PATH, JSON.stringify(items, null, 2));
}

function listImages() {
  return loadIndex();
}

function getImage(id) {
  return loadIndex().find((i) => i.id === id) || null;
}

// buffer: Buffer del archivo subido (multer memoryStorage). name: como la
// va a nombrar el negocio (para reconocerla en la grilla y como referencia
// para el bot).
function addImage({ buffer, mime, name }) {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error('Formato no soportado. Usa JPG, PNG o WebP.');
  if (buffer.length > 5 * 1024 * 1024) throw new Error('La imagen pesa mas de 5 MB.');

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const id = crypto.randomBytes(8).toString('hex');
  const filename = `${id}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);

  const items = loadIndex();
  const item = { id, filename, mime, name: name || filename, createdAt: new Date().toISOString() };
  items.push(item);
  saveIndex(items);
  return item;
}

function deleteImage(id) {
  const items = loadIndex();
  const item = items.find((i) => i.id === id);
  if (!item) return false;
  try {
    fs.unlinkSync(path.join(MEDIA_DIR, item.filename));
  } catch (err) {
    // ya no estaba en disco, no importa
  }
  saveIndex(items.filter((i) => i.id !== id));
  return true;
}

function mediaPath(filename) {
  return path.join(MEDIA_DIR, filename);
}

module.exports = { listImages, getImage, addImage, deleteImage, mediaPath, MEDIA_DIR };

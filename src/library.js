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
// para el bot). folder: carpeta opcional para organizar la biblioteca (solo
// una etiqueta de texto, no una carpeta real en disco).
function addImage({ buffer, mime, name, folder }) {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error('Formato no soportado. Usa JPG, PNG o WebP.');
  if (buffer.length > 5 * 1024 * 1024) throw new Error('La imagen pesa mas de 5 MB.');

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const id = crypto.randomBytes(8).toString('hex');
  const filename = `${id}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);

  const items = loadIndex();
  const item = {
    id,
    filename,
    mime,
    name: name || filename,
    folder: folder ? String(folder).trim().slice(0, 60) || null : null,
    createdAt: new Date().toISOString(),
  };
  items.push(item);
  saveIndex(items);
  return item;
}

// Cambia el nombre y/o la carpeta de una imagen ya subida (no toca el
// archivo en disco, solo el indice).
function updateImage(id, patch) {
  const items = loadIndex();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...patch };
  saveIndex(items);
  return items[idx];
}

// Lista de carpetas ya usadas (para armar el selector sin tener que
// escribirla de nuevo cada vez).
function listFolders() {
  const set = new Set();
  for (const item of loadIndex()) {
    if (item.folder) set.add(item.folder);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'es'));
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

module.exports = { listImages, getImage, addImage, updateImage, deleteImage, listFolders, mediaPath, MEDIA_DIR };

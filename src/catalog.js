// Catalogo de productos: fuente de precios/nombres para la IA (ver ai.js) y
// ahora tambien editable en vivo desde el panel (CRUD completo). Se guarda en
// data/products.json (gitignorado: es dato de cada instancia, no del codigo).
// Si todavia no existe, se arranca vacio -no crashea- y el panel invita a
// cargar el primer producto.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'products.json');

function loadProducts() {
  let products;
  try {
    products = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
  // Normaliza introImageIds al leer (no solo al guardar): cubre productos
  // guardados antes de soportar varias fotos, que todavia tienen el campo
  // viejo introImageId (una sola imagen) en vez del array nuevo.
  return products.map((p) => ({
    ...p,
    introImageIds: normalizeImageIds(p.introImageIds && p.introImageIds.length ? p.introImageIds : p.introImageId),
  }));
}

function saveProducts(products) {
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(products, null, 2));
}

function blankProduct() {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    name: '',
    sku: '',
    price: 0,
    currency: 'Bs',
    description: '',
    active: true,
    // Instrucciones extra para la IA, solo cuando este producto esta activo.
    prompt: '',
    // Palabras que, si el cliente las escribe en su primer mensaje sobre este
    // producto, ligan la conversacion a el (ver flow.js).
    triggers: [],
    // Si hay mensaje inicial, sale TAL CUAL (sin pasar por la IA) apenas se
    // detecta un trigger.
    intro: '',
    // ids de imagenes de la biblioteca (ver library.js) para mandar junto
    // con el mensaje inicial. Puede ser mas de una: se mandan todas, una
    // detras de otra, y el texto va como caption de la ultima.
    introImageIds: [],
    // Oferta que la IA puede ofrecer una sola vez, justo cuando el cliente
    // ya dijo que si a este producto.
    upsell: '',
    // Remarketing automatico (ver remarketing.js): mensajes de recordatorio
    // que se mandan solos, TAL CUAL estan escritos aca (igual que "intro"),
    // si esta conversacion queda vinculada a este producto y se cuelga sin
    // novedad en una etapa que todavia no es una venta cerrada. El de 2h es
    // el primero, mas suave; el de 5h es el segundo, mas directo. Si se deja
    // vacio, no se manda nada para ese paso.
    remarketingEnabled: true,
    remarketing2h: '',
    remarketing5h: '',
  };
}

// Siempre devuelve un array de palabras limpias, venga como venga (array ya
// armado, o el string crudo separado por comas que manda el formulario). Se
// aplica tanto al guardar como al leer: si algun dato viejo o algun llamado
// futuro guarda un string en vez de un array, ACA se corrige, para que
// matchTrigger nunca termine iterando caracter por caracter de un string
// (eso hacia match con cualquier mensaje, un bug real que ya paso una vez
// con la busqueda de agencias por el mismo motivo: comparar texto crudo sin
// primero convertirlo en una lista de palabras).
function normalizeTriggers(value) {
  if (Array.isArray(value)) {
    return value.map((t) => String(t || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

// Igual que normalizeTriggers pero para los ids de imagenes: siempre
// devuelve un array de ids limpios (sin vacios ni duplicados), venga como
// venga (array, id suelto, o string separado por comas).
function normalizeImageIds(value) {
  const arr = Array.isArray(value) ? value : String(value || '').split(',');
  const clean = arr.map((v) => String(v || '').trim()).filter(Boolean);
  return [...new Set(clean)];
}

function findProduct(idOrName) {
  const products = loadProducts();
  const q = String(idOrName).trim().toLowerCase();
  return products.find(
    (p) =>
      p.id.toLowerCase() === q ||
      (p.name || '').toLowerCase() === q ||
      (p.sku || '').toLowerCase() === q
  );
}

function foldText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Palabras demasiado genericas como para servir de pista de que producto es
// (articulos, preposiciones): se ignoran al comparar, si no "de" o "con"
// harian "matchear" cualquier cosa con cualquier cosa.
const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'con', 'para']);

// Palabras "de verdad" de un nombre (sin stopwords ni palabras sueltas de 1-2
// letras que no aportan nada para reconocer el producto).
function significantWords(name) {
  return foldText(name)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Normaliza un texto libre de producto (lo que anota la IA en card.producto,
// ver classifier.js) contra el nombre EXACTO tal cual esta cargado en el
// catalogo. Sin esto, variantes como "shilajit", "Shilajit", "1 frasco de
// Shilajit", "combo de 2 frascos de Shilajit", "gomitas de shilajit" o
// "Shilajit Viking" quedaban como productos DISTINTOS en Metricas >
// Productos mas vendidos (se detecto con datos reales: mas de 13 variantes
// escritas para el mismo item), aunque sea siempre la misma venta.
// - Coincidencia exacta primero (insensible a mayusculas/acentos).
// - Si no hay exacta, se compara por PALABRAS: de cada producto del catalogo
//   se sacan sus palabras significativas (sin "de", "un", etc.) y se ve que
//   fraccion de esas palabras aparece en el texto a normalizar. Esto agarra
//   frases como "1 frasco de Shilajit" o "combo de 2 frascos de Shilajit"
//   (que NO son substring de "Shilajit Viking" ni al reves, por eso el
//   chequeo viejo de substring se quedaba corto), porque igual contienen la
//   palabra "shilajit". Se elige el producto con mayor fraccion de palabras
//   encontradas (y, en empate, el nombre mas largo/especifico).
// - Si no hay ningun match razonable, se devuelve el texto tal cual: puede
//   ser un producto que ya no esta en el catalogo, o algo que la IA anoto
//   raro — mejor dejarlo visible que perderlo silenciosamente.
function normalizeProductName(texto) {
  const limpio = String(texto || '').trim();
  if (!limpio) return limpio;
  const products = loadProducts();
  if (!products.length) return limpio;
  const q = foldText(limpio);
  const exacto = products.find((p) => p.name && foldText(p.name) === q);
  if (exacto) return exacto.name;

  let best = null;
  let bestScore = 0;
  for (const p of products) {
    if (!p.name) continue;
    const words = significantWords(p.name);
    if (!words.length) continue;
    const matched = words.filter((w) => q.includes(w)).length;
    const score = matched / words.length;
    if (score > bestScore || (score === bestScore && best && p.name.length > best.name.length)) {
      bestScore = score;
      best = p;
    }
  }
  // Se exige encontrar al menos la MITAD de las palabras significativas del
  // nombre de catalogo (no todas): "shilajit" solo trae una de las dos
  // palabras de "Shilajit Viking" (score 0.5) y por eso tiene que matchear
  // igual, pero un umbral de 0 (una sola palabra suelta alcanza) haria que
  // "de" o una palabra generica compartida matcheara cualquier cosa con
  // cualquier cosa -- por eso el filtro de STOPWORDS de arriba y este piso
  // de la mitad, no cero.
  return best && bestScore >= 0.5 ? best.name : limpio;
}

function findProductByIndex(index) {
  const products = loadProducts().filter((p) => p.active !== false);
  const i = parseInt(index, 10) - 1;
  if (Number.isNaN(i) || i < 0 || i >= products.length) return null;
  return products[i];
}

// Solo catalogo activo, para la IA y para el mensaje /catalogo.
function formatCatalog() {
  const products = loadProducts().filter((p) => p.active !== false);
  if (!products.length) {
    return 'Todavia no tenemos productos cargados. En un momento te confirmamos el detalle.';
  }
  const lines = products.map(
    (p, i) => `${i + 1}. *${p.name}* - ${Number(p.price).toFixed(2)} ${p.currency}\n   ${p.description}`
  );
  return (
    'Este es nuestro catalogo:\n\n' +
    lines.join('\n\n') +
    '\n\nResponde con el *numero* o *nombre* del producto que quieres pedir, o escribe *menu* para volver al inicio.'
  );
}

// Busca el primer producto activo cuyos triggers matcheen el texto (palabra
// completa, sin distinguir mayusculas/tildes simples).
function matchTrigger(text) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  const t = norm(text);
  if (!t) return null;

  const products = loadProducts()
    .map((p) => ({ ...p, triggers: normalizeTriggers(p.triggers) }))
    .filter((p) => p.active !== false && p.triggers.length);
  for (const p of products) {
    for (const trig of p.triggers) {
      const tt = norm(trig).trim();
      if (tt && t.includes(tt)) return p;
    }
  }
  return null;
}

function listProducts() {
  return loadProducts();
}

function createProduct(data) {
  const products = loadProducts();
  const product = { ...blankProduct(), ...data, id: blankProduct().id };
  product.triggers = normalizeTriggers(product.triggers);
  product.introImageIds = normalizeImageIds(product.introImageIds);
  products.push(product);
  saveProducts(products);
  return product;
}

function updateProduct(id, patch) {
  const products = loadProducts();
  const i = products.findIndex((p) => p.id === id);
  if (i === -1) return null;
  const merged = { ...products[i], ...patch, id };
  if (patch.triggers !== undefined) merged.triggers = normalizeTriggers(patch.triggers);
  if (patch.introImageIds !== undefined) merged.introImageIds = normalizeImageIds(patch.introImageIds);
  products[i] = merged;
  saveProducts(products);
  return products[i];
}

function deleteProduct(id) {
  const products = loadProducts();
  const next = products.filter((p) => p.id !== id);
  saveProducts(next);
  return next.length !== products.length;
}

module.exports = {
  loadProducts,
  findProduct,
  findProductByIndex,
  normalizeProductName,
  formatCatalog,
  matchTrigger,
  listProducts,
  createProduct,
  updateProduct,
  deleteProduct,
};

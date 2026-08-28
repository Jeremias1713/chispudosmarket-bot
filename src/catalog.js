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
  try {
    return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
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
    currency: 'USD',
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
    // id de una imagen de la biblioteca (ver library.js) para mandar junto
    // con el mensaje inicial.
    introImageId: null,
    // Oferta que la IA puede ofrecer una sola vez, justo cuando el cliente
    // ya dijo que si a este producto.
    upsell: '',
  };
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

  const products = loadProducts().filter((p) => p.active !== false && (p.triggers || []).length);
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
  products.push(product);
  saveProducts(products);
  return product;
}

function updateProduct(id, patch) {
  const products = loadProducts();
  const i = products.findIndex((p) => p.id === id);
  if (i === -1) return null;
  products[i] = { ...products[i], ...patch, id };
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
  formatCatalog,
  matchTrigger,
  listProducts,
  createProduct,
  updateProduct,
  deleteProduct,
};

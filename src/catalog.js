const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'products.json');

function loadProducts() {
  const text = fs.readFileSync(CATALOG_PATH, 'utf8');
  return JSON.parse(text);
}

function findProduct(idOrName) {
  const products = loadProducts();
  const q = idOrName.trim().toLowerCase();
  return products.find(
    (p) =>
      p.id.toLowerCase() === q ||
      p.name.toLowerCase() === q ||
      p.sku.toLowerCase() === q
    );
}

function formatCatalog() {
  const products = loadProducts();
  const lines = products.map(
    (p, i) =>
      `${i + 1}. *${p.name}* - ${p.price.toFixed(2)} ${p.currency}\n   ${p.description}`
    );
  return (
    'Este es nuestro catalogo:\n\n' +
    lines.join('\n\n') +
    '\n\nResponde con el *numero* o *nombre* del producto que quieres pedir, o escribe *menu* para volver al inicio.'
    );
}

function findProductByIndex(index) {
  const products = loadProducts();
  const i = parseInt(index, 10) - 1;
  if (Number.isNaN(i) || i < 0 || i >= products.length) return null;
  return products[i];
}

module.exports = { loadProducts, findProduct, findProductByIndex, formatCatalog };

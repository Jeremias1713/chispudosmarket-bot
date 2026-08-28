// Cupones/codigos de descuento: editable en vivo desde el panel, igual que el
// catalogo. Se guarda en data/coupons.json (gitignorado: es dato de cada
// instancia, no del codigo). Si todavia no existe, se arranca vacio -no
// crashea- y el panel invita a cargar el primer cupon.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COUPONS_PATH = path.join(__dirname, '..', 'data', 'coupons.json');

function loadCoupons() {
  try {
    return JSON.parse(fs.readFileSync(COUPONS_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
}

function saveCoupons(coupons) {
  fs.writeFileSync(COUPONS_PATH, JSON.stringify(coupons, null, 2));
}

function blankCoupon() {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    code: '',
    discountPercent: 0,
    description: '',
    active: true,
    createdAt: new Date().toISOString(),
  };
}

function listCoupons() {
  return loadCoupons();
}

function createCoupon(patch) {
  const coupons = loadCoupons();
  const coupon = { ...blankCoupon(), ...patch, id: blankCoupon().id, createdAt: new Date().toISOString() };
  coupons.push(coupon);
  saveCoupons(coupons);
  return coupon;
}

function updateCoupon(id, patch) {
  const coupons = loadCoupons();
  const i = coupons.findIndex((c) => c.id === id);
  if (i === -1) return null;
  coupons[i] = { ...coupons[i], ...patch, id };
  saveCoupons(coupons);
  return coupons[i];
}

function deleteCoupon(id) {
  const coupons = loadCoupons();
  const next = coupons.filter((c) => c.id !== id);
  saveCoupons(next);
  return next.length !== coupons.length;
}

module.exports = {
  listCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
};

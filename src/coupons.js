// Cupones/codigos de descuento: editable en vivo desde el panel, igual que el
// catalogo. Se guarda en data/coupons.json (gitignorado: es dato de cada
// instancia, no del codigo). Si todavia no existe, se arranca vacio -no
// crashea- y el panel invita a cargar el primer cupon.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./dataDir');

const COUPONS_PATH = path.join(DATA_DIR, 'coupons.json');

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

// Fase 7C: cupon por retiro rapido. Codigo unico RETIRO-XXXXXX, ligado al
// telefono del cliente y con vencimiento; se usa una sola vez.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para dictarlo sin errores

function newCode(existing) {
  for (let i = 0; i < 20; i += 1) {
    const bytes = crypto.randomBytes(6);
    const code = `RETIRO-${[...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')}`;
    if (!existing.some((c) => c.code === code)) return code;
  }
  throw new Error('No se pudo generar un codigo de cupon unico.');
}

function createQuickPickupCoupon({ phone, discountPercent, validDays, now = new Date() }) {
  const coupons = loadCoupons();
  const coupon = {
    ...blankCoupon(),
    code: newCode(coupons),
    discountPercent: Number(discountPercent),
    description: 'Retiro rapido',
    kind: 'quick_pickup',
    phone: String(phone),
    expiresAt: new Date(now.getTime() + Number(validDays) * 86400000).toISOString(),
    usedAt: null,
  };
  coupons.push(coupon);
  saveCoupons(coupons);
  return coupon;
}

// Valida (y, con redeem:true, consume) un cupon de retiro rapido: debe estar
// activo, no vencido, sin usar y pertenecer al MISMO telefono.
function redeemQuickPickup(code, phone, { redeem = true, now = new Date() } = {}) {
  const coupons = loadCoupons();
  const i = coupons.findIndex((c) => c.code === String(code || '').trim().toUpperCase() && c.kind === 'quick_pickup');
  if (i === -1) return { ok: false, reason: 'no_existe' };
  const c = coupons[i];
  if (c.usedAt || c.active === false) return { ok: false, reason: 'ya_usado' };
  if (c.expiresAt && new Date(c.expiresAt) < now) return { ok: false, reason: 'vencido' };
  if (String(c.phone) !== String(phone)) return { ok: false, reason: 'otro_telefono' };
  if (redeem) {
    coupons[i] = { ...c, usedAt: now.toISOString(), active: false };
    saveCoupons(coupons);
  }
  return { ok: true, coupon: coupons[i] };
}

module.exports = {
  createQuickPickupCoupon,
  redeemQuickPickup,
  listCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
};

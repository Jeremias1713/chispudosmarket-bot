'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { getSession, updateSession, listSessions } = require('./state');
const settingsStore = require('./settings');
const dropanasApi = require('./dropanasApi');
const { SOLD_STAGES } = require('./stageRules');
const agencies = require('./agencies');
const catalog = require('./catalog');

const CACHE_MS = 5 * 60 * 1000;
// Etapas que normalmente significan que el pedido ya salió por DroPanas.
// OJO: el clasificador por IA a veces salta directo a estas etapas en una
// venta recién cerrada (ver flow.js), así que la etapa sola NO bloquea: solo
// genera un aviso. Lo que sí bloquea es tener una guía cargada.
const DISPATCHED_STAGES = ['tienda_maracaibo', 'esperando_retiro', 'en_camino', 'novedad', 'pendiente_devolucion', 'entregado'];
// Un intento que quedó en "subiendo" más de este tiempo se considera cortado
// (por ejemplo, el servicio se reinició a mitad del envío).
const STALE_UPLOAD_MS = 2 * 60 * 1000;
// Ningún frasco se vende por debajo de esto: un precio menor casi siempre es
// un monto mal escrito (por ejemplo "51.900" leído como 51,9).
const MIN_UNIT_PRICE_VES = 1000;
// Reintentos del modo automático: cada cuánto y cuántas veces como máximo.
const AUTO_RETRY_MS = 10 * 60 * 1000;
const AUTO_RETRY_MAX = 5;
let cache = null;
let cachePromise = null;
// Sube con cada guardado de configuración: una validación que empezó con la
// configuración vieja no puede dejar su resultado guardado en caché.
let configVersion = 0;
// Caché de estados/ciudades de DroPanas. Solo guarda respuestas buenas y por
// un tiempo limitado: un error (por ejemplo un 403 de hoy) nunca queda fijo.
const geoCache = new Map();
const locks = new Set();
let autoRetryTimer = null;

function fold(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function defaultMappings() {
  return [
    { id: 'turkesterone', label: 'Turkesterone', aliases: ['turkesterone'], productId: 20702, warehouseId: 1, prices: { 1: 39900 }, enabled: true },
    { id: 'shilajit', label: 'Shilajit Viking', aliases: ['shilajit', 'shilajit viking'], productId: 20343, warehouseId: 1, prices: { 1: 36900, 2: 51900 }, enabled: true },
    { id: 'shilajit-resina', label: 'Shilajit Resina', aliases: ['shilajit resina', 'shilajit de resina', 'resina shilajit'], productId: 20448, warehouseId: 1, prices: { 1: 36900, 2: 51900 }, enabled: true },
  ];
}

function settings() {
  const current = settingsStore.getSettings();
  const defaults = defaultMappings();
  const stored = Array.isArray(current.dropanasOrderMappings) ? current.dropanasOrderMappings : [];
  // Migración puntual: si ya se había guardado la configuración anterior,
  // incorpora Resina sin borrar precios o alias personalizados del operador.
  const resin = defaults.find((row) => row.id === 'shilajit-resina');
  const mappings = stored.length
    ? [...stored, ...(stored.some((row) => row.id === resin.id || Number(row.productId) === resin.productId) ? [] : [resin])]
    : defaults;
  return {
    uploadEnabled: Boolean(current.dropanasOrderUploadEnabled),
    autoCreateEnabled: Boolean(current.dropanasOrderAutoCreateEnabled),
    activatedAt: current.dropanasOrderActivatedAt || null,
    mappings,
  };
}

// FASE 3g: antes, el ÚNICO lugar donde un producto podía quedar vinculado a
// DroPanas era esta tabla de mapeo manual (3 productos hardcodeados de
// arranque, o los que el operador cargara a mano, duplicando nombre/precio
// que YA estaban cargados en el catálogo normal del bot, ver catalog.js).
// Cualquier producto real que no estuviera en esa lista separada quedaba
// SIEMPRE bloqueado ("no tiene un mapeo único a DroPanas"), sin importar que
// el catálogo tuviera el producto perfectamente cargado.
//
// Ahora, cualquier producto ACTIVO del catálogo que ya tenga cargado su
// dropanasProductId (ver catalog.js/blankProduct) se suma solo como un
// mapeo mas, usando el nombre y los precios que ya están en el catálogo.
// No se guarda nada nuevo en la configuración de este módulo: se calcula al
// vuelo cada vez, así que un cambio de precio en el catálogo se refleja acá
// sin tocar nada más. Si el operador YA definió a mano un mapeo con el
// MISMO id de producto DroPanas (tabla de "Subir pedidos" del panel), ese
// mapeo manual gana -- se respetan los alias/precios que haya ajustado.
//
// Esto se calcula aparte de settings() (y no se mezcla en config.mappings)
// para no ensuciar la tabla editable del panel: esos mapeos "del catálogo"
// no son filas para editar ahí, se editan en el catálogo de productos de
// siempre.
function catalogMappings(existingProductIds) {
  return catalog.listProducts()
    .filter((p) => p.active !== false)
    .filter((p) => {
      const id = Number(p.dropanasProductId);
      return Number.isInteger(id) && id > 0 && !existingProductIds.has(id);
    })
    .map((p) => {
      const prices = {};
      const basePrice = Number(p.price);
      if (Number.isFinite(basePrice) && basePrice > 0) prices[1] = basePrice;
      for (const row of catalog.normalizeQuantityPrices(p.quantityPrices)) prices[row.quantity] = row.total;
      const warehouseId = Number(p.dropanasWarehouseId);
      return {
        id: `catalogo-${p.id}`,
        label: p.name,
        aliases: [p.name],
        productId: Number(p.dropanasProductId),
        warehouseId: Number.isInteger(warehouseId) && warehouseId > 0 ? warehouseId : 1,
        prices,
        enabled: true,
      };
    });
}

// Mapeos manuales + los que salen solos del catálogo -- esta es la lista
// completa que se usa de verdad para encontrar a qué producto de DroPanas
// corresponde cada línea de un pedido (findMapping) y para saber qué
// productos/bodegas validar contra la API (snapshot). config.mappings (lo
// que devuelve settings(), y lo que edita el panel) sigue siendo SOLO la
// tabla manual, a propósito.
function matchableMappings(config = settings()) {
  const manual = Array.isArray(config?.mappings) ? config.mappings : [];
  const existingProductIds = new Set(
    manual.map((row) => Number(row.productId)).filter((id) => Number.isInteger(id) && id > 0)
  );
  return [...manual, ...catalogMappings(existingProductIds)];
}

function normalizeMapping(row, index) {
  const productId = Number(row?.productId);
  const warehouseId = Number(row?.warehouseId || 1);
  const prices = {};
  for (const [quantity, total] of Object.entries(row?.prices || {})) {
    const q = Number(quantity);
    const value = Number(total);
    if (Number.isInteger(q) && q > 0 && Number.isFinite(value) && value > 0) prices[q] = value;
  }
  return {
    id: String(row?.id || `producto-${index + 1}`).trim(),
    label: String(row?.label || '').trim(),
    aliases: [...new Set((Array.isArray(row?.aliases) ? row.aliases : String(row?.aliases || '').split(','))
      .map((item) => String(item || '').trim()).filter(Boolean))],
    productId: Number.isInteger(productId) && productId > 0 ? productId : null,
    warehouseId: Number.isInteger(warehouseId) && warehouseId > 0 ? warehouseId : 1,
    prices,
    enabled: row?.enabled !== false,
  };
}

function validateConfig(input) {
  const mappings = (Array.isArray(input?.mappings) ? input.mappings : []).map(normalizeMapping);
  const errors = [];
  if (!mappings.length) errors.push('Agrega al menos un producto.');
  for (const row of mappings) {
    if (!row.label) errors.push('Cada producto necesita un nombre visible.');
    if (!row.productId) errors.push(`${row.label || row.id}: falta el ID de producto DroPanas.`);
    if (!row.aliases.length) errors.push(`${row.label || row.id}: agrega al menos un alias.`);
    if (!Object.keys(row.prices).length) errors.push(`${row.label || row.id}: agrega al menos un precio por cantidad.`);
  }
  return { mappings, errors };
}

function saveConfig(input) {
  const { mappings, errors } = validateConfig(input);
  if (errors.length) throw new Error(errors.join(' '));
  const previous = settings();
  const uploadEnabled = Boolean(input.uploadEnabled);
  const autoCreateEnabled = uploadEnabled && Boolean(input.autoCreateEnabled);
  let activatedAt = previous.activatedAt;
  if (autoCreateEnabled && !previous.autoCreateEnabled) activatedAt = new Date().toISOString();
  if (!autoCreateEnabled) activatedAt = null;
  settingsStore.updateSettings({
    dropanasOrderUploadEnabled: uploadEnabled,
    dropanasOrderAutoCreateEnabled: autoCreateEnabled,
    dropanasOrderActivatedAt: activatedAt,
    dropanasOrderMappings: mappings,
  });
  configVersion += 1;
  cache = null;
  cachePromise = null;
  geoCache.clear();
  return settings();
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { nombre: parts.slice(0, -1).join(' '), apellido: parts.at(-1) };
}

function localPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('58') && digits.length === 12) digits = `0${digits.slice(2)}`;
  if (digits.length === 10 && digits.startsWith('4')) digits = `0${digits}`;
  return /^0(?:412|414|416|422|424|426)\d{7}$/.test(digits) ? digits : null;
}

function findMapping(productName, mappings) {
  const value = fold(productName);
  if (!value) return null;
  const matches = mappings.filter((row) => row.enabled).map((row) => {
    const score = Math.max(0, ...[row.label, ...(row.aliases || [])]
      .map((alias) => {
      const normalized = fold(alias);
      if (!normalized) return 0;
      if (value === normalized) return 10000 + normalized.length;
      if (value.includes(normalized)) return normalized.length;
      if (normalized.includes(value)) return Math.max(1, value.length - 1);
      return 0;
    }));
    return { row, score };
  }).filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score);
  if (!matches.length || (matches[1] && matches[0].score === matches[1].score)) return null;
  return matches[0].row;
}

// Devuelve los productos DISTINTOS (por ID de DroPanas) que se nombran dentro
// de un texto. Sirve para detectar un combo escrito en una sola línea
// ("Turkesterone + Shilajit Viking"), que antes se subía como un solo
// producto. Si un alias está contenido en otro más largo que también aparece
// ("shilajit" dentro de "shilajit resina"), cuenta solo el más largo.
function mentionedProducts(productName, mappings) {
  const text = ` ${fold(productName)} `;
  if (!text.trim()) return [];
  const found = [];
  for (const row of mappings.filter((item) => item.enabled)) {
    const aliases = [row.label, ...(row.aliases || [])].map(fold).filter(Boolean);
    const hit = aliases.filter((alias) => text.includes(` ${alias} `)).sort((a, b) => b.length - a.length)[0];
    if (hit) found.push({ row, alias: hit });
  }
  const kept = found.filter((item) => !found.some((other) => other !== item
    && other.alias.length > item.alias.length && ` ${other.alias} `.includes(` ${item.alias} `)));
  const byProduct = new Map();
  for (const item of kept) byProduct.set(Number(item.row.productId), item.row);
  return [...byProduct.values()];
}

// Tipo de documento a partir de la cédula tal como la dio el cliente.
// Sin prefijo se asume venezolano (V). Solo se aceptan V y E; cualquier otro
// prefijo (J, G, P...) se devuelve como null para que se revise a mano.
function documentType(rawCedula) {
  const match = String(rawCedula || '').trim().match(/^([A-Za-z])(?=[\s.\-]*\d)/);
  if (!match) return 'V';
  const type = match[1].toUpperCase();
  return type === 'V' || type === 'E' ? type : null;
}

function referenceFor(phone, soldAt) {
  if (!soldAt || Number.isNaN(new Date(soldAt).getTime())) return null;
  const stamp = String(soldAt).replace(/\D/g, '').slice(0, 14);
  return `CHISPUDOS-${String(phone).slice(-10)}-${stamp}`.slice(0, 80);
}

// dropanasOrder guardado en la sesión, separado en "el de ESTA venta" y "el
// de una venta anterior". Cada venta tiene su propia referencia (teléfono +
// fecha de cierre), así que un pedido de una compra vieja ya no bloquea ni
// presta su clave a una compra nueva del mismo cliente.
function splitStoredOrder(stored, reference) {
  if (!stored) return { current: null, previous: null };
  const sameSale = !stored.externalReference || (reference && stored.externalReference === reference);
  return sameSale ? { current: stored, previous: null } : { current: null, previous: stored };
}

// "Agencia: X" en cualquier linea, con o sin negritas, viñetas o guiones.
const LABELED_AGENCY = /(?:^|\n)[\s>*•\-]*\**\s*(?:agencia|oficina)(?:\s+de\s+retiro|\s+tealca)?\s*\**\s*:\s*\**\s*([^\n]+)/gi;

// Frases que el bot escribe despues de "agencia"/"oficina" y que NO son el
// nombre de una sucursal ("mas cercana", "dentro de los 5 dias habiles",
// "al momento de retirar", "cuando llegues a ...").
const NOT_AN_AGENCY = /^(?:(?:la )?mas (?:cercan|convenient|proxim)\w*|dentro|al momento|cuando|que|para|donde|hasta|durante|antes|despues|en|y|o|por|con|sin|si|tu|tus|su|sus|mi|mis|ese|esa|este|esta|elegida|seleccionada|de tu|de su|a tu|mas conveniente|indicada|correspondiente|a retirar|a buscar|pagar)\b/;

function cleanAgency(raw) {
  const text = String(raw || '')
    .replace(/\*+/g, '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s:;,.!?-]+$/, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim();
  const folded = fold(text);
  if (folded.length < 3 || folded.length > 70) return null;
  const core = folded.replace(/^(?:(?:oficina|agencia|sucursal|tealca|de|la|el)\s+)+/, '');
  if (NOT_AN_AGENCY.test(folded) || NOT_AN_AGENCY.test(core)) return null;
  // "Tealca" o "agencia" a secas no dicen cual sucursal.
  if (!folded.replace(/\b(?:oficina|agencia|sucursal|tealca|de|la|el)\b/g, '').trim()) return null;
  // Plazos y pasos del retiro, no lugares (salvo que parezca una direccion).
  if (/\b(?:dias?|habiles|retirar|retiro|pagar|pago|plazo|semanas?|horas?|confirmas?)\b/.test(folded)
    && !/\b(?:av|avenida|calle|cc|centro comercial|local|sector|urb|urbanizacion)\b/.test(folded)) return null;
  return text;
}

function historyOrderFacts(history = []) {
  let quantity = null;
  let total = null;
  let agency = null;
  const messages = Array.isArray(history) ? history : [];
  let previousAssistant = '';
  for (const message of messages) {
    const content = String(message?.content || '');
    const normalized = fold(content);
    if (message?.role === 'user') {
      const numeric = normalized.match(/\b([1-9]|[12]\d)\s*(?:frascos?|potes?|unidades?)\b/);
      const word = normalized.match(/\b(un|una|uno|dos|tres|cuatro|cinco)\s*(?:frascos?|potes?|unidades?)?\b/);
      const values = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };
      if (numeric) quantity = Number(numeric[1]);
      else if (word && (/frasco|pote|unidad|combo|llevo|quiero|necesito/.test(normalized))) quantity = values[word[1]];
      else if (/cuantos?|cantidad|frascos?|potes?/.test(fold(previousAssistant))) {
        const short = normalized.match(/^(?:solo\s+)?(1|2|3|un|una|uno|dos|tres)(?:\s+para\s+probar)?$/);
        if (short) quantity = Number(short[1]) || values[short[1]];
      }
    }
    const moneyMatches = [...content.matchAll(/(\d{1,3}(?:[.,]\d{3})+|\d{4,6})\s*(?:Bs\.?|bol[ií]vares)/gi)];
    if (message?.role !== 'user' && moneyMatches.length) {
      const raw = moneyMatches.at(-1)[1];
      total = Number(raw.replace(/[.,](?=\d{3}(?:\D|$))/g, '').replace(',', '.')) || total;
    }
    if (message?.role !== 'user') {
      // 1) Lo mas confiable: el campo del resumen del pedido ("Agencia: X",
      //    "**Agencia:** X", "Oficina de retiro: X").
      const labeled = [...content.matchAll(LABELED_AGENCY)]
        .map((found) => cleanAgency(found[1]))
        .filter(Boolean);
      if (labeled.length) {
        agency = labeled.at(-1);
      } else {
        // 2) Frases como "retirar en la agencia de X". Solo cuentan si lo que
        //    sigue es de verdad un nombre de sucursal: antes "retirar y pagar
        //    en la agencia dentro de los 5 dias habiles" pisaba la agencia
        //    confirmada con "dentro de los 5 dias habiles".
        const isAgencyConfirmation = !/(^|\n)\s*\d+[.)]\s/.test(content)
          && /reserv|apart|retir|retiro|envi|entreg|resumen|pedido/i.test(content);
        const match = content.match(/(?:retirar|retiro)\s+en\s+(?:la\s+)?agencia\s+(?:de\s+)?([^\n.!?]+)/i)
          || (isAgencyConfirmation
            ? content.match(/(?:para|en)\s+(?:la\s+)?agencia(?:\s+tealca)?\s+(?:de\s+)?([^\n.!?,;]+)/i)
            : null);
        const candidate = match ? cleanAgency(match[1]) : null;
        if (candidate) agency = candidate;
      }
      previousAssistant = content;
    }
  }
  return { quantity, total, agency };
}

function baseDraft(phone, session, config = settings()) {
  const card = session.card || {};
  const order = session.currentOrder || {};
  const historyFacts = historyOrderFacts(session.history);
  const name = card.nombre || session.name || '';
  const identity = splitName(name);
  const structuredItems = Array.isArray(order.items) && order.items.length
    ? order.items
    : Array.isArray(card.productos) && card.productos.length ? card.productos : null;
  const rawItems = structuredItems || [{
    product: order.product || card.producto || '',
    quantity: order.quantity || historyFacts.quantity,
    total: order.total ?? card.monto,
  }];
  const mappingPool = matchableMappings(config);
  const reference = referenceFor(phone, session.soldAt);
  const { current, previous } = splitStoredOrder(session.dropanasOrder || null, reference);
  const items = rawItems.map((row) => {
    const productName = String(row?.product || row?.producto || row?.nombre || '').trim();
    const mapping = findMapping(productName, mappingPool);
    const quantity = Number(row?.quantity ?? row?.cantidad ?? 0);
    const explicitTotal = Number(row?.total ?? row?.monto);
    const mappedTotal = Number(mapping?.prices?.[quantity] || 0);
    const total = Number.isFinite(explicitTotal) && explicitTotal > 0 ? explicitTotal : mappedTotal;
    const mentioned = mentionedProducts(productName, mappingPool);
    return { productName, mapping, quantity, total, mentioned };
  });
  const productName = items.map((item) => item.productName).filter(Boolean).join(' + ');
  const mapping = items.length === 1 ? items[0].mapping : null;
  const quantity = items.length === 1 ? items[0].quantity : items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const total = items.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
  const agency = String(order.agency || card.agenciaConfirmadaEnChat || card.agencia || historyFacts.agency || '').trim();
  const issues = [];
  if (session.orderClosed !== true && !SOLD_STAGES.includes(session.stage || '')) {
    issues.push('La compra todavía no está confirmada.');
  }
  if (!session.soldAt || Number.isNaN(new Date(session.soldAt).getTime())) {
    issues.push('Falta una fecha válida de cierre de la venta.');
  }
  if (!identity) issues.push('Falta nombre y apellido.');
  if (!String(card.cedula || '').replace(/\D/g, '').match(/^\d{6,9}$/)) issues.push('Falta una cédula válida.');
  const docType = documentType(card.cedula);
  if (!docType) issues.push('La cédula tiene un prefijo que DroPanas no recibe (solo V o E). Revísala en la ficha.');
  if (!localPhone(card.telefono || phone)) issues.push('Falta un teléfono venezolano válido.');
  if (!items.length) issues.push('El pedido no contiene productos.');
  for (const item of items) {
    const label = item.productName || 'Producto sin nombre';
    if (!item.mapping) issues.push(`${label}: no tiene un mapeo único a DroPanas.`);
    if (!Number.isInteger(item.quantity) || item.quantity < 1) issues.push(`${label}: falta confirmar la cantidad.`);
    if (!item.total) issues.push(`${label}: falta configurar el precio para esa cantidad.`);
    if (item.mentioned.length > 1) {
      issues.push(`${label}: parece un combo de varios productos (${item.mentioned.map((row) => row.label).join(' + ')}). Cárgalo como productos separados antes de subirlo.`);
    }
    if (item.total && Number.isInteger(item.quantity) && item.quantity > 0) {
      const unit = item.total / item.quantity;
      if (unit < MIN_UNIT_PRICE_VES) {
        issues.push(`${label}: el precio por unidad (${unit} Bs) es demasiado bajo; revisa el monto (¿se escribió con punto de miles?).`);
      } else if (Math.abs(Math.round(unit * 100) / 100 * item.quantity - item.total) > 0.005) {
        issues.push(`${label}: el total ${item.total} Bs no se puede repartir en partes iguales entre ${item.quantity} unidades.`);
      }
    }
  }
  // El monto cargado a mano en la ficha es lo que se acordó con el cliente.
  // Si no coincide con lo que se va a cobrar contra entrega, no se sube.
  const agreed = card.monto == null || card.monto === '' ? null : Number(card.monto);
  if (agreed != null && Number.isFinite(agreed) && agreed > 0 && total > 0 && Math.abs(agreed - total) >= 1) {
    issues.push(`El monto de la ficha (${agreed} Bs) no coincide con el total que se cobraría (${total} Bs). Corrige el monto o la tabla de precios.`);
  }
  const warehouses = new Set(items.map((item) => item.mapping?.warehouseId).filter(Boolean));
  if (warehouses.size > 1) issues.push('Todos los productos del pedido deben salir de la misma bodega.');
  if (!agency) issues.push('Falta confirmar una oficina de retiro.');
  // Notas para revisar antes de subir. Van aparte de warnings para que el
  // borrador base siga sin advertencias de DroPanas.
  const attemptNotes = [];
  if (current?.id) {
    issues.push(`Ya fue subido como pedido #${current.id}.`);
  } else if (String(card.guia || '').trim()) {
    // Protección contra duplicados: una venta con guía ya existe en DroPanas
    // (aunque se haya cargado a mano, fuera de esta bandeja).
    issues.push(`Esta venta ya tiene guía (${String(card.guia).trim()}): el pedido ya existe en DroPanas.`);
  } else if (DISPATCHED_STAGES.includes(session.stage || '')) {
    attemptNotes.push(`Esta venta figura en etapa "${session.stage}" sin guía cargada. Si ya la cargaste a mano en DroPanas, NO la subas de nuevo.`);
  }
  if (current?.id && current.warning) attemptNotes.push(current.warning);
  if (current && !current.id) {
    const startedAt = new Date(current.attemptedAt || 0).getTime();
    if (current.status === 'subiendo' && Date.now() - startedAt < STALE_UPLOAD_MS) {
      issues.push('Este pedido se está subiendo en este momento.');
    } else if (current.status === 'subiendo') {
      attemptNotes.push('Un intento anterior quedó cortado sin respuesta de DroPanas. Revisa en DroPanas que el pedido no exista antes de reintentar (se reenvía con la misma clave para evitar duplicados).');
    } else if (current.status === 'error' && current.error) {
      attemptNotes.push(current.requestMaybeSent
        ? `El intento anterior falló después de enviarse (${current.error}). Revisa en DroPanas que el pedido no exista antes de reintentar (se reenvía con la misma clave para evitar duplicados).`
        : `El intento anterior no se pudo subir: ${current.error}`);
    }
  }
  return {
    phone, name, identity, cedula: String(card.cedula || '').replace(/\D/g, ''),
    documentType: docType,
    customerPhone: localPhone(card.telefono || phone), productName, mapping, items,
    quantity, total, agency, soldAt: session.soldAt || null, reference,
    current, previous, attemptNotes, issues,
  };
}

// Explica un error de DroPanas con lo que haga falta para saber de donde
// viene: el codigo de la API (ej. CROSS_MODE_OPERATION_FORBIDDEN) si responde
// JSON, o un bloqueo de firewall si vuelve una pagina HTML (por ejemplo
// Cloudflare), que no es un problema de permisos de la clave.
function describeApiError(error) {
  const response = error?.response;
  if (!response) return error?.code || error?.message || 'error';
  const data = response.data;
  const type = String(response.headers?.['content-type'] || '');
  const parts = [String(response.status)];
  if (data && typeof data === 'object') {
    const inner = typeof data.error === 'object' && data.error ? data.error : {};
    const code = inner.code || data.code || (typeof data.error === 'string' ? data.error : null);
    const message = inner.message || data.message;
    if (code) parts.push(String(code));
    if (message) parts.push(String(message).slice(0, 160));
    // Errores de validacion (422): "campo: detalle" de cada campo rechazado.
    const fields = data.errors && typeof data.errors === 'object' ? data.errors : inner.errors;
    if (fields && typeof fields === 'object') {
      const detail = Object.entries(fields).slice(0, 4)
        .map(([field, value]) => `${field}: ${[].concat(value).join(', ')}`)
        .join('; ');
      if (detail) parts.push(detail.slice(0, 300));
    }
  } else if (/html/i.test(type) || /^\s*</.test(String(data || ''))) {
    const firewall = response.headers?.['cf-ray'] ? 'firewall de Cloudflare' : 'firewall';
    parts.push(`respuesta HTML (${firewall}), no es un error de permisos de la API`);
  } else if (data) {
    parts.push(String(data).replace(/\s+/g, ' ').slice(0, 120));
  }
  return parts.join(' — ');
}

async function apiGet(endpoint, config, params) {
  let response;
  try {
    response = await axios.get(`${config.baseUrl}/${endpoint}`, {
      headers: dropanasApi.requestHeaders(config.token), params,
      timeout: config.timeoutMs, validateStatus: (status) => status >= 200 && status < 300,
    });
  } catch (error) {
    throw new Error(`GET /${endpoint}: ${describeApiError(error)}`);
  }
  const mode = String(response.headers['x-dropanas-mode'] || '').toLowerCase();
  if (mode !== config.tokenMode) throw new Error(`Modo DroPanas inesperado: ${mode || 'sin identificar'}`);
  return response.data?.data ?? response.data;
}

async function snapshot(config = dropanasApi.configFromEnv()) {
  dropanasApi.assertReadOnlyEnabled(config);
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (cachePromise) return cachePromise;
  const version = configVersion;
  cachePromise = (async () => {
    const pool = matchableMappings(settings());
    const productIds = [...new Set(pool.filter((m) => m.enabled).map((m) => Number(m.productId)).filter(Boolean))];
    const warehouseIds = [...new Set(pool.filter((m) => m.enabled).map((m) => Number(m.warehouseId)).filter(Boolean))];
    const productPromise = (async () => {
      try {
        return {
          rows: await Promise.all(productIds.map(async (id) => apiGet(`productos/${id}`, config))),
          warning: null,
        };
      } catch (detailError) {
        try {
          const catalog = await dropanasApi.fetchAll('productos', { config });
          return { rows: catalog.rows.filter((row) => productIds.includes(Number(row?.id))), warning: null };
        } catch (catalogError) {
          return {
            rows: [],
            warning: `DroPanas no permite validar el catálogo con esta clave (${detailError.message}; GET /productos: ${describeApiError(catalogError)}). Los IDs configurados se comprobarán al crear el pedido pendiente.`,
          };
        }
      }
    })();
    const officePromise = apiGet('oficinas', config, { carrier: 'tealca' })
      .then((rows) => ({ rows, warning: null }))
      .catch((error) => ({ rows: [], warning: error.message }));
    const [productResult, officeResult, inventoryResults] = await Promise.all([
      productPromise,
      officePromise,
      Promise.all(warehouseIds.map(async (id) => {
        try {
          return { warehouseId: id, rows: await apiGet(`bodegas/${id}/inventario`, config), warning: null };
        } catch (error) {
          return { warehouseId: id, rows: null, warning: error.message };
        }
      })),
    ]);
    const value = {
      products: productResult.rows,
      productWarning: productResult.warning,
      offices: Array.isArray(officeResult.rows) ? officeResult.rows : [],
      officeWarning: officeResult.warning,
      inventories: inventoryResults,
    };
    if (version === configVersion) cache = { at: Date.now(), value };
    return value;
  })();
  try {
    return await cachePromise;
  } finally {
    cachePromise = null;
  }
}

function resolveOffice(label, offices) {
  const query = fold(label);
  if (!query) return null;
  const matches = offices.filter((office) => {
    const name = fold(office.nombre);
    const address = fold(office.direccion);
    return (name && (query.includes(name) || name.includes(query))) || (address && query.length > 8 && address.includes(query));
  });
  return matches.length === 1 ? matches[0] : null;
}

function cachedGeo(key, load) {
  const hit = geoCache.get(key);
  if (hit && (!hit.at || Date.now() - hit.at < CACHE_MS)) return hit.promise;
  const entry = { at: null, promise: null };
  entry.promise = load().then((value) => {
    entry.at = Date.now();
    return value;
  }, (error) => {
    // Nunca dejar un error guardado: el próximo intento vuelve a consultar.
    if (geoCache.get(key) === entry) geoCache.delete(key);
    throw error;
  });
  geoCache.set(key, entry);
  return entry.promise;
}

async function apiGeoOffice(label, config) {
  const localMatches = agencies.searchByText(label, 10);
  if (localMatches.length !== 1) return null;
  const local = localMatches[0];
  const stateName = agencies.resolveStateForCity(`${local.name} ${local.address}`) || local.region;
  if (!stateName) return null;
  const states = await cachedGeo('estados', () => apiGet('geo/estados', config));
  const state = (Array.isArray(states) ? states : []).find((row) => fold(row.nombre) === fold(stateName));
  if (!state) return null;
  const stateId = Number(state.id);
  const cities = await cachedGeo(`ciudades-${stateId}`, () => apiGet(`geo/estados/${stateId}/ciudades`, config));
  const cityQuery = fold(local.name);
  const cityMatches = (Array.isArray(cities) ? cities : []).filter((row) => {
    const name = fold(row.nombre);
    return name && (name === cityQuery || name.includes(cityQuery) || cityQuery.includes(name));
  });
  if (cityMatches.length !== 1) return null;
  return {
    id: null,
    state_id: stateId,
    city_id: Number(cityMatches[0].id),
    nombre: local.name,
    direccion: local.address || local.name,
    assignedByDropanas: true,
  };
}

async function prepareDraft(phone, session = getSession(phone)) {
  const draft = baseDraft(phone, session);
  draft.warnings = [...(draft.attemptNotes || [])];
  if (draft.current?.id || draft.items.some((item) => !item.mapping) || !draft.agency) return draft;
  try {
    const live = await snapshot();
    if (live.productWarning) draft.warnings.push(live.productWarning);
    const officialItems = draft.items.map((item) => {
      const product = live.products.find((row) => Number(row?.id) === Number(item.mapping.productId));
      if (!product && !live.productWarning) draft.issues.push(`${item.mapping.label}: el producto ${item.mapping.productId} ya no existe en DroPanas.`);
      const inventory = live.inventories.find((row) => Number(row.warehouseId) === Number(item.mapping.warehouseId));
      let stock = null;
      if (Array.isArray(inventory?.rows)) {
        stock = inventory.rows.filter((row) => Number(row?.producto?.id) === Number(item.mapping.productId))
          .reduce((sum, row) => sum + Number(row.cantidad || 0), 0);
        if (stock < item.quantity) draft.issues.push(`${item.mapping.label}: inventario insuficiente; quedan ${stock}.`);
      } else {
        const warning = 'DroPanas no permite consultar el inventario con esta clave; el stock se comprobará al aprobar el pedido.';
        if (!draft.warnings.includes(warning)) draft.warnings.push(warning);
      }
      return { ...item, product, stock };
    });
    const localOfficeMatches = agencies.searchByText(draft.agency, 10);
    let office = resolveOffice(draft.agency, live.offices);
    if (!office && live.officeWarning) {
      try {
        office = await apiGeoOffice(draft.agency, dropanasApi.configFromEnv());
      } catch (error) {
        draft.warnings.push(`DroPanas no permitió validar la oficina (${live.officeWarning}; ${error.message}).`);
      }
    }
    if (!office && live.officeWarning && localOfficeMatches.length === 1) {
      draft.issues.push('La oficina sí existe en tu catálogo de Tealca, pero DroPanas bloqueó la consulta de su ID interno. Hace falta habilitar lectura de oficinas/ciudades en la API para subirla con seguridad.');
      draft.localOffice = localOfficeMatches[0];
    } else if (!office) {
      draft.issues.push('La oficina mencionada no coincide de forma única con el catálogo de Tealca.');
    }
    else if (office.assignedByDropanas) {
      draft.warnings.push('DroPanas no permite leer oficinas con esta clave: se enviará la ciudad confirmada y DroPanas asignará la oficina al despachar. Revísala antes de aprobar.');
    }
    draft.official = { items: officialItems, office };
  } catch (error) {
    draft.issues.push(`No se pudo validar con DroPanas: ${error.message}`);
  }
  return draft;
}

async function listDrafts() {
  const rows = listSessions().filter((session) => SOLD_STAGES.includes(session.stage || '') || session.orderClosed === true);
  const drafts = await Promise.all(rows.map((session) => prepareDraft(session.phone, session)));
  return drafts.sort((a, b) => new Date(b.soldAt || 0) - new Date(a.soldAt || 0));
}

function externalReference(draft) {
  const reference = referenceFor(draft.phone, draft.soldAt);
  if (!reference) throw new Error('No se puede identificar el pedido sin una fecha válida de cierre.');
  return reference;
}

function deterministicIdempotencyKey(reference) {
  const digest = crypto.createHash('sha256').update(String(reference)).digest('hex');
  return `chispudos-order-${digest}`;
}

function buildPayload(draft, reference) {
  const office = draft.official.office;
  const payload = {
    external_reference: reference,
    cliente: { ...draft.identity, telefono: draft.customerPhone, documento: { tipo: draft.documentType || 'V', numero: draft.cedula } },
    direccion: {
      state_id: Number(office.state_id), city_id: Number(office.city_id),
      direccion: office.direccion || office.nombre, referencia: `Retiro en oficina Tealca ${office.nombre}`,
    },
    productos: draft.items.map((item) => ({
      producto_id: Number(item.mapping.productId),
      cantidad: item.quantity,
      precio_venta_ves: Math.round((item.total / item.quantity) * 100) / 100,
    })),
    bodega_origen_id: Number(draft.items[0].mapping.warehouseId),
    tipo_entrega: 'oficina', shipping_type_id: 3,
    tipo_pago: 'con_recaudo', requiere_aprobacion: true,
    nota_cliente: 'Pedido creado por ChispudosMarket. Revisar antes de aprobar.',
  };
  if (office.id != null) payload.oficina_id = Number(office.id);
  return payload;
}

function sessionExists(phone) {
  return listSessions().some((session) => String(session.phone) === String(phone));
}

// Guarda el estado del pedido de ESTA venta. Si en la sesión había un pedido
// ya creado de una venta anterior, se mueve al historial en vez de borrarlo.
function saveOrderState(phone, reference, next) {
  const session = getSession(phone);
  const stored = session.dropanasOrder || null;
  const { previous } = splitStoredOrder(stored, reference);
  const patch = { dropanasOrder: next };
  if (previous?.id) patch.dropanasOrderHistory = [...(session.dropanasOrderHistory || []), previous].slice(-20);
  updateSession(phone, patch);
}

async function createForPhone(phone, { automatic = false } = {}) {
  if (locks.has(phone)) throw new Error('Ese pedido ya se está procesando.');
  // No crear conversaciones fantasma por un teléfono que no existe.
  if (!sessionExists(phone)) throw new Error('No existe una conversación con ese teléfono.');
  locks.add(phone);
  let draft = null;
  let reference = null;
  let idempotencyKey = null;
  let requestSent = false;
  let autoAttempts = null;
  try {
    const config = settings();
    if (!config.uploadEnabled) throw new Error('La subida de pedidos está desactivada en el panel.');
    if (automatic && !config.autoCreateEnabled) return { skipped: true, reason: 'automatico_desactivado' };
    const session = getSession(phone);
    reference = referenceFor(phone, session.soldAt);
    const before = splitStoredOrder(session.dropanasOrder || null, reference).current || {};
    if (automatic) autoAttempts = (Number(before.autoAttempts) || 0) + 1;
    draft = await prepareDraft(phone, session);
    if (draft.current?.id) return { ok: true, duplicate: true, order: draft.current };
    if (draft.issues.length) throw new Error(draft.issues.join(' '));
    reference = externalReference(draft);
    // La clave depende SOLO de la referencia de esta venta: dos procesos o
    // reintentos de la misma venta mandan exactamente la misma clave, y una
    // venta nueva del mismo cliente nunca reutiliza la de una venta vieja.
    idempotencyKey = deterministicIdempotencyKey(reference);
    const persisted = draft.current || {};
    saveOrderState(phone, reference, {
      ...persisted, status: 'subiendo', idempotencyKey, externalReference: reference, soldAt: draft.soldAt,
      attemptedAt: new Date().toISOString(), lastAttemptAutomatic: Boolean(automatic),
      ...(autoAttempts ? { autoAttempts } : {}), error: null, requestMaybeSent: false,
    });
    const apiConfig = dropanasApi.configFromEnv();
    dropanasApi.assertReadOnlyEnabled(apiConfig);
    if (apiConfig.tokenMode !== 'live') {
      throw new Error('La creación de pedidos exige la API de producción de DroPanas.');
    }
    requestSent = true;
    const response = await axios.post(`${apiConfig.baseUrl}/ordenes`, buildPayload(draft, reference), {
      headers: {
        ...dropanasApi.requestHeaders(apiConfig.token),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      timeout: apiConfig.timeoutMs, validateStatus: (status) => status >= 200 && status < 300,
    });
    const created = response.data?.data ?? response.data;
    if (created?.id == null) {
      throw new Error('DroPanas respondió OK pero sin número de pedido.');
    }
    // DroPanas YA creó la orden: su número se guarda siempre, primero. Lo
    // que no cuadre queda como aviso para revisar, nunca como "no subido"
    // (eso haría que se pudiera volver a subir y duplicarlo).
    const anomalies = [];
    const mode = String(response.headers?.['x-dropanas-mode'] || '').toLowerCase();
    if (mode !== 'live') anomalies.push(`DroPanas respondió en modo ${mode || 'desconocido'}.`);
    if (created.estado_aprobacion !== 'pendiente_aprobacion') {
      anomalies.push(`DroPanas dejó el pedido en estado "${created.estado_aprobacion || 'sin estado'}" en vez de pendiente de aprobación; revísalo en DroPanas.`);
    }
    const order = {
      id: created.id, status: created.estado_aprobacion || 'desconocido', externalReference: reference,
      idempotencyKey, soldAt: draft.soldAt, createdAt: new Date().toISOString(), automatic: Boolean(automatic),
      ...(anomalies.length ? { warning: anomalies.join(' ') } : {}),
    };
    saveOrderState(phone, reference, order);
    return { ok: true, order, warning: order.warning || null };
  } catch (error) {
    const session = getSession(phone);
    const { current } = splitStoredOrder(session.dropanasOrder || null, reference);
    const status = Number(error.response?.status) || null;
    // 400/422: DroPanas reviso el pedido y lo rechazo, asi que NO se creo.
    // Se guarda el motivo exacto y se puede reintentar sin miedo a duplicar.
    const rejected = requestSent && (status === 400 || status === 422);
    if (requestSent && error.response) error.message = `POST /ordenes: ${describeApiError(error)}`;
    if (reference && !current?.id) {
      saveOrderState(phone, reference, {
        ...(current || {}), externalReference: reference, soldAt: session.soldAt || null,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(autoAttempts ? { autoAttempts } : {}),
        lastAttemptAutomatic: Boolean(automatic),
        status: 'error', error: error.message, failedAt: new Date().toISOString(),
        // Si el pedido llegó a enviarse, pudo haberse creado igual (por
        // ejemplo, un tiempo de espera agotado): se avisa y no se reintenta solo.
        requestMaybeSent: rejected ? false : Boolean(requestSent || current?.requestMaybeSent),
        ...(rejected ? { rejectedByDropanas: true } : {}),
      });
    }
    throw error;
  } finally {
    locks.delete(phone);
  }
}

function maybeCreate(phone) {
  const config = settings();
  if (!config.uploadEnabled || !config.autoCreateEnabled || !config.activatedAt) return;
  const session = getSession(phone);
  if (!session.soldAt || new Date(session.soldAt) < new Date(config.activatedAt)) return;
  setImmediate(() => createForPhone(phone, { automatic: true }).catch((error) => {
    console.error(`Pedido DroPanas no creado para ${phone}:`, error.message);
  }));
}

// Reintento del modo automático. Antes, si al cerrar la venta faltaba un
// dato (por ejemplo la cédula), el intento automático fallaba una vez y no
// se volvía a intentar aunque el cliente mandara el dato después. Ahora, cada
// AUTO_RETRY_MS se revisan las ventas cuyo intento automático falló y, si ya
// no les falta nada, se reintentan (máximo AUTO_RETRY_MAX veces). Nunca se
// reintenta solo un pedido que pudo haber llegado a DroPanas.
async function retryAutomatic() {
  const config = settings();
  if (!config.uploadEnabled || !config.autoCreateEnabled || !config.activatedAt) return { retried: 0, results: [] };
  const results = [];
  for (const session of listSessions()) {
    if (!session.soldAt || new Date(session.soldAt) < new Date(config.activatedAt)) continue;
    const draft = baseDraft(session.phone, session, config);
    const current = draft.current;
    if (!current || current.id || !current.lastAttemptAutomatic) continue;
    if (current.status !== 'error' || current.requestMaybeSent) continue;
    if ((Number(current.autoAttempts) || 0) >= AUTO_RETRY_MAX) continue;
    if (draft.issues.length) continue;
    try {
      results.push({ phone: session.phone, ...(await createForPhone(session.phone, { automatic: true })) });
    } catch (error) {
      results.push({ phone: session.phone, ok: false, error: error.message });
    }
  }
  return { retried: results.length, results };
}

function startAutoRetry() {
  if (autoRetryTimer) return false;
  autoRetryTimer = setInterval(() => {
    retryAutomatic().catch((error) => console.error('Reintento de pedidos DroPanas:', error.message));
  }, AUTO_RETRY_MS);
  autoRetryTimer.unref?.();
  return true;
}

function stopAutoRetry() {
  if (autoRetryTimer) clearInterval(autoRetryTimer);
  autoRetryTimer = null;
}

module.exports = { defaultMappings, settings, matchableMappings, validateConfig, saveConfig, baseDraft, prepareDraft, listDrafts, createForPhone, maybeCreate, splitName, localPhone, findMapping, resolveOffice, historyOrderFacts, cleanAgency, describeApiError, buildPayload, externalReference, deterministicIdempotencyKey,
  mentionedProducts, documentType, retryAutomatic, startAutoRetry, stopAutoRetry, AUTO_RETRY_MAX };

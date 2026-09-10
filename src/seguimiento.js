// Seguimiento diario del pedido con el Excel que exporta Dropanas (el mismo
// que ya se usa para cargar numeros de guia, ver dropanas.js — este modulo
// SOLO agrega la parte de "actualizar etapas y avisar que ya se puede
// retirar", reusando el mismo cruce por nombre de cliente).
//
// Idea: el negocio sube el Excel una vez al dia. Segun la columna "Estado
// Pedido" de cada fila:
//   - "En oficina"  -> el pedido ya esta en la agencia: se pasa la
//     conversacion a la etapa "esperando_retiro" Y se manda la plantilla de
//     "ya podes retirarlo" (pedido_ha_llegado_a_tealca), con nombre,
//     producto, numero de guia y monto sacados DIRECTO de esa misma fila.
//   - "En camino" / "En transito" -> etapa "en_camino", sin mandar nada.
//   - "Entregado" -> etapa "entregado", sin mandar nada.
//   - Cualquier otro estado (Pagado, Cancelado, En novedad, Pendiente
//     devolucion, Devolucion, Generada, Pendiente...) -> no se toca nada
//     todavia (no hay una regla confirmada para esos), se lista aparte en
//     el panel como "sin accion, revisar si queres".
//
// Nunca manda ni cambia nada por su cuenta: arma la lista completa para que
// el negocio la revise en el panel y recien mande/actualice lo que confirme
// (ver /api/seguimiento/preview y /api/seguimiento/confirm en panel.js).
const { listSessions, updateSession, appendMessage } = require('./state');
const { SOLD_STAGES } = require('./flow');
const { sendTemplateWithSnapshot } = require('./templateSend');
const { getSettings } = require('./settings');
// FASE 3 (H05): foldName() y el criterio de "son la misma persona" ahora
// viven en un solo lugar compartido con dropanas.js (nameMatch.js).
const { foldName, compareNames } = require('./nameMatch');

// Mismo criterio que dropanas.js: conversaciones ya vendidas y que todavia
// no estan "entregado" son las candidatas a que este cruce las actualice
// (una vez entregado, no hace falta seguir tocandolas desde aca). Este
// modulo es especificamente el seguimiento LOGISTICO de pedidos ya vendidos
// (no el cruce de guias nuevas de H18, que si amplio a otras etapas), asi
// que se mantiene acotado a SOLD_STAGES a proposito.
function candidateSessions() {
  return listSessions().filter((s) => SOLD_STAGES.includes(s.stage || 'nuevo') && s.stage !== 'entregado');
}

// FASE 3 (H05): antes una sola coincidencia parcial (ej. "Ana" contra "Ana
// Maria") se clasificaba como 'exacto' porque `candidates.length === 1`, sin
// importar que la evidencia (una sola palabra en comun) fuera debil. Ahora
// se usa compareNames() (ver nameMatch.js): 'exacto' exige coincidencia
// total de palabras, o que el nombre mas chico (2+ palabras) este contenido
// entero en el mas grande. Cualquier otra coincidencia parcial (una sola
// palabra en comun, como "Ana"/"Ana Maria") nunca se auto-marca: queda como
// 'ambiguo' para que el negocio confirme a mano en el panel.
function matchCliente(clienteRaw) {
  const target = foldName(clienteRaw);
  if (!target) return { matchType: 'sin_match', candidates: [] };

  const exactas = [];
  const parciales = [];
  for (const s of candidateSessions()) {
    const nombre = s.card?.nombre || s.name || '';
    if (!foldName(nombre)) continue;
    const resultado = compareNames(nombre, clienteRaw);
    if (resultado === 'exacto') exactas.push(s);
    else if (resultado === 'parcial') parciales.push(s);
  }

  if (exactas.length === 1) return { matchType: 'exacto', candidates: exactas };
  if (exactas.length > 1) return { matchType: 'ambiguo', candidates: exactas };
  if (parciales.length) return { matchType: 'ambiguo', candidates: parciales };
  return { matchType: 'sin_match', candidates: [] };
}

// Mapeo confirmado con el negocio (ver conversacion): solo estos tres
// estados tienen una regla clara hoy. Todo lo demas queda sin tocar.
const ESTADO_A_ETAPA = {
  'en oficina': 'esperando_retiro',
  'en camino': 'en_camino',
  'en transito': 'en_camino', // por si Dropanas lo manda sin tilde
  entregado: 'entregado',
};

function firstName(full) {
  return String(full || '').trim().split(/\s+/)[0] || '';
}

// FASE 3 (H12): antes esto hacia Number(n) directo. Dos problemas
// confirmados con el Excel real de Dropanas:
//   1. Un monto vacio ("" o celda vacia) daba Number('') = 0, y el cliente
//      terminaba recibiendo "0bs" en la plantilla en vez de que el negocio
//      se entere de que falta cargar el monto.
//   2. Cuando la celda viene como TEXTO con formato venezolano ("38.900",
//      punto como separador de miles), Number("38.900") = 38.9 (JS lee el
//      punto como separador decimal): el cliente veia "38.90bs" en vez de
//      "38900bs", un monto casi mil veces menor al real.
// parseMontoBs distingue explicitamente estos dos formatos; si no puede
// interpretar el valor con confianza, devuelve null (nunca 0).
function parseMontoBs(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  let texto = String(raw).trim();
  if (!texto) return null;

  if (texto.includes(',')) {
    // Formato "1.234.567,89": los puntos son de miles, la coma es decimal.
    texto = texto.replace(/\./g, '').replace(',', '.');
  } else if (texto.includes('.')) {
    // Sin coma: si CADA grupo despues de un punto tiene exactamente 3
    // digitos (ej. "38.900" o "1.234.567"), son separadores de miles. Si no
    // (ej. "38.90", dos decimales), se deja como separador decimal normal.
    const partes = texto.split('.');
    const pareceMilesVenezolano = partes.length > 1 && partes.slice(1).every((p) => p.length === 3);
    if (pareceMilesVenezolano) texto = partes.join('');
  }

  const num = Number(texto);
  return Number.isFinite(num) ? num : null;
}

// Ej. 34900 -> "34900bs" (mismo formato que usan las plantillas ya
// aprobadas). Si el numero tiene decimales reales los conserva. Un monto
// vacio o no interpretable devuelve '' (no "0bs") para que quien llama
// pueda mostrar su propio respaldo ('-') y el negocio note que falta el
// dato, en vez de mandarle un precio inventado al cliente.
function formatMonto(n) {
  const num = parseMontoBs(n);
  if (num === null) return '';
  const texto = Number.isInteger(num) ? String(num) : num.toFixed(2);
  return texto + 'bs';
}

// rows: la salida de dropanas.parseExportBuffer (ya trae guia, cliente,
// ciudad, producto, estadoPedido, totalVentaBs, bodegaDestino).
function buildPreview(rows) {
  return rows.map((row) => {
    const estadoFold = foldName(row.estadoPedido);
    const etapaNueva = ESTADO_A_ETAPA[estadoFold] || null;
    const enviarPlantilla = etapaNueva === 'esperando_retiro';
    const { matchType, candidates } = matchCliente(row.cliente);

    return {
      guia: row.guia,
      cliente: row.cliente,
      ciudad: row.ciudad,
      producto: row.producto,
      estadoPedido: row.estadoPedido,
      etapaNueva,
      enviarPlantilla,
      matchType,
      candidates: candidates.map((s) => ({ phone: s.phone, nombre: s.card?.nombre || s.name || '', stage: s.stage })),
      phone: matchType === 'exacto' ? candidates[0].phone : null,
      // Igual que en shipping.js: WhatsApp/Meta rompe la plantilla ENTERA (sin
      // reemplazar ninguna variable) si UN solo parametro llega vacio, asi
      // que ninguno de estos puede quedar en '' — siempre un respaldo.
      plantillaVars: enviarPlantilla
        ? {
            nombre: firstName(row.cliente) || 'cliente',
            producto: row.producto || 'tu pedido',
            guia: row.guia || '-',
            monto: formatMonto(row.totalVentaBs) || '-',
          }
        : null,
    };
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DELAY_MS = 1200;

// items: los que el negocio reviso y marco en el panel, cada uno con
// { phone, etapaNueva, enviarPlantilla, plantillaVars }. Actualiza la etapa
// (si corresponde) y manda la plantilla (si corresponde), uno por uno.
async function applyItems(items) {
  const settings = getSettings();
  const templateName = settings.pickupTemplateName || 'pedido_ha_llegado_a_tealca';
  const languageCode = settings.pickupTemplateLanguage || 'es';

  const results = [];
  for (const item of items) {
    if (!item.phone) {
      results.push({ phone: item.phone, ok: false, error: 'Sin conversacion elegida' });
      continue;
    }
    try {
      if (item.etapaNueva) {
        updateSession(item.phone, { stage: item.etapaNueva });
      }
      if (item.enviarPlantilla && item.plantillaVars) {
        const params = [item.plantillaVars.nombre, item.plantillaVars.producto, item.plantillaVars.guia, item.plantillaVars.monto];
        // FASE 2/5 (H06/H35): mismo armado unico que preview/prueba, y se
        // guarda el snapshot + wamid (antes solo quedaba el string
        // "[plantilla] nombre").
        const { wamid, snapshot } = await sendTemplateWithSnapshot({ to: item.phone, templateName, languageCode, values: params });
        // BUG YA CORREGIDO: esta plantilla SI se mandaba de verdad por
        // WhatsApp (mismo sendTemplate que usa todo el resto del bot, que
        // ya sabemos que entrega bien), pero nunca quedaba guardada en el
        // historial de la conversacion, asi que en el panel no se veia
        // ningun rastro de que se hubiera mandado. Por eso parecia que "no
        // se mando" cuando en realidad si habia salido.
        appendMessage(item.phone, 'human', `[plantilla] ${templateName}`, {
          template: { name: templateName, origin: 'seguimiento', params, snapshot, wamid, status: 'sent' },
        });
      }
      results.push({ phone: item.phone, ok: true });
    } catch (err) {
      const detail = err.response?.data?.error?.message || err.message;
      results.push({ phone: item.phone, ok: false, error: detail });
    }
    await sleep(DELAY_MS);
  }
  return results;
}

// Modo de prueba: manda la plantilla de "ya podes retirarlo" (con estos
// datos puntuales) a CUALQUIER numero que se le pase, sin leer ni tocar
// ninguna conversacion real ni guardar nada — para poder ver como sale el
// mensaje antes de confirmar el envio real a los clientes que ya llegaron.
async function testSend(phone, vars) {
  const settings = getSettings();
  const templateName = settings.pickupTemplateName || 'pedido_ha_llegado_a_tealca';
  const languageCode = settings.pickupTemplateLanguage || 'es';
  const values = {
    nombre: String(vars?.nombre || '').trim() || 'cliente',
    producto: String(vars?.producto || '').trim() || 'tu pedido',
    guia: String(vars?.guia || '').trim() || '-',
    monto: String(vars?.monto || '').trim() || '-',
  };
  const params = [values.nombre, values.producto, values.guia, values.monto];
  let wamid = null;
  let snapshot = null;
  try {
    // FASE 2/5 (H06/H17): mismo armado unico que el envio real y que el
    // preview generico del panel -- asi la prueba nunca puede mostrar un
    // resultado distinto del que se va a mandar de verdad despues.
    ({ wamid, snapshot } = await sendTemplateWithSnapshot({ to: phone, templateName, languageCode, values: params }));
  } catch (err) {
    const metaMsg = err.response?.data?.error?.message;
    throw new Error(metaMsg ? `Meta rechazo el envio: ${metaMsg}` : err.message);
  }
  return { sent: true, values, wamid, snapshot };
}

module.exports = {
  buildPreview,
  applyItems,
  testSend,
  // FASE 3 (H05/H12): exportadas para poder probarlas directo sin tener que
  // pasar por un Excel/preview completo.
  matchCliente,
  formatMonto,
  parseMontoBs,
};

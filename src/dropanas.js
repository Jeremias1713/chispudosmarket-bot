// Cruza el Excel que exporta Dropanas (pedidos con su numero de guia ya
// generado) contra las conversaciones del bot, para no tener que copiar cada
// numero de guia a mano en cada chat. Como ese export NO trae telefono (solo
// el nombre del cliente tal cual se lo copiaron/pegaron y la ciudad), el
// cruce es por nombre: se compara el nombre que el cliente le dio al bot
// (card.nombre, lo que la IA extrajo de la conversacion; si no hay, el
// nombre de perfil de WhatsApp) contra la columna "Cliente" del Excel.
//
// Si un nombre matchea UNA sola conversacion vendida, se propone como
// "exacto" (chequeado por default en el panel). Si matchea varias o ninguna,
// se deja como "ambiguo"/"sin_match" para que el negocio elija a mano — este
// modulo NUNCA manda nada por su cuenta, solo arma la lista; el envio real
// pasa por el mismo camino que cargar la guia a mano (ver shipping.js),
// disparado desde el panel solo cuando el negocio confirma.
const { listSessions } = require('./state');
// FASE 3 (H05/H18): foldName() y el criterio de "son la misma persona" ahora
// viven en un solo lugar compartido (nameMatch.js) en vez de estar copiados
// en cada archivo con reglas levemente distintas.
const { foldName, compareNames } = require('./nameMatch');

// Encuentra el indice de la primera columna del header cuyo nombre (ya
// normalizado) contenga alguna de las palabras clave dadas. Asi no importa
// si Dropanas cambia mayusculas/acentos/orden de columnas.
function findCol(header, ...keys) {
  return header.findIndex((h) => keys.some((k) => h.includes(k)));
}

function parseExportBuffer(buffer) {
  // Se pide aca adentro (no arriba del archivo) para que el resto del bot
  // siga funcionando aunque la dependencia 'xlsx' no este instalada.
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('El Excel no tiene hojas.');
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rows.length) throw new Error('La hoja esta vacia.');

  const header = rows[0].map(foldName);
  const idxGuia = findCol(header, 'guia');
  const idxCliente = findCol(header, 'cliente');
  const idxCiudad = findCol(header, 'ciudad');
  const idxProducto = findCol(header, 'producto');
  const idxEstado = findCol(header, 'estado pedido', 'estado');
  // Estos dos se agregaron para el seguimiento diario (ver seguimiento.js):
  // "Total Venta Bs" es el monto que hay que cobrar contra entrega/retiro, y
  // "Bodega Destino" identifica la agencia/bodega adonde llego el pedido.
  // Busqueda especifica (no solo "total venta") para no confundirla con la
  // columna en USD que tiene el mismo prefijo.
  const idxTotalVentaBs = findCol(header, 'total venta bs');
  const idxBodegaDestino = findCol(header, 'bodega destino');

  if (idxGuia === -1 || idxCliente === -1) {
    throw new Error('No reconozco las columnas de guia/cliente en este Excel. Revisa que sea la exportacion de pedidos de Dropanas.');
  }

  return rows
    .slice(1)
    .filter((r) => String(r[idxGuia] || '').trim())
    .map((r) => ({
      guia: String(r[idxGuia] || '').trim(),
      cliente: String(r[idxCliente] || '').trim(),
      ciudad: idxCiudad !== -1 ? String(r[idxCiudad] || '').trim() : '',
      producto: idxProducto !== -1 ? String(r[idxProducto] || '').trim() : '',
      estadoPedido: idxEstado !== -1 ? String(r[idxEstado] || '').trim() : '',
      totalVentaBs: idxTotalVentaBs !== -1 ? r[idxTotalVentaBs] : '',
      bodegaDestino: idxBodegaDestino !== -1 ? String(r[idxBodegaDestino] || '').trim() : '',
    }));
}

// Conversaciones "candidatas" a recibir una guia.
//
// FASE 3 (H18): antes solo entraban conversaciones ya en SOLD_STAGES
// (vendido/esperando_guia/esperando_retiro/en_camino), asi que un pedido
// vendido por otro medio (o que el operador todavia no paso a "vendido" en
// el panel) pero que YA tiene guia generada en Dropanas quedaba "sin_match"
// para siempre. Ahora se incluye cualquier conversacion que no este
// "entregado" (el unico estado realmente terminal): el numero de guia real
// de Dropanas es una senal mas fuerte que la etapa interna del bot, que
// puede estar desactualizada.
//
// FASE 3 (H07): antes se excluia una conversacion si YA tenia guardado
// `card.guia === guia`, sin importar si el aviso automatico al cliente
// (shipping.maybeNotifyShipping) habia tenido exito o habia fallado. Eso
// hacia que una guia cuyo aviso fallo (ventana cerrada sin plantilla
// configurada, error de Meta, etc.) desapareciera del siguiente cruce sin
// que el cliente se hubiera enterado nunca. Ahora solo se excluye si
// ADEMAS el aviso se mando con exito (shippingNotifiedAt seteado por
// shipping.js recien despues de un envio exitoso) — si el aviso fallo, la
// conversacion sigue siendo candidata para poder reintentar.
function candidateSessions(guia) {
  return listSessions().filter((s) => {
    if (s.stage === 'entregado') return false;
    if (s.card?.guia && String(s.card.guia).trim() === guia && s.shippingNotifiedAt) return false;
    return true;
  });
}

function candidateInfo(s) {
  return { phone: s.phone, name: s.card?.nombre || s.name || null, city: s.card?.ciudad || null, stage: s.stage };
}

// FASE 3 (H05/H18): antes "exacto" era simplemente "una sola sesion cuyo
// nombre matchea" — con la comparacion vieja (a.includes(b) || b.includes(a))
// una sola candidata parecida (ej. "Ana" contra "Ana Maria") bastaba para
// decidir "exacto" sin ninguna ambiguedad detectable, aunque la evidencia
// (una sola palabra en comun) era demasiado debil. Ahora se usa
// compareNames() (nameMatch.js): 'exacto' exige que TODAS las palabras del
// nombre mas chico esten en el mas grande Y que sean 2 o mas palabras (asi
// "Jose Velasquez" adentro de "Jose Gregorio Velasquez" SI matchea exacto,
// pero "Ana" adentro de "Ana Maria" NO). Cualquier otra coincidencia parcial
// cae en 'parcial'/'ambiguo': se sugiere, nunca se auto-marca.
function matchRow(row) {
  const target = foldName(row.cliente);
  if (!target) return { matchType: 'sin_match', candidates: [] };

  const candidates = candidateSessions(row.guia);
  const exactas = [];
  const parciales = [];
  for (const s of candidates) {
    const nombre = s.card?.nombre || s.name || '';
    if (!foldName(nombre)) continue;
    const resultado = compareNames(nombre, row.cliente);
    if (resultado === 'exacto') exactas.push(s);
    else if (resultado === 'parcial') parciales.push(s);
  }

  if (exactas.length === 1) {
    const s = exactas[0];
    return { matchType: 'exacto', phone: s.phone, matchedName: s.card?.nombre || s.name, candidates: [candidateInfo(s)] };
  }

  // Dos o mas coincidencias "exactas" a la vez (mismo nombre en dos
  // conversaciones distintas) tambien requieren eleccion manual: no hay
  // forma de saber sola cual de las dos es.
  if (exactas.length > 1) {
    return { matchType: 'ambiguo', candidates: exactas.map(candidateInfo) };
  }

  if (parciales.length) {
    return { matchType: 'ambiguo', candidates: parciales.map(candidateInfo) };
  }

  return { matchType: 'sin_match', candidates: [] };
}

function matchExport(buffer) {
  const rows = parseExportBuffer(buffer);
  return rows.map((row) => ({ ...row, ...matchRow(row) }));
}

module.exports = { parseExportBuffer, matchExport, candidateSessions, matchRow };

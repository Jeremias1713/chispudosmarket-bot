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
const { SOLD_STAGES } = require('./flow');

function foldName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

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

// Conversaciones "candidatas" a recibir una guia: pedidos vendidos que
// todavia no llegaron (se excluye "entregado"). Tambien se excluye una
// conversacion si YA tiene cargada esta misma guia (para que re-subir el
// mismo Excel de nuevo mas tarde no la vuelva a proponer).
function candidateSessions(guia) {
  return listSessions().filter((s) => {
    if (!SOLD_STAGES.includes(s.stage) || s.stage === 'entregado') return false;
    if (s.card?.guia && String(s.card.guia).trim() === guia) return false;
    return true;
  });
}

function candidateInfo(s) {
  return { phone: s.phone, name: s.card?.nombre || s.name || null, city: s.card?.ciudad || null, stage: s.stage };
}

function matchRow(row) {
  const target = foldName(row.cliente);
  if (!target) return { matchType: 'sin_match', candidates: [] };

  const candidates = candidateSessions(row.guia);
  const byName = candidates.filter((s) => {
    const nombre = foldName(s.card?.nombre || s.name || '');
    return nombre && nombre === target;
  });

  if (byName.length === 1) {
    const s = byName[0];
    return { matchType: 'exacto', phone: s.phone, matchedName: s.card?.nombre || s.name, candidates: [candidateInfo(s)] };
  }

  if (byName.length > 1) {
    return { matchType: 'ambiguo', candidates: byName.map(candidateInfo) };
  }

  // Sin match exacto por nombre: probamos una coincidencia parcial (uno
  // contiene al otro, ej. "Jose Velasquez" vs "Jose Gregorio Velasquez")
  // solo para SUGERIR candidatos en el panel — nunca se auto-marca sola,
  // el negocio siempre tiene que elegir a mano de esta lista.
  const partial = candidates.filter((s) => {
    const nombre = foldName(s.card?.nombre || s.name || '');
    return nombre && (nombre.includes(target) || target.includes(nombre));
  });

  return { matchType: partial.length ? 'ambiguo' : 'sin_match', candidates: partial.map(candidateInfo) };
}

function matchExport(buffer) {
  const rows = parseExportBuffer(buffer);
  return rows.map((row) => ({ ...row, ...matchRow(row) }));
}

module.exports = { parseExportBuffer, matchExport };

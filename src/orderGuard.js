// FASE 3 (H08, solucion intermedia): el bot todavia no tiene un modelo de
// "pedidos" independiente (una sesion = un telefono = una sola `card`), asi
// que dos compras del mismo cliente pueden mezclar producto/monto/foto/guia
// sin que nadie se entere: cargar la guia de la SEGUNDA compra pisa
// silenciosamente la guia (y todo lo demas de `card`) de la primera.
//
// Migrar a un modelo de pedidos completo es un cambio grande que toca casi
// todos los modulos del bot (ver auditoria, hallazgo H08) y no es seguro
// hacerlo de un dia para el otro. Mientras tanto, la propia auditoria
// recomienda esta salida intermedia: en vez de sobrescribir en silencio,
// DETECTAR el caso de "esto parece un pedido nuevo" y exigir que el
// operador lo confirme a mano antes de guardar.
//
// Se considera "pedido nuevo" cuando:
//   - la conversacion ya tiene una guia cargada Y ese aviso automatico ya
//     se mando con exito (shippingNotifiedAt) — es decir, hay un pedido
//     anterior ya cerrado/en curso de verdad, no solo un campo vacio; y
//   - la guia que se quiere guardar ahora es DISTINTA de la que ya estaba.
//
// Si no se cumplen las dos condiciones, no hay conflicto: es la carga
// normal de la guia de ESE mismo pedido (corregir un typo, cargarla por
// primera vez, etc.).
const { canAdvanceToEnCaminoOnGuia } = require('./stageRules');

function detectOrderConflict(session, nuevaGuia) {
  const guiaAnterior = session?.card?.guia ? String(session.card.guia).trim() : '';
  const guiaNueva = String(nuevaGuia || '').trim();
  if (!guiaAnterior || !guiaNueva) return null;
  if (guiaAnterior === guiaNueva) return null;
  if (!session.shippingNotifiedAt) return null;

  return {
    conflict: true,
    reason: 'guia_distinta_pedido_anterior',
    message:
      `Esta conversacion ya tiene un pedido con la guia ${guiaAnterior} (ya avisado al cliente). ` +
      `La guia nueva (${guiaNueva}) parece ser de OTRA compra. Si es asi, confirma que es un pedido ` +
      'nuevo para guardarla; si fue un error de tipeo, corregi el numero.',
    pedidoAnterior: {
      guia: guiaAnterior,
      producto: session.card?.producto || null,
      monto: session.card?.monto ?? null,
      avisadoEl: session.shippingNotifiedAt,
    },
  };
}

// FASE (correccion H-nuevo-pedido): arma el patch de sesion para registrar
// una guia de despacho (a mano desde el chat, o confirmada en el lote de
// Dropanas) -- UN SOLO lugar para esta logica, usado por los dos caminos del
// panel (POST /api/conversations/:phone/guia y POST /api/dropanas/confirm),
// que antes tenian cada uno su propia copia con reglas levemente distintas.
//
// isNewOrder=true (el operador ya confirmo el conflicto de detectOrderConflict
// con confirmNewOrder) significa que esta guia es de OTRA compra del mismo
// cliente, no una correccion del mismo pedido. En ese caso:
//   - se reinician los datos TECNICOS del pedido anterior (foto de la guia,
//     agencia de destino, monto) porque son propios de esa compra vieja, no
//     del cliente: mantenerlos mezclaria los dos pedidos.
//   - se reinician las marcas de aviso (shippingNotifiedAt/arrivalNotifiedAt)
//     para que el aviso de la guia NUEVA se pueda mandar de verdad, en vez de
//     quedar creyendo que "ya se aviso" por el pedido anterior.
//   - se reinicia soldAt a ahora, para que las metricas por fecha cuenten
//     esta venta el dia de hoy, no el dia del pedido viejo.
//   - se fuerza el avance a "en_camino" aunque la etapa actual ya estuviera
//     mas adelante (esperando_retiro/entregado del pedido anterior): no
//     tiene sentido dejar un pedido recien confirmado colgado en la etapa
//     vieja.
// Los datos PERSONALES del cliente (nombre, ciudad, telefono, cedula,
// notas) y todo el historial de mensajes NUNCA se tocan aca: siguen siendo
// los mismos, son del cliente, no del pedido puntual.
function buildGuiaPatch({ session, guia, agencia, guiaImageUrl, isNewOrder }) {
  const card = { ...(session.card || {}) };

  if (isNewOrder) {
    card.guiaImageUrl = null;
    card.agencia = null;
    card.monto = null;
  }
  if (guia !== undefined) card.guia = String(guia ?? '').trim() || null;
  if (agencia !== undefined) {
    const a = String(agencia ?? '').trim();
    card.agencia = a || null;
  }
  if (guiaImageUrl) card.guiaImageUrl = guiaImageUrl;

  const patch = { card };
  if (card.guia && canAdvanceToEnCaminoOnGuia(session.stage, isNewOrder)) {
    patch.stage = 'en_camino';
    patch.stageReason = isNewOrder ? 'Guia cargada (pedido nuevo)' : 'Guia cargada (avance automatico)';
  }
  if (isNewOrder) {
    patch.shippingNotifiedAt = null;
    patch.arrivalNotifiedAt = null;
    patch.soldAt = new Date().toISOString();
    patch.orderClosed = false;
  }
  return patch;
}

module.exports = { detectOrderConflict, buildGuiaPatch };

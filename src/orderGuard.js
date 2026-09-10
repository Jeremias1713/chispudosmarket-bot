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

module.exports = { detectOrderConflict };

// Reglas COMPARTIDAS sobre el pipeline de etapas de un pedido. Antes cada
// archivo (flow.js, panel.js, shipping.js) tenia su propio criterio suelto
// para decidir que cuenta como "venta cerrada" o si una etapa puede
// avanzar/retroceder, y terminaron quedando reglas distintas para el mismo
// comportamiento (bug reportado: cargar una guia no avanzaba de
// "esperando_guia" a "en_camino" porque esa etapa se habia fijado a mano, o
// el clasificador de IA podia retroceder un pedido ya "esperando_retiro"
// solo porque el cliente mando un mensaje informal como "gracias"). Ahora
// todos usan este mismo modulo.
//
// Etapas que representan un pedido YA cerrado, en cualquier momento
// posterior del despacho (recien cerrado, coordinando retiro, en camino, o
// ya entregado). "tienda_maracaibo" cuenta como venta cerrada igual que las
// demas (retiro en la tienda propia de Maracaibo en vez de una agencia
// Tealca, ver classifier.js), asi que comparte el mismo rango que
// "vendido"/"esperando_guia": ES pedido cerrado, pero todavia no paso por el
// circuito de guia/agencia (y nunca pasa, porque no lo necesita).
// "devolucion" a proposito NO esta en esta lista: un pedido que el cliente
// devolvio deja de contar como venta cerrada en las metricas (ingresos,
// conversion), aunque haya pasado por "vendido"/"entregado" antes de
// devolverse. Sigue existiendo como etapa (classifier.js), solo que a partir
// de ahi las metricas ya no lo suman.
// "vendido_fecha_futura" cuenta como venta cerrada igual que "vendido": el
// pedido ya se cerro, solo que el despacho/la entrega quedaron pospuestos a
// proposito para mas adelante (ver classifier.js). No deja de ser un ingreso
// real por eso.
const SOLD_STAGES = ['vendido', 'vendido_fecha_futura', 'esperando_guia', 'tienda_maracaibo', 'esperando_retiro', 'en_camino', 'novedad', 'pendiente_devolucion', 'entregado'];

// Orden logistico real de un pedido ya cerrado, de "recien cerrado" a
// "entregado". Un rango mayor siempre significa "mas avanzado en el
// despacho", nunca al reves.
//   1: cerrado, pendiente de despacho (vendido/esperando_guia/
//      vendido_fecha_futura), o cerrado sin necesitar despacho
//      (tienda_maracaibo: retiro en tienda propia).
//   2: en_camino - ya se genero/mando la guia, todavia NO llego a la agencia.
//   3: esperando_retiro - YA LLEGO a la agencia, listo para que el cliente
//      lo retire.
//   4: entregado - entrega o retiro confirmado.
const LOGISTIC_RANK = {
  vendido: 1,
  vendido_fecha_futura: 1,
  esperando_guia: 1,
  tienda_maracaibo: 1,
  en_camino: 2,
  esperando_retiro: 3,
  novedad: 3,
  pendiente_devolucion: 3,
  entregado: 4,
};

function logisticRank(stage) {
  return LOGISTIC_RANK[stage] || 0;
}

// Etapas puramente conversacionales, sin ningun avance logistico todavia:
// el clasificador de IA las puede reevaluar libremente turno a turno.
const NON_LOGISTIC_STAGES = ['nuevo', 'interesado', 'negociando', 'escribir_mas_tarde', 'necesita_atencion', 'perdido'];

// Decide si la reclasificacion automatica de un turno (classifier.js, que
// relee TODA la conversacion cada vez y puede "malinterpretar" un mensaje
// suelto o informal) se puede aplicar tal cual, o si hay que ignorarla
// porque pisaria/retrocederia un avance logistico ya confirmado por una
// fuente mas fuerte (guia cargada desde el panel, marcado manual, o el
// propio clasificador en un turno anterior).
//
// Reglas:
// - "devolucion" siempre se puede aplicar: es evidencia nueva de que el
//   cliente devolvio un pedido que en algun momento se cerro/entrego, sin
//   importar en que rango logistico estaba (por eso queda afuera del
//   chequeo de rango de mas abajo).
// - Una vez que la conversacion alcanzo algun rango logistico (>=1, osea
//   ENTRO a SOLD_STAGES), nunca puede RETROCEDER a un rango menor, ni
//   "desvenderse" volviendo a una etapa puramente conversacional
//   (nuevo/interesado/negociando/etc): un "gracias" o cualquier charla
//   suelta despues de la venta no puede bajarle la etapa a un pedido ya
//   confirmado.
// - Con rango igual o mayor al actual, la reclasificacion si se aplica (por
//   ejemplo de "vendido" a "en_camino", o repetir la misma etapa).
function isAllowedAutoTransition(currentStage, nextStage) {
  if (nextStage === 'devolucion') return true;
  const currentRank = logisticRank(currentStage);
  if (currentRank === 0) return true; // todavia no hay nada logistico que proteger
  const nextRank = logisticRank(nextStage);
  if (nextRank === 0) return false; // no se puede "desvender" con una etapa informal
  return nextRank >= currentRank;
}

// Decide si registrar una guia de envio valida (desde el panel, una por una
// o en lote) puede avanzar la etapa a "en_camino". A diferencia de
// isAllowedAutoTransition (pensada para el clasificador de IA), esto es una
// accion EXPLICITA del operador (cargar el numero de guia real de despacho),
// asi que se le permite avanzar aunque la etapa este fijada a mano
// (stageLocked) -- ese candado es para bloquear RECLASIFICACIONES de IA, no
// para bloquear el propio despacho. Nunca retrocede un pedido que ya esta en
// "esperando_retiro" o "entregado": cargar de nuevo la guia de ESE mismo
// pedido (corregir un typo) no tiene que "desretirar" ni "desentregar" nada.
// isNewOrder=true (ver orderGuard.js) fuerza el avance igual, porque en ese
// caso se confirmo que es una guia de OTRO pedido (uno nuevo, recien
// cerrado) y no tiene sentido dejarlo colgado en la etapa vieja del pedido
// anterior. "vendido_fecha_futura" tambien puede avanzar: si llego una guia
// real, el negocio (o Dropanas) ya lo esta despachando, asi que el "para
// adelante" dejo de aplicar.
function canAdvanceToEnCaminoOnGuia(currentStage, isNewOrder) {
  return ['vendido', 'vendido_fecha_futura', 'esperando_guia'].includes(currentStage) || Boolean(isNewOrder);
}

// Cuando el aviso de "ya llego a la agencia, ya puede retirarlo" sale por
// cualquier camino (automatico por DroPanas, o a mano desde la plantilla del
// chat), la etapa tiene que pasar a "esperando_retiro". Devuelve la etapa
// nueva, o null si no corresponde moverla: solo se avanza un pedido que
// todavia no llego (rango logistico 1 o 2, por ejemplo "en_camino"); uno que
// ya esta en la agencia, entregado, en novedad o en devolucion nunca se toca,
// ni una conversacion que no es una venta.
function stageAfterArrivalNotice(currentStage) {
  const rank = logisticRank(currentStage);
  return rank >= 1 && rank <= 2 ? 'esperando_retiro' : null;
}

// Etapas logisticas que solo mueve una fuente fuerte (DroPanas, guia cargada,
// panel). El clasificador de IA nunca las propone por su cuenta cuando el
// pedido esta vinculado a DroPanas: DroPanas manda en la logistica.
const LOGISTIC_OWNED_STAGES = ['esperando_guia', 'en_camino', 'esperando_retiro', 'novedad', 'pendiente_devolucion', 'vendido_fecha_futura', 'tienda_maracaibo'];

// Un pedido esta vinculado a DroPanas si ya tiene orden, id o guia cargada.
function hasDropanasLink(session) {
  return Boolean(session?.dropanasOrder?.id || session?.card?.dropanasId || session?.card?.guia);
}

function foldText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// El cliente confirma que ya retiro o recibio el pedido.
const DELIVERY_CONFIRMATION_RE = /\bya (lo |la |los |las )?(retire|busque|recibi|tengo)\b|\bya me llego\b|\bme llego (bien|todo|el pedido)\b|\blo retire\b/;

function lastUserText(session) {
  const history = Array.isArray(session?.history) ? session.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i] && history[i].role === 'user') return String(history[i].content || '');
  }
  return '';
}

// Decide si la etapa que propone el CLASIFICADOR de IA se puede aplicar.
//  1) nunca retrocede (isAllowedAutoTransition);
//  2) con pedido vinculado a DroPanas no mueve etapas logisticas;
//  3) "entregado" solo si el ULTIMO mensaje del cliente confirma el retiro o la
//     entrega (el clasificador por si solo no alcanza: ya paso un "entregado"
//     por paso del tiempo);
//  4) el resto se aplica.
function isAllowedClassifierTransition(session, nextStage) {
  if (!isAllowedAutoTransition(session?.stage, nextStage)) return false;
  if (hasDropanasLink(session) && LOGISTIC_OWNED_STAGES.includes(nextStage)) return false;
  if (nextStage === 'entregado' && session?.stage !== 'entregado') {
    return DELIVERY_CONFIRMATION_RE.test(foldText(lastUserText(session)));
  }
  return true;
}

module.exports = {
  LOGISTIC_OWNED_STAGES,
  hasDropanasLink,
  isAllowedClassifierTransition,
  SOLD_STAGES,
  stageAfterArrivalNotice,
  LOGISTIC_RANK,
  NON_LOGISTIC_STAGES,
  logisticRank,
  isAllowedAutoTransition,
  canAdvanceToEnCaminoOnGuia,
};

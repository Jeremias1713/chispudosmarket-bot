// Remarketing automatico: si una conversacion queda "colgada" (sin ninguna
// novedad) en una etapa que todavia NO es una venta cerrada, se le manda un
// recordatorio a las 2 horas de la ultima interaccion, y otro mas directo a
// las 5 horas, usando el texto cargado en la ficha del PRODUCTO al que quedo
// vinculada esa conversacion (Catalogo > producto > "Remarketing
// automatico"). Solo corre dentro del horario permitido (Configuracion,
// hora de Venezuela) para no escribirle a nadie de madrugada: si el envio
// cae fuera de ese rango, simplemente se pospone hasta el proximo chequeo
// dentro del horario.
//
// No hace falta node-cron ni nada externo: alcanza con un setInterval que
// revisa todas las conversaciones cada pocos minutos (REVISAR_CADA_MS). Cada
// conversacion se manda como mucho UNA VEZ EN TOTAL por paso (2h, despues
// 5h): el flag queda guardado en la sesion (remarketingSentAt2h/5h) y ya NO
// se resetea aunque el cliente vuelva a escribir (antes si se reseteaba en
// flow.js, y eso hacia que una conversacion larga con idas y vueltas
// terminara recibiendo el mismo recordatorio ciclo tras ciclo, un patron
// que WhatsApp puede tomar como spam). El unico modo de que a una
// conversacion le vuelva a tocar remarketing es que arranque de cero de
// verdad (resetSession, ver flow.js: "menu"/"inicio"/"reiniciar").
const { listSessions, updateSession } = require('./state');
const { findProduct } = require('./catalog');
const { getSettings, updateSettings } = require('./settings');
const { SOLD_STAGES, sendRawReply } = require('./flow');

const REVISAR_CADA_MS = 5 * 60 * 1000; // cada 5 minutos alcanza de sobra
const DOS_HORAS_MS = 2 * 60 * 60 * 1000;
const CINCO_HORAS_MS = 5 * 60 * 60 * 1000;
// Zona horaria fija: el negocio es venezolano (Bs, agencias Tealca). Si el
// dia de manana esto se usa para otro pais, conviene volverlo configurable.
const ZONA_HORARIA = 'America/Caracas';

function horaActualEnVenezuela() {
  const formateado = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA_HORARIA,
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  // Algunos entornos devuelven "24" para la medianoche en vez de "0".
  return parseInt(formateado, 10) % 24;
}

function dentroDelHorarioPermitido(settings) {
  const inicio = settings.remarketingHourStart != null ? Number(settings.remarketingHourStart) : 8;
  const fin = settings.remarketingHourEnd != null ? Number(settings.remarketingHourEnd) : 21;
  if (Number.isNaN(inicio) || Number.isNaN(fin) || inicio === fin) return true; // rango invalido: no restringe
  const hora = horaActualEnVenezuela();
  if (inicio < fin) return hora >= inicio && hora < fin;
  return hora >= inicio || hora < fin; // rango que cruza medianoche (ej. 22 a 6)
}

async function mandarSiCorresponde(session, texto, campoFlag) {
  const limpio = String(texto || '').trim();
  if (!limpio) return false;
  await sendRawReply(session.phone, limpio);
  updateSession(session.phone, { [campoFlag]: new Date().toISOString() });
  return true;
}

// Se fija UNA sola vez (la primera vez que corre esto despues de activarse
// la funcion): todo lo que haya quedado "colgado" de antes de este momento
// nunca recibe remarketing, solo lo que se cuelgue de aca para adelante.
function activatedAtMs(settings) {
  if (settings.remarketingActivatedAt) return new Date(settings.remarketingActivatedAt).getTime();
  const now = new Date().toISOString();
  updateSettings({ remarketingActivatedAt: now });
  return new Date(now).getTime();
}

async function revisarUnaVez() {
  const settings = getSettings();
  if (settings.remarketingEnabled === false) return;
  if (!settings.botEnabled) return;
  if (!dentroDelHorarioPermitido(settings)) return;

  const ahora = Date.now();
  const activadoDesde = activatedAtMs(settings);
  const sessions = listSessions();

  for (const session of sessions) {
    try {
      if (!session.phone || session.phone === 'undefined') continue; // sesion "fantasma" sin numero real
      if (session.paused) continue;
      if (!session.linkedProductId) continue; // sin producto vinculado no hay que texto usar
      // FASE (correccion seguimientos): orderClosed se chequea APARTE de
      // SOLD_STAGES. En el caso normal coinciden (un cierre real tambien
      // mueve la etapa a una de SOLD_STAGES, ver flow.js), pero si un
      // operador fijo la etapa a mano a algo que NO es una etapa de venta
      // (por ejemplo "necesita_atencion", para escalar un reclamo puntual
      // DESPUES de que el pedido ya se habia cerrado por texto) el flag
      // orderClosed sigue en true aunque la etapa ya no este en
      // SOLD_STAGES. Sin este chequeo aparte, esa conversacion (que ya es
      // una venta cerrada) seguia recibiendo remarketing de "todavia no
      // compraste" como si fuera un lead sin cerrar.
      if (session.orderClosed === true) continue;
      const etapa = session.stage || 'nuevo';
      if (SOLD_STAGES.includes(etapa)) continue; // ya es una venta cerrada, no molestar mas
      if (etapa === 'perdido') continue; // dijo que no le interesa: no insistirle mas
      // El cliente dijo EXPLICITAMENTE que va a escribir/comprar mas
      // adelante, en una fecha o momento concreto (ver "escribir_mas_tarde"
      // en classifier.js). Mandarle igual el recordatorio de "todavia no
      // compraste" a las 2h/5h contradice lo que el mismo cliente pidio
      // (esperar a que el vuelva a escribir cuando dijo que iba a hacerlo),
      // y puede sentirse como insistencia despues de que ya avisco que
      // volveria por su cuenta. No hay (todavia) un campo estructurado con
      // la fecha exacta que prometio, asi que la salida segura es no
      // mandarle nada automatico mientras siga en esta etapa: si vuelve a
      // escribir antes, la conversacion sale de esta etapa sola (el
      // clasificador la reclasifica) y puede volver a tocarle remarketing
      // normal desde ese momento en adelante.
      if (etapa === 'escribir_mas_tarde') continue;

      const product = findProduct(session.linkedProductId);
      if (!product || product.remarketingEnabled === false) continue;

      const ultimaInteraccion = session.updatedAt || session.createdAt;
      if (!ultimaInteraccion) continue;
      const ultimaInteraccionMs = new Date(ultimaInteraccion).getTime();
      // Conversacion vieja, de antes de activar remarketing: nunca le toca,
      // ni aunque siga "colgada" para siempre (ver activatedAtMs arriba).
      if (ultimaInteraccionMs < activadoDesde) continue;
      const transcurrido = ahora - ultimaInteraccionMs;

      // Si paso de largo la marca de las 5h y ese paso todavia no se mando,
      // se manda directo el de 5h (mas directo) y se salta el de 2h: evita
      // mandar los dos juntos de una si el servidor estuvo caido un rato.
      if (transcurrido >= CINCO_HORAS_MS && !session.remarketingSentAt5h) {
        await mandarSiCorresponde(session, product.remarketing5h, 'remarketingSentAt5h');
        continue;
      }
      if (transcurrido >= DOS_HORAS_MS && !session.remarketingSentAt2h) {
        await mandarSiCorresponde(session, product.remarketing2h, 'remarketingSentAt2h');
      }
    } catch (err) {
      console.error('Error mandando remarketing a', session.phone, err.message);
    }
  }
}

let arrancado = false;
function start() {
  if (arrancado) return;
  arrancado = true;
  revisarUnaVez().catch((err) => console.error('Error en el chequeo de remarketing:', err));
  setInterval(() => {
    revisarUnaVez().catch((err) => console.error('Error en el chequeo de remarketing:', err));
  }, REVISAR_CADA_MS);
}

module.exports = {
  start,
  // Exportado para poder probar la logica de un chequeo (revisarUnaVez)
  // directamente en tests, sin depender del setInterval real ni de esperar
  // minutos de verdad.
  revisarUnaVez,
};

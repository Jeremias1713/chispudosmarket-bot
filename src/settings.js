// Configuracion editable en vivo desde el panel, sin tener que redesplegar.
// Se guarda en un JSON aparte de sessions.json. Todo lo que este vacio/null
// acá cae al valor por variable de entorno (o al default de cada modulo),
// asi que el bot sigue funcionando igual si nunca se toca esto.
//
// OJO: mismo caveat que sessions.json — en el plan gratis de Render el disco
// no es persistente entre reinicios por inactividad.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./dataDir');

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  botEnabled: true,
  businessName: null, // null = usa BUSINESS_NAME del .env
  welcomeMessage: null, // null = usa el saludo por defecto de flow.js
  welcomeImageIds: [], // ids de imagenes de la biblioteca para mandar junto al saludo inicial (puede ser mas de una)
  knowledgeBase: '', // datos de envio/pago/promos que el bot da por ciertos
  // Texto EXACTO que el bot manda cuando pide nombre/cedula/telefono para
  // cerrar un pedido que retira en agencia (ver ai.js, CIERRE DEL PEDIDO).
  // null = usa el texto por defecto que trae el codigo.
  dataRequestTemplate: null,
  openaiModel: null,
  openaiTemperature: null,
  openaiHistoryN: null,
  // Cuanto espera el bot en milisegundos DESPUES del ultimo mensaje del
  // cliente antes de contestar. Si el cliente manda varios mensajes
  // seguidos, cada uno reinicia la espera: el bot recien contesta cuando
  // el cliente se queda callado ese rato.
  replyDelayMs: 8000,
  // Objetivo de palabras por mensaje para una respuesta comun (saludo,
  // confirmar un dato, etc). No es un tope duro: el modelo puede pasarse de
  // esto sin que se le corte el mensaje.
  maxWordsPerMessage: 30,
  // Tope duro de palabras por mensaje: recien si se pasa de ESTO se corta y
  // se reparte en el siguiente mensaje (nunca se descarta texto, lo que
  // sobra se pega al ultimo). Mas alto que el objetivo a proposito, para que
  // el bot pueda explicar un producto, los datos del formulario o la
  // direccion de una agencia sin que le corten la explicacion a la mitad.
  maxWordsHardCap: 90,
  maxMessageParts: 5,
  // Si esta apagado, el bot siempre contesta en un solo mensaje de WhatsApp
  // (se ignoran los ||| que el modelo hubiera puesto, y no se aplica ningun
  // corte salvo el tope duro de palabras como red de seguridad).
  splitRepliesEnabled: true,
  // Si un fragmento separado por ||| queda mas corto que esto (en palabras),
  // se pega al fragmento de al lado en vez de mandarse como mensaje aparte:
  // evita mensajes sueltos ridiculamente cortos tipo "Hola" solo.
  splitMinWords: 3,
  // Espera minima/maxima (ms) entre un fragmento y el siguiente cuando la
  // respuesta se manda partida en varios mensajes, para simular que una
  // persona esta escribiendo cada uno por separado.
  splitGapMinMs: 6000,
  splitGapMaxMs: 9500,
  // Ademas del texto, manda una nota de voz con la misma respuesta.
  audioReplyEnabled: true,
  // Con audioReplyEnabled apagado: igual contesta con nota de voz cuando el
  // cliente le escribe por nota de voz (espeja el formato del cliente).
  audioReplyOnVoice: true,
  // Remarketing automatico: si una conversacion queda sin novedad (ver
  // remarketing.js) se le manda un recordatorio a las 2 horas y otro a las 5
  // horas, usando el texto cargado en el producto vinculado a esa charla
  // (Catalogo > producto > "Remarketing automatico"). Apagar esto frena
  // TODOS los envios automaticos, sin tocar el texto cargado en cada
  // producto (sirve para pausarlo de golpe sin perder la configuracion).
  remarketingEnabled: true,
  // Rango de horas (0-23, hora de Venezuela) en el que esta permitido mandar
  // los recordatorios: fuera de ese rango simplemente se posponen hasta que
  // vuelva a abrir la ventana. remarketingHourEnd es exclusivo (21 = hasta
  // las 20:59).
  remarketingHourStart: 8,
  remarketingHourEnd: 21,
  // Momento (ISO) a partir del cual el remarketing automatico empieza a
  // contar: se fija SOLO una vez, la primera vez que arranca remarketing.js
  // despues de activarse la funcion. Las conversaciones cuya ULTIMA
  // interaccion sea de ANTES de este momento nunca reciben remarketing (para
  // no bombardear de golpe a todas las charlas viejas que ya estaban
  // "colgadas" cuando se prendio esta funcion): solo aplica de ahi para
  // adelante.
  remarketingActivatedAt: null,
  // Aviso automatico de guia de envio (ver src/shipping.js): nombre EXACTO
  // de la plantilla ya aprobada en Meta que se usa cuando se carga la guia
  // de un pedido y la ventana de 24h ya esta cerrada. null = todavia no hay
  // ninguna configurada, asi que en ese caso el aviso automatico no manda
  // nada (no puede mandar texto libre fuera de la ventana, y sin plantilla
  // no tiene otra cosa que mandar).
  shippingTemplateName: null,
  // Idioma con el que quedo aprobada la plantilla en Meta (el codigo que
  // Meta usa, ej. "es" o "es_MX"), no el idioma en el que esta escrita.
  shippingTemplateLanguage: 'es',
  // Texto que se manda SOLO cuando la ventana de 24h todavia esta abierta
  // (no hace falta plantilla en ese caso). Admite {{nombre}}, {{producto}}
  // y {{guia}}, que se reemplazan por los datos de cada pedido. null = usa
  // el texto por defecto que trae el codigo.
  shippingFreeText: null,
  // Plantilla que usa el "seguimiento diario" (ver src/seguimiento.js) para
  // avisar que el pedido ya llego a la agencia y esta listo para retirar.
  // null = usa "pedido_ha_llegado_a_tealca" (la que se armo para esto), pero
  // se puede cambiar aca si el negocio la vuelve a aprobar con otro nombre.
  pickupTemplateName: null,
  pickupTemplateLanguage: 'es',
  // Recordatorio diario (una vez por dia, desde pickupReminderHour hora de
  // Venezuela) a todos los pedidos en "esperando_retiro" que DroPanas
  // confirma que siguen en oficina. Si DroPanas no puede confirmar un pedido,
  // solo se recuerda si el bot aviso su llegada hace pickupReminderMaxDays
  // dias o menos. Ver pickupReminders.js.
  pickupReminderEnabled: true,
  pickupReminderHour: 10,
  pickupReminderMaxDays: 5,
  pickupReminderActivatedAt: null,
  deliveredTemplateName: 'pedido_entregado_gracias',
  deliveredTemplateLanguage: 'es',
  noveltyTemplateName: 'novedad_no_contactado',
  noveltyTemplateLanguage: 'es',
  returnPendingTemplateName: 'pedido_pendiente_devolucion',
  returnPendingTemplateLanguage: 'es',
  // Numero de WhatsApp (con codigo de pais, sin "+", ej. 584121234567) al que
  // se le manda un aviso de texto libre cada vez que una conversacion pasa a
  // "vendido" (ver notifySale en push.js). null/vacio = no se manda ningun
  // aviso por WhatsApp (solo queda la notificacion push del panel, que ya
  // existia). OJO: WhatsApp solo deja mandar texto libre a un numero si ese
  // numero le escribio al bot en las ultimas 24h (la "ventana" de siempre,
  // ver flow.js). Como este numero es el del dueno/vendedor, no un cliente,
  // para que le lleguen los avisos tiene que escribirle una vez al numero
  // del bot (un simple "hola" alcanza) y despues los va a recibir por 24h;
  // pasado ese tiempo sin escribir, hay que volver a escribirle una vez para
  // reabrir la ventana. Si el envio falla (ventana cerrada, numero mal
  // puesto, etc), solo se registra en los logs: nunca rompe el flujo de la
  // venta ni la notificacion push del panel.
  saleNotifyPhone: null,
  // Creación de órdenes en DroPanas. Son dos interruptores separados:
  // upload habilita el botón manual del panel y autoCreate permite que una
  // venta nueva se suba sola. La API siempre recibe requiere_aprobacion=true;
  // no existe una opción para aprobar automáticamente desde este bot.
  dropanasOrderUploadEnabled: false,
  dropanasOrderAutoCreateEnabled: false,
  dropanasOrderActivatedAt: null,
  // Mapeos editables producto del catálogo/bot -> ID real de DroPanas.
  // Si está vacío, dropanasOrderAutomation usa sus valores iniciales seguros.
  dropanasOrderMappings: [],
  // Guardia de envios automaticos (src/outboundGuard.js): tope por cliente y
  // por dia, horario de Caracas, y el texto del opt-out automatico.
  maxAutoSendsPerDay: 2,
  autoSendHourStart: 8,
  autoSendHourEnd: 20,
  // Se prende solo cuando Meta avisa que bajo la calidad del numero; lo apaga
  // Jere desde el panel. Frena remarketing, recordatorios y masivos.
  qualityGuardActive: false,
  whatsappQuality: null,
  templateQuality: {},
  templateStatus: {},
  // El segundo recordatorio de remarketing (a las 5 h) queda apagado.
  remarketing5hEnabled: false,
  // ---- Fase 7: bajar devoluciones. Todo arranca APAGADO; Jere lo prende cuando carga los datos. ----
  // 7A. Confirmacion del pedido con botones antes de subirlo a DroPanas.
  orderConfirmEnabled: false,
  orderConfirmDelayMin: 20,
  orderConfirmNearCutoffDelayMin: 5,
  orderConfirmReminderAfterH: 4,
  orderConfirmExpireAfterH: 20,
  orderConfirmActivatedAt: null,
  // 7B. Calendario de despacho. Sin hora de corte y sin saber si se despacha el
  // sabado (null) el calendario NO se activa y nadie muestra fechas.
  calendarEnabled: false,
  dispatchCutoffHour: null, // JERE LO CARGA: hora de Caracas (0-23) del corte de despacho en DroPanas
  dispatchCutoffMinute: 0,
  dispatchOnSaturday: null, // JERE LO CARGA: true/false
  // Solo feriados nacionales de FECHA FIJA (2026 y 2027). Carnaval, Semana Santa
  // y los feriados decretados los carga Jere en el panel.
  holidays: [
    '2026-01-01', '2026-04-19', '2026-05-01', '2026-06-24', '2026-07-05', '2026-07-24', '2026-10-12', '2026-12-24', '2026-12-25', '2026-12-31',
    '2027-01-01', '2027-04-19', '2027-05-01', '2027-06-24', '2027-07-05', '2027-07-24', '2027-10-12', '2027-12-24', '2027-12-25', '2027-12-31',
  ],
  transitDaysByRegion: {}, // { 'GRAN CARACAS': { min: 1, max: 2 } } (ver tools/transit-stats.js)
  transitDaysDefault: { min: 2, max: 3 },
  // 7C. Fecha limite de retiro y cupon por retiro rapido.
  tealcaStorageDays: null, // JERE LO CARGA: dias que Tealca guarda el paquete antes de devolverlo
  tealcaStorageBusinessDays: false,
  pickupDeadlineTemplateName: null, // JERE LO CARGA cuando Meta apruebe la plantilla
  pickupDeadlineTemplateLanguage: 'es',
  quickPickupCouponEnabled: false,
  quickPickupHours: 48,
  quickPickupDiscountPercent: 10,
  quickPickupCouponValidDays: 30,
  // 7D. Ultimo aviso antes de la devolucion.
  lastNoticeEnabled: false,
  lastNoticeTemplateName: null, // JERE LO CARGA: plantilla de Utilidad con 3 botones
  lastNoticeTemplateLanguage: 'es',
  lastNoticeHour: 10,
  // ---- Sincronizacion DroPanas ----
  // "Pagado" en DroPanas = el cliente retiro y pago (criterio confirmado por Jere).
  dropanasPaidMeansDelivered: true,
  // Reconciliador horario (S8): arranca apagado hasta que Jere aprueba la primera correccion.
  dropanasReconcileEnabled: false,
  optOutAutoReply: 'Listo, no te enviaremos más mensajes automáticos. Si necesitas algo de tu pedido, escríbenos por aquí cuando quieras.',
};

function load() {
  let settings;
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch (err) {
    settings = { ...DEFAULTS };
  }
  // Migracion: dato viejo de antes de soportar varias fotos en el saludo
  // (welcomeImageId, una sola imagen) todavia sin migrar a welcomeImageIds.
  if (settings.welcomeImageId && (!Array.isArray(settings.welcomeImageIds) || !settings.welcomeImageIds.length)) {
    settings.welcomeImageIds = [settings.welcomeImageId];
  }
  return settings;
}

function save(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function getSettings() {
  return load();
}

function updateSettings(patch) {
  const settings = { ...load(), ...patch };
  save(settings);
  return settings;
}

module.exports = { getSettings, updateSettings, DEFAULTS };

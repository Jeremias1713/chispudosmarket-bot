// Configuracion editable en vivo desde el panel, sin tener que redesplegar.
// Se guarda en un JSON aparte de sessions.json. Todo lo que este vacio/null
// acá cae al valor por variable de entorno (o al default de cada modulo),
// asi que el bot sigue funcionando igual si nunca se toca esto.
//
// OJO: mismo caveat que sessions.json — en el plan gratis de Render el disco
// no es persistente entre reinicios por inactividad.
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

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

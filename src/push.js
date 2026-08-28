// Notificaciones push al celular/PC (tipo Shopify) cuando una conversacion
// pasa a la etapa "vendido". Usa el estandar Web Push (el mismo que usan
// los sitios cuando piden permiso para "mandarte notificaciones"), asi que
// no depende de ninguna app aparte ni de Meta: funciona con el panel
// instalado como PWA o simplemente abierto en el navegador con permiso
// otorgado.
//
// Las claves VAPID (la "identidad" del servidor frente a los navegadores)
// se autogeneran la primera vez y quedan guardadas en un archivo aparte, asi
// no hace falta configurar nada a mano en Render. Igual que sessions.json,
// en el plan gratis de Render el disco no es persistente entre reinicios
// por inactividad, asi que las claves (y las suscripciones) pueden
// perderse en un reinicio; si eso pasa, el usuario solo tiene que volver a
// tocar "Activar notificaciones" una vez.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const VAPID_PATH = path.join(__dirname, '..', 'data', 'push-vapid.json');
const SUBS_PATH = path.join(__dirname, '..', 'data', 'push-subscriptions.json');

function loadVapid() {
  try {
    return JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
  } catch (err) {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_PATH, JSON.stringify(keys, null, 2));
    return keys;
  }
}

const vapidKeys = loadVapid();
webpush.setVapidDetails('mailto:soporte@chispudosmarket.com', vapidKeys.publicKey, vapidKeys.privateKey);

function loadSubs() {
  try {
    return JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
}

function saveSubs(subs) {
  fs.writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2));
}

function getPublicKey() {
  return vapidKeys.publicKey;
}

// Guarda o actualiza una suscripcion (una por dispositivo/navegador). El
// endpoint de la suscripcion es unico por dispositivo, asi que sirve como
// identificador para no duplicar.
function addSubscription(subscription) {
  if (!subscription || !subscription.endpoint) return null;
  const subs = loadSubs();
  const idx = subs.findIndex((s) => s.endpoint === subscription.endpoint);
  if (idx === -1) subs.push(subscription);
  else subs[idx] = subscription;
  saveSubs(subs);
  return subscription;
}

function removeSubscription(endpoint) {
  const subs = loadSubs().filter((s) => s.endpoint !== endpoint);
  saveSubs(subs);
}

// Manda una notificacion a todos los dispositivos suscriptos. Si alguna
// suscripcion ya no es valida (410/404 = el navegador la dio de baja sola,
// por ejemplo porque se desinstalo la app), se borra para no seguir
// intentando en vano.
async function sendToAll(payload) {
  const subs = loadSubs();
  if (!subs.length) return { sent: 0, total: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  const stillValid = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
        sent += 1;
        stillValid.push(sub);
      } catch (err) {
        const statusCode = err?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // suscripcion vencida/invalida: se descarta, no se reintenta.
          return;
        }
        // otro error (red, etc): se deja la suscripcion para el proximo intento.
        console.error('Error mandando push:', statusCode || err.message);
        stillValid.push(sub);
      }
    })
  );

  saveSubs(stillValid);
  return { sent, total: subs.length };
}

// Notificacion de venta nueva. session es la conversacion que acaba de
// pasar a stage 'vendido'.
function notifySale(phone, session) {
  const producto = session?.card?.producto || 'un producto';
  const nombre = session?.card?.nombre || phone;
  const monto = session?.card?.monto;
  const montoTxt = monto != null && !Number.isNaN(Number(monto)) ? ` — ${Number(monto).toLocaleString('es')} Bs` : '';

  return sendToAll({
    title: '💰 Nueva venta',
    body: `${nombre}: ${producto}${montoTxt}`,
    tag: `venta-${phone}`,
    url: '/panel/',
  }).catch((err) => {
    console.error('Error notificando venta:', err.message);
  });
}

module.exports = { getPublicKey, addSubscription, removeSubscription, sendToAll, notifySale };

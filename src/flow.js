// Logica de conversacion: decide que responder segun el mensaje entrante y el
// paso (step) en que esta el cliente. Todo el estado vive en state.js.
const { sendText, sendButtons, sendLocationRequest } = require('./whatsapp');
const { getSession, updateSession, resetSession } = require('./state');
const { formatCatalog, findProduct, findProductByIndex } = require('./catalog');
const { nearestByCoords, searchByText, formatAgency } = require('./agencies');

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'nuestro negocio';

function cartTotal(cart) {
  return cart.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function formatCart(cart) {
  if (!cart.length) return 'Tu pedido esta vacio.';
  const lines = cart.map(
    (i) => `${i.qty} x ${i.name} = ${(i.price * i.qty).toFixed(2)} ${i.currency}`
    );
  return lines.join('\n') + `\n\n*Total: ${cartTotal(cart).toFixed(2)} ${cart[0].currency}*`;
}

async function sendMainMenu(to) {
  await sendButtons(to, `Bienvenido a ${BUSINESS_NAME}. ¿Que deseas hacer?`, [
    { id: 'menu_catalogo', title: 'Ver catalogo' },
    { id: 'menu_agencias', title: 'Agencia cercana' },
    { id: 'menu_pedido', title: 'Mi pedido' },
    ]);
}

// Punto de entrada principal. `message` es el objeto de mensaje tal como lo
// entrega la API de WhatsApp Cloud (puede ser texto, boton, o ubicacion).
async function handleIncomingMessage(from, message) {
  const session = getSession(from);
  const type = message.type;

// Comandos globales, funcionan en cualquier paso.
const rawText =
  type === 'text'
  ? message.text.body.trim()
  : type === 'interactive' && message.interactive?.button_reply
  ? message.interactive.button_reply.id
  : type === 'interactive' && message.interactive?.list_reply
  ? message.interactive.list_reply.id
  : '';
  const lower = rawText.toLowerCase();

if (['menu', 'inicio', 'hola', 'start'].includes(lower)) {
  resetSession(from);
  return sendMainMenu(from);
}
  if (lower === 'reiniciar') {
    resetSession(from);
    await sendText(from, 'Listo, empezamos de nuevo.');
    return sendMainMenu(from);
  }

// Ubicacion compartida por el cliente (desde cualquier paso).
if (type === 'location') {
  const { latitude, longitude } = message.location;
  const nearby = nearestByCoords(latitude, longitude, 3);
  if (!nearby.length) {
    await sendText(from, 'Aun no tenemos agencias cargadas cerca de tu ubicacion.');
  } else {
    const text =
      'Estas son las agencias mas cercanas a tu ubicacion:\n\n' +
      nearby.map(formatAgency).join('\n\n');
    await sendText(from, text);
  }
  return sendMainMenu(from);
}

switch (session.step) {
  case 'START': {
    return sendMainMenu(from);
  }

  case 'MENU':
  default: {
    if (lower === 'menu_catalogo' || lower === 'catalogo' || lower === '1') {
      updateSession(from, { step: 'CATALOG' });
      return sendText(from, formatCatalog());
    }
    if (lower === 'menu_agencias' || lower === 'agencias' || lower === '2') {
      updateSession(from, { step: 'ASK_LOCATION' });
      await sendLocationRequest(
        from,
        'Comparte tu ubicacion y te muestro la agencia mas cercana, o escribe el nombre de tu ciudad.'
        );
      return;
    }
    if (lower === 'menu_pedido' || lower === 'pedido' || lower === '3') {
      updateSession(from, { step: 'CART' });
      await sendText(from, formatCart(session.cart));
      return sendButtons(from, '¿Que deseas hacer?', [
        { id: 'cart_confirm', title: 'Confirmar pedido' },
        { id: 'cart_add', title: 'Agregar mas' },
        { id: 'menu', title: 'Menu principal' },
        ]);
    }
    return sendMainMenu(from);
  }

  case 'CATALOG': {
    const product = findProductByIndex(rawText) || findProduct(rawText);
    if (!product) {
      await sendText(
        from,
        'No encontre ese producto. Responde con el numero o nombre exacto del catalogo, o escribe *menu*.'
        );
      return sendText(from, formatCatalog());
    }
    const cart = [...session.cart];
    const existing = cart.find((i) => i.id === product.id);
    if (existing) {
      existing.qty += 1;
    } else {
      cart.push({ id: product.id, name: product.name, price: product.price, currency: product.currency, qty: 1 });
    }
    updateSession(from, { step: 'CART', cart });
    await sendText(from, `Agregado: ${product.name}.\n\n${formatCart(cart)}`);
    return sendButtons(from, '¿Que deseas hacer ahora?', [
      { id: 'cart_add', title: 'Agregar mas' },
      { id: 'cart_confirm', title: 'Confirmar pedido' },
      { id: 'menu', title: 'Menu principal' },
      ]);
  }

  case 'CART': {
    if (lower === 'cart_add') {
      updateSession(from, { step: 'CATALOG' });
      return sendText(from, formatCatalog());
    }
    if (lower === 'cart_confirm') {
      if (!session.cart.length) {
        await sendText(from, 'Tu pedido esta vacio. Agrega productos del catalogo primero.');
        updateSession(from, { step: 'CATALOG' });
        return sendText(from, formatCatalog());
      }
      updateSession(from, { step: 'ASK_LOCATION_FOR_DELIVERY' });
      await sendText(
        from,
        `Pedido confirmado:\n\n${formatCart(session.cart)}\n\nUn asesor se pondra en contacto para coordinar el pago y la entrega/recogida.`
        );
      await sendLocationRequest(
        from,
        'Para asignarte la agencia mas cercana, comparte tu ubicacion (o escribe tu ciudad).'
        );
      return;
    }
    return sendButtons(from, '¿Que deseas hacer?', [
      { id: 'cart_confirm', title: 'Confirmar pedido' },
      { id: 'cart_add', title: 'Agregar mas' },
      { id: 'menu', title: 'Menu principal' },
      ]);
  }

  case 'ASK_LOCATION':
  case 'ASK_LOCATION_FOR_DELIVERY': {
    // El cliente escribio una ciudad en vez de compartir ubicacion GPS.
    const matches = searchByText(rawText, 3);
    if (!matches.length) {
      await sendText(
        from,
        'No encontre agencias para ese texto. Intenta con el nombre de tu ciudad o pais, o comparte tu ubicacion con el boton de WhatsApp.'
        );
      return;
    }
    await sendText(from, 'Estas son las agencias que encontre:\n\n' + matches.map((a) => formatAgency(a)).join('\n\n'));
    updateSession(from, { step: 'MENU' });
    return sendMainMenu(from);
  }
}
}

module.exports = { handleIncomingMessage };

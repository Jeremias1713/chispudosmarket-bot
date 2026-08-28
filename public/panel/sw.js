// Service worker del panel. Dos trabajos, nada más:
// 1) Dejar que el navegador pueda "instalar" el panel como app (Chrome/Android
//    y compañía piden un service worker con al menos un fetch handler para
//    ofrecer el "Agregar a pantalla de inicio").
// 2) Mostrar la notificación push de "venta nueva" que manda el servidor,
//    incluso con el panel cerrado, y llevar al usuario al panel si la toca.
//
// No hace cache ni trabaja offline a propósito: el panel siempre necesita
// datos frescos del servidor (conversaciones, pedidos), así que "modo avión"
// no tiene mucho sentido acá — mejor que falle claro a que muestre algo viejo.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Passthrough: no intercepta nada, solo deja pasar el pedido tal cual.
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: 'ChispudosMarket', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || '💰 Nueva venta';
  const options = {
    body: data.body || '',
    icon: '/panel/icon-192.png',
    badge: '/panel/icon-192.png',
    tag: data.tag || 'venta',
    data: { url: data.url || '/panel/' },
    vibrate: [120, 60, 120],
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/panel/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/panel/') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

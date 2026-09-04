// La Parisienne Lab — push notification service worker (phase 3, 2026-09-04).
// Deliberately minimal: no fetch handler, no caching/offline logic — this file only reacts to
// push events and notification clicks. Registering it does not change how the app loads or
// caches anything; it purely adds the ability to receive a push while the app/tab is closed.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* ignore malformed payload */ }
  const title = data.title || 'La Parisienne Lab';
  const body = data.body || '';
  const url = data.url || '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'lp-new-order', // a second push while one is still showing replaces it, no notification pile-up
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      for (const c of all) {
        if (c.url.includes(url) && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

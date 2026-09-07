// La Parisienne Lab — push notification service worker (phase 3, 2026-09-04).
// Deliberately minimal: no fetch handler, no caching/offline logic — this file only reacts to
// push events and notification clicks. Registering it does not change how the app loads or
// caches anything; it purely adds the ability to receive a push while the app/tab is closed.

// Take over immediately on update so the fix above applies as soon as the app is next opened,
// without waiting for every tab/PWA instance to be closed first.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

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
      // Unique tag per push (2026-09-07). The previous fixed tag 'lp-new-order' made every new push
      // REPLACE the one still showing — two deliveries confirmed 3 s apart (REP/2026/01344 then
      // 01353 at Timecity) left a single notification on the manager's phone, and any burst
      // (several losses saved together, several exceptional orders) collapsed the same way. A
      // payload may still pass its own `tag` when replacing is the intent (e.g. a repeated
      // reminder), otherwise each push gets its own notification.
      tag: data.tag || ('lp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
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

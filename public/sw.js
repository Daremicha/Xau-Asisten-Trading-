// Service worker for the installed app.
//
// Its main job is notifications: Chrome on Android refuses `new Notification()`
// from a page and only shows ones raised through a service worker, which is
// why TP/SL alerts never reached the phone's notification shade.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Tapping a notification brings the app forward, or opens it if it was closed.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    })
  );
});

// Pages always come from the network: prices and setups are live, and a cached
// copy would show a stale market as if it were current. Offline, say so.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><body style="background:#020617;color:#e2e8f0;font-family:sans-serif;padding:24px"><h2 style="color:#fbbf24">No connection</h2><p>XAUUSD Assistant needs the internet for live prices. Reconnect and reopen the app.</p></body>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        )
    )
  );
});

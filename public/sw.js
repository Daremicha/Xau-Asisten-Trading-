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

// A push from the server, which watches the open setup while the app is
// closed. It always shows something: a push that shows nothing is treated by
// the browser as abuse and can cost the site its permission.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'XAU Assistant', {
      body: data.body || '',
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      requireInteraction: true,
      vibrate: [200, 100, 200],
      timestamp: Date.now(),
    })
  );
});

// The browser can replace a subscription on its own, when the push service
// rotates keys or expires one. The server would then keep pushing to an
// address nobody reads, and alerts stopped until the app happened to be
// opened. Subscribe again at once and hand the server the new address with
// the old one, so it moves the watched trade and the scan settings across.
self.addEventListener('pushsubscriptionchange', (event) => {
  const previous = event.oldSubscription;
  event.waitUntil(
    (async () => {
      let subscription = event.newSubscription;
      if (!subscription) {
        const config = await (await fetch('/api/push/config')).json();
        if (!config || !config.enabled || !config.publicKey) return;
        const padded = (config.publicKey + '='.repeat((4 - (config.publicKey.length % 4)) % 4))
          .replace(/-/g, '+')
          .replace(/_/g, '/');
        const raw = atob(padded);
        const key = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
      }
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          previousEndpoint: previous ? previous.endpoint : undefined,
        }),
      });
    })().catch(() => {})
  );
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

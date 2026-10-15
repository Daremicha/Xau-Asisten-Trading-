'use client';

import { useEffect } from 'react';

/** Registers the service worker that makes the site installable and delivers notifications. */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // Always fetched fresh, so a fix to how notifications are delivered
    // reaches the phone on the next open instead of a day later.
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update().catch(() => undefined))
      .catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
  }, []);
  return null;
}

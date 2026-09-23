'use client';

import { useEffect } from 'react';

/** Registers the service worker that makes the site installable and delivers notifications. */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  }, []);
  return null;
}

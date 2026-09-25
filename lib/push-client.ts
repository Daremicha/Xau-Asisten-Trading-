/**
 * The browser side of closed-app alerts: subscribe this device to push, and
 * keep the server told which setup to watch.
 */

import type { InstitutionalTradingSetup } from './types';

export type PushSetupState = 'on' | 'unconfigured' | 'unsupported' | 'denied' | 'failed';

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Only the fields the server watches; nothing about the account travels. */
function watchedFields(setup: InstitutionalTradingSetup | null) {
  if (!setup) return null;
  return {
    id: setup.id,
    orderType: setup.orderType,
    entryPrice: setup.entryPrice,
    stopLoss: setup.stopLoss,
    takeProfit1: setup.takeProfit1,
    takeProfit2: setup.takeProfit2,
    takeProfit3: setup.takeProfit3,
    timestamp: setup.timestamp,
    validUntil: setup.validUntil,
    filledAt: setup.filledAt,
    status: setup.status,
  };
}

let lastSynced: string | null = null;

async function post(subscription: PushSubscription, setup: InstitutionalTradingSetup | null): Promise<boolean> {
  const body = JSON.stringify({ subscription: subscription.toJSON(), setup: watchedFields(setup) });
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (res.ok) lastSynced = body;
  return res.ok;
}

/**
 * Subscribes this device, after notification permission has been granted, and
 * sends the current setup along. Safe to call again: an existing subscription
 * is reused.
 */
export async function enableClosedAppAlerts(setup: InstitutionalTradingSetup | null): Promise<PushSetupState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission !== 'granted') return 'denied';
  try {
    const config = (await (await fetch('/api/push/config')).json()) as { enabled?: boolean; publicKey?: string };
    if (!config.enabled || !config.publicKey) return 'unconfigured';

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      });
    }
    return (await post(subscription, setup)) ? 'on' : 'failed';
  } catch (err) {
    console.warn('Closed-app alerts could not be enabled:', err);
    return 'failed';
  }
}

/**
 * Tells the server about a change to the active setup. Does nothing on a
 * device that never subscribed, and nothing when the watched fields have not
 * changed since the last successful sync.
 */
export async function syncWatchedSetup(setup: InstitutionalTradingSetup | null): Promise<void> {
  if (!supported() || Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    const body = JSON.stringify({ subscription: subscription.toJSON(), setup: watchedFields(setup) });
    if (body === lastSynced) return;
    await post(subscription, setup);
  } catch (err) {
    console.warn('Could not sync the watched setup:', err);
  }
}

export interface ClosedAppAlertStatus {
  /** The browser can receive push at all. */
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  /** This phone has a push subscription. */
  subscribed: boolean;
  /** The server has push configured. */
  serverEnabled: boolean;
  /** When the scheduled watcher last ran, or null when it never has. */
  lastCheckAt: string | null;
}

/** Everything the status panel needs to say whether alerts will arrive with the app closed. */
export async function closedAppAlertStatus(): Promise<ClosedAppAlertStatus> {
  if (!supported()) {
    return { supported: false, permission: 'unsupported', subscribed: false, serverEnabled: false, lastCheckAt: null };
  }
  let serverEnabled = false;
  let lastCheckAt: string | null = null;
  try {
    const config = (await (await fetch('/api/push/config', { cache: 'no-store' })).json()) as {
      enabled?: boolean;
      lastCheckAt?: string | null;
    };
    serverEnabled = Boolean(config.enabled);
    lastCheckAt = config.lastCheckAt ?? null;
  } catch {
    // Unknown reads as not enabled; the panel says so.
  }
  let subscribed = false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    subscribed = Boolean(await registration?.pushManager.getSubscription());
  } catch {
    subscribed = false;
  }
  return { supported: true, permission: Notification.permission, subscribed, serverEnabled, lastCheckAt };
}

/** Asks the server for a test notification in a few seconds. Returns an error to show, or null. */
export async function sendTestPush(): Promise<string | null> {
  if (!supported()) return 'This browser cannot receive push notifications.';
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return 'This phone is not signed up yet. Allow notifications first.';
    const res = await fetch('/api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return res.ok ? null : data?.error ?? `The test failed (HTTP ${res.status}).`;
  } catch {
    return 'The test could not be requested.';
  }
}

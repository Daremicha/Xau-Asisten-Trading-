/**
 * Browser Notification & Price Proximity Utility
 * Triggers native browser notifications, in-app visual alerts, and synthesized audio chimes
 * when marketPrice approaches active setup Take Profit or Stop Loss levels.
 */

import { nearLevelAlert } from './trade-alerts';
import { InstitutionalTradingSetup } from './types';

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface ProximityAlertEvent {
  id: string;
  levelKey: 'TP1' | 'TP2' | 'TP3' | 'SL';
  levelLabel: string;
  targetPrice: number;
  currentPrice: number;
  distanceDollars: number;
  distancePips: number;
  isBreached: boolean;
  alertType: 'TP' | 'SL';
  title: string;
  message: string;
  timestamp: string;
}

/**
 * Checks browser support for native notifications.
 */
export function getNotificationPermission(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission as NotificationPermissionState;
}

/**
 * Requests browser permission to trigger system notifications.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  try {
    const result = await Notification.requestPermission();
    return result as NotificationPermissionState;
  } catch (err) {
    console.warn('Notification permission request exception:', err);
    return 'denied';
  }
}

/**
 * Synthesizes real-time audio chimes using Web Audio API.
 * Does not require external audio files, working seamlessly in sandboxed environments.
 */
export function playProximityChime(alertType: 'TP' | 'SL') {
  if (typeof window === 'undefined') return;

  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextClass) return;

    const ctx = new AudioContextClass();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const now = ctx.currentTime;

    if (alertType === 'TP') {
      // Harmonic ascending triad for Take Profit proximity (C5 -> E5 -> G5)
      const freqs = [523.25, 659.25, 783.99];
      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.12);

        gain.gain.setValueAtTime(0.001, now + idx * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.2, now + idx * 0.12 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.35);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + idx * 0.12);
        osc.stop(now + idx * 0.12 + 0.4);
      });
    } else {
      // Double warning pulse for Stop Loss proximity
      const warningFreq = 440; // A4
      [0, 0.18].forEach((offset) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(warningFreq, now + offset);

        gain.gain.setValueAtTime(0.001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.14);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + offset);
        osc.stop(now + offset + 0.16);
      });
    }
  } catch {
    // AudioContext blocked or not allowed by user gesture, fail silently
  }
}

/**
 * Shows a system notification.
 *
 * Through the service worker whenever there is one: Chrome on Android throws
 * on `new Notification()` from a page, so that path never reached a phone. The
 * constructor stays as the fallback for desktop browsers without a worker.
 */
export async function triggerBrowserNotification(
  title: string,
  options?: NotificationOptions
): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;

  const full: NotificationOptions = {
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    silent: false,
    ...options,
  };

  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.showNotification(title, full);
        return true;
      }
    } catch (err) {
      console.warn('Service worker notification failed:', err);
    }
  }

  try {
    new Notification(title, full);
    return true;
  } catch (err) {
    console.warn('Notification failed:', err);
    return false;
  }
}

/**
 * In-memory registry to track alert cooldowns across levels.
 */
const lastAlertTimestamps: Record<string, number> = {};

/**
 * Evaluates whether marketPrice is within proximity threshold of active setup TP or SL.
 * Threshold is within $1.00 (10 pips) for XAUUSD.
 */
export function evaluatePriceProximity(
  currentPrice: number,
  setup: InstitutionalTradingSetup | null,
  options: {
    proximityThresholdDollars?: number;
    cooldownMs?: number;
    enableSound?: boolean;
    enableBrowserNotification?: boolean;
  } = {}
): ProximityAlertEvent | null {
  if (!setup || !setup.entryPrice || setup.status !== 'ACTIVE') {
    return null;
  }

  const threshold = options.proximityThresholdDollars ?? 1.0; // $1.00 = 10 pips
  const cooldown = options.cooldownMs ?? 300000; // 5 minutes cooldown per level
  const now = Date.now();

  const isBuy = setup.orderType.includes('BUY');

  const targets = [
    {
      key: 'TP1' as const,
      label: 'Take Profit 1',
      price: setup.takeProfit1,
      type: 'TP' as const,
    },
    {
      key: 'TP2' as const,
      label: 'Take Profit 2',
      price: setup.takeProfit2,
      type: 'TP' as const,
    },
    {
      key: 'TP3' as const,
      label: 'Take Profit 3',
      price: setup.takeProfit3,
      type: 'TP' as const,
    },
    {
      key: 'SL' as const,
      label: 'Stop Loss',
      price: setup.stopLoss,
      type: 'SL' as const,
    },
  ];

  for (const t of targets) {
    if (!t.price || t.price <= 0) continue;

    const diff = Math.abs(currentPrice - t.price);
    const distanceDollars = parseFloat(diff.toFixed(2));
    const distancePips = parseFloat((diff * 10).toFixed(1));

    // Check if price has breached or is approaching within threshold
    let isApproaching = false;
    let isBreached = false;

    if (t.type === 'TP') {
      if (isBuy) {
        isBreached = currentPrice >= t.price;
        isApproaching = !isBreached && t.price - currentPrice <= threshold;
      } else {
        isBreached = currentPrice <= t.price;
        isApproaching = !isBreached && currentPrice - t.price <= threshold;
      }
    } else {
      // Stop Loss
      if (isBuy) {
        isBreached = currentPrice <= t.price;
        isApproaching = !isBreached && currentPrice - t.price <= threshold;
      } else {
        isBreached = currentPrice >= t.price;
        isApproaching = !isBreached && t.price - currentPrice <= threshold;
      }
    }

    if (isApproaching || isBreached) {
      const alertKey = `${setup.id}_${t.key}`;
      const lastFired = lastAlertTimestamps[alertKey] || 0;

      if (now - lastFired > cooldown) {
        lastAlertTimestamps[alertKey] = now;

        const title =
          t.type === 'TP'
            ? `Dekat Take Profit: ${t.label} di $${t.price.toFixed(2)}`
            : `Peringatan: Mendekati ${t.label} di $${t.price.toFixed(2)}`;

        const message = isBreached
          ? `Harga XAUUSD $${currentPrice.toFixed(2)} sudah mencapai ${t.label} ($${t.price.toFixed(2)}).`
          : `Harga XAUUSD $${currentPrice.toFixed(2)} tinggal ${distancePips} pips ($${distanceDollars.toFixed(2)}) dari ${t.label} ($${t.price.toFixed(2)}).`;

        if (options.enableSound !== false) {
          playProximityChime(t.type);
        }

        // The phone is told only about the stop and the first target coming
        // near, in the same words and under the same tag as the server's
        // alert. A level already reached is a close, which has its own
        // notification; repeating "reached" every few minutes only confused.
        if (options.enableBrowserNotification !== false && isApproaching && (t.key === 'SL' || t.key === 'TP1')) {
          const alert = nearLevelAlert(setup, t.key, currentPrice);
          void triggerBrowserNotification(alert.title, { body: alert.body, tag: alert.tag });
        }

        return {
          id: `${alertKey}_${now}`,
          levelKey: t.key,
          levelLabel: t.label,
          targetPrice: t.price,
          currentPrice,
          distanceDollars,
          distancePips,
          isBreached,
          alertType: t.type,
          title,
          message,
          timestamp: new Date().toLocaleTimeString('en-US', {
            timeZone: 'Asia/Jakarta',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          }) + ' WIB',
        };
      }
    }
  }

  return null;
}

/**
 * Resets cooldown for a specific setup or all alerts.
 */
export function resetAlertCooldown(setupId?: string) {
  if (setupId) {
    Object.keys(lastAlertTimestamps).forEach((k) => {
      if (k.startsWith(setupId)) {
        delete lastAlertTimestamps[k];
      }
    });
  } else {
    Object.keys(lastAlertTimestamps).forEach((k) => delete lastAlertTimestamps[k]);
  }
}

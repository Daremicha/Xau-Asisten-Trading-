import { NextResponse } from 'next/server';
import { vapidPublicKey } from '@/lib/push-send';
import { lastCheck, storeConfigured } from '@/lib/push-store';

export const dynamic = 'force-dynamic';

/**
 * Whether closed-app alerts are set up on this deployment, the key to
 * subscribe with, and when the scheduled watcher last ran. A watcher that has
 * stopped running is the usual reason alerts only appear once the app is
 * opened, so the app shows it.
 */
export async function GET() {
  const publicKey = vapidPublicKey();
  const enabled = Boolean(publicKey) && storeConfigured();
  let lastCheckAt: string | null = null;
  if (enabled) {
    try {
      lastCheckAt = (await lastCheck())?.at ?? null;
    } catch {
      lastCheckAt = null;
    }
  }
  return NextResponse.json({ enabled, publicKey: enabled ? publicKey : null, lastCheckAt });
}

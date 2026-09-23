import { NextResponse } from 'next/server';
import { vapidPublicKey } from '@/lib/push-send';
import { storeConfigured } from '@/lib/push-store';

export const dynamic = 'force-dynamic';

/** Whether closed-app alerts are set up on this deployment, and the key to subscribe with. */
export async function GET() {
  const publicKey = vapidPublicKey();
  const enabled = Boolean(publicKey) && storeConfigured();
  return NextResponse.json({ enabled, publicKey: enabled ? publicKey : null });
}

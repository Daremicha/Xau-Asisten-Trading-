import { NextResponse } from 'next/server';
import { sanitiseSubscription } from '@/lib/push-watch';
import { loadRecord, recordId, saveRecord, storeConfigured } from '@/lib/push-store';
import { OFFER_TTL_MS } from '@/lib/setup-scan';

export const dynamic = 'force-dynamic';

/**
 * Hands the app the setup the scan announced, once. Knowing the subscription
 * endpoint is what proves the caller is the phone it was announced to.
 */
export async function POST(request: Request) {
  if (!storeConfigured()) return NextResponse.json({ success: true, setup: null });
  const body = (await request.json().catch(() => null)) as { subscription?: unknown } | null;
  const subscription = sanitiseSubscription(body?.subscription);
  if (!subscription) {
    return NextResponse.json({ success: false, error: 'Langganan push tidak valid.' }, { status: 400 });
  }
  try {
    const id = recordId(subscription.endpoint);
    const record = await loadRecord(id);
    const offer = record?.offer;
    if (!record || !offer) return NextResponse.json({ success: true, setup: null });
    // Taken or not, an offer is handed out once; an old one is simply dropped.
    await saveRecord(id, { ...record, offer: null, updatedAt: new Date().toISOString() });
    const fresh = Date.now() - Date.parse(offer.at) < OFFER_TTL_MS;
    return NextResponse.json({ success: true, setup: fresh ? offer.setup : null, announcedAt: offer.at });
  } catch (err) {
    console.warn('Offer lookup failed:', err);
    return NextResponse.json({ success: false, error: 'Setup yang diumumkan tidak bisa dibaca.' }, { status: 502 });
  }
}

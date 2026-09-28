import { NextResponse } from 'next/server';
import { sanitiseSubscription, sanitiseWatchedSetup } from '@/lib/push-watch';
import { sanitiseScanSettings } from '@/lib/setup-scan';
import { deleteRecord, loadRecord, recordId, saveRecord, storeConfigured } from '@/lib/push-store';

export const dynamic = 'force-dynamic';

/**
 * Registers a phone for closed-app alerts, and tells the server which setup it
 * is watching. Sent again whenever the setup changes; a null setup, or one the
 * user has resolved, stops the watching.
 *
 * Knowing the subscription endpoint is what proves the caller owns it: the
 * endpoint is an unguessable URL only that browser was given.
 */
export async function POST(request: Request) {
  if (!storeConfigured()) {
    return NextResponse.json({ success: false, error: 'Push storage is not configured.' }, { status: 503 });
  }
  const body = (await request.json().catch(() => null)) as {
    subscription?: unknown;
    setup?: unknown;
    scan?: unknown;
  } | null;
  const subscription = sanitiseSubscription(body?.subscription);
  if (!subscription) {
    return NextResponse.json({ success: false, error: 'Invalid push subscription.' }, { status: 400 });
  }

  const setup = sanitiseWatchedSetup(body?.setup);
  const id = recordId(subscription.endpoint);

  try {
    const existing = await loadRecord(id);
    const sameSetup = Boolean(existing?.setup && setup && existing.setup.id === setup.id);
    const sent = sameSetup ? existing!.sent : [];
    const finished = sameSetup ? Boolean(existing!.finished) : false;
    // The open app already showed the fill, so the server should not repeat it.
    if (setup?.status === 'ACTIVE' && !sent.includes(`${setup.id}:filled`)) sent.push(`${setup.id}:filled`);

    // A phone that sends no scan settings keeps whatever it had; one that
    // sends them replaces them. An open trade does not stop the settings being
    // kept, only the scan itself from running.
    const scan = body?.scan === undefined ? existing?.scan ?? null : sanitiseScanSettings(body.scan);
    await saveRecord(id, {
      subscription,
      setup,
      sent,
      finished,
      scan,
      // Once the app holds a setup, the announced one has been taken up.
      offer: setup ? null : existing?.offer ?? null,
      lastOffer: existing?.lastOffer ?? null,
      lastScan: existing?.lastScan ?? null,
      updatedAt: new Date().toISOString(),
    });
    return NextResponse.json({ success: true, watching: setup !== null && !finished });
  } catch (err) {
    console.warn('Push subscribe failed:', err);
    return NextResponse.json({ success: false, error: 'Could not save the subscription.' }, { status: 502 });
  }
}

export async function DELETE(request: Request) {
  if (!storeConfigured()) return NextResponse.json({ success: true });
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (typeof body?.endpoint !== 'string') {
    return NextResponse.json({ success: false, error: 'endpoint is required.' }, { status: 400 });
  }
  try {
    await deleteRecord(recordId(body.endpoint));
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, error: 'Could not remove the subscription.' }, { status: 502 });
  }
}

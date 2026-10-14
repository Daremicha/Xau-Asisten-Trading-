import { NextResponse } from 'next/server';
import { sanitiseSubscription } from '@/lib/push-watch';
import { loadRecord, recordId, storeConfigured } from '@/lib/push-store';

export const dynamic = 'force-dynamic';

/**
 * What the server holds for this phone: whether it is registered, whether the
 * scan for new setups covers it, and what that scan last found. Knowing the
 * subscription endpoint is what proves the caller is that phone.
 */
export async function POST(request: Request) {
  if (!storeConfigured()) return NextResponse.json({ success: true, registered: false });
  const body = (await request.json().catch(() => null)) as { subscription?: unknown } | null;
  const subscription = sanitiseSubscription(body?.subscription);
  if (!subscription) {
    return NextResponse.json({ success: false, error: 'Langganan push tidak valid.' }, { status: 400 });
  }
  try {
    const record = await loadRecord(recordId(subscription.endpoint));
    return NextResponse.json({
      success: true,
      registered: Boolean(record),
      scanning: Boolean(record?.scan),
      watchingTrade: Boolean(record?.setup && !record.finished),
      lastScan: record?.lastScan ?? null,
    });
  } catch (err) {
    console.warn('Push status failed:', err);
    return NextResponse.json({ success: false, error: 'Status notifikasi tidak bisa dibaca.' }, { status: 502 });
  }
}

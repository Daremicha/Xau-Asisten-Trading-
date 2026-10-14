import { after, NextResponse } from 'next/server';
import { sanitiseSubscription } from '@/lib/push-watch';
import { sendPush } from '@/lib/push-send';
import { claimTest, loadRecord, recordId, storeConfigured } from '@/lib/push-store';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Long enough to close the app, which is the whole point of the test. */
const DELAY_MS = 10_000;

/**
 * Sends one test notification to a phone that has already signed up, ten
 * seconds from now. Closing the app in that time shows whether alerts reach
 * this phone with the app closed, separately from whether the scheduler runs.
 */
export async function POST(request: Request) {
  if (!storeConfigured()) {
    return NextResponse.json({ success: false, error: 'Penyimpanan push belum diatur.' }, { status: 503 });
  }
  const body = (await request.json().catch(() => null)) as { subscription?: unknown } | null;
  const subscription = sanitiseSubscription(body?.subscription);
  if (!subscription) {
    return NextResponse.json({ success: false, error: 'Langganan push tidak valid.' }, { status: 400 });
  }
  const id = recordId(subscription.endpoint);

  try {
    // Only phones that signed up here, and one test a minute each.
    if (!(await loadRecord(id))) {
      return NextResponse.json({ success: false, error: 'HP ini belum terdaftar untuk notifikasi.' }, { status: 404 });
    }
    if (!(await claimTest(id))) {
      return NextResponse.json({ success: false, error: 'Tes baru dikirim kurang dari semenit lalu.' }, { status: 429 });
    }

    // Answered at once and sent afterwards, so closing the app, which ends the
    // request on the phone's side, cannot cancel the test.
    after(async () => {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      await sendPush(subscription, {
        key: 'test',
        title: '✅ TES: notifikasi sampai ke HP ini',
        body: 'Kalau ini muncul saat aplikasi tertutup, notifikasi order terisi, TP, SL, dan order missed akan sampai dengan cara yang sama.',
        tag: 'push-test',
        final: false,
      });
    });
    return NextResponse.json({ success: true, delaySeconds: DELAY_MS / 1000 });
  } catch (err) {
    console.warn('Push test failed:', err);
    return NextResponse.json({ success: false, error: 'Tes tidak bisa dikirim.' }, { status: 502 });
  }
}

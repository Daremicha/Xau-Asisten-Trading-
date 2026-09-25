import { NextResponse } from 'next/server';
import { getMarketSnapshot } from '@/lib/price-feed';
import { replayOrder } from '@/lib/order-replay';
import { messagesFor } from '@/lib/push-watch';
import { sendPush, vapidPublicKey } from '@/lib/push-send';
import {
  claimCheck,
  deleteRecord,
  loadRecord,
  recordCheck,
  saveRecord,
  storeConfigured,
  watchingIds,
} from '@/lib/push-store';

export const dynamic = 'force-dynamic';

/** Minimum gap between checks, whoever triggers them. */
const CHECK_GAP_SECONDS = 45;

/**
 * Checks every watched setup against the market and pushes what changed.
 *
 * Called on a schedule from outside (cron-job.org, every minute), because the
 * point is to run while every phone has the app closed. When PUSH_CRON_SECRET
 * is set the caller must present it; either way checks are spaced at least
 * CHECK_GAP_SECONDS apart, so an outside caller cannot burn the quote budget.
 */
async function run(request: Request) {
  const secret = process.env.PUSH_CRON_SECRET?.trim();
  if (secret) {
    const url = new URL(request.url);
    const presented =
      request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('key') ?? '';
    if (presented !== secret) {
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }
  }

  if (!storeConfigured() || !vapidPublicKey()) {
    return NextResponse.json(
      { success: false, error: 'Closed-app alerts are not configured on this deployment.' },
      { status: 503 }
    );
  }

  try {
    if (!(await claimCheck(CHECK_GAP_SECONDS))) {
      return NextResponse.json({ success: true, skipped: 'A check ran moments ago.' });
    }

    const ids = await watchingIds();
    // Nothing to watch means nothing to spend a quote on. The run is still
    // noted, so the app can show that the scheduler is alive.
    if (ids.length === 0) {
      await recordCheck({ at: new Date().toISOString(), watching: 0, sent: 0 });
      return NextResponse.json({ success: true, watching: 0, sent: 0 });
    }

    const snapshot = await getMarketSnapshot(true);
    const now = Date.now();
    const price = snapshot.price;
    const candles = [...snapshot.candlesM15];
    // The latest tick as a bar of its own, so a touch since the last candle
    // opened is seen now rather than on the next one.
    if (price !== null) candles.push({ time: now, open: price, high: price, low: price, close: price, volume: 0 });

    let sent = 0;
    for (const id of ids) {
      const record = await loadRecord(id);
      if (!record?.setup || record.finished) {
        if (!record) await deleteRecord(id);
        else await saveRecord(id, record);
        continue;
      }

      const verdict = replayOrder(record.setup, candles, now);
      const messages = messagesFor(record.setup, verdict, price, new Set(record.sent));
      let gone = false;
      let finished = false;
      for (const message of messages) {
        const outcome = await sendPush(record.subscription, message);
        if (outcome === 'gone') {
          gone = true;
          break;
        }
        if (outcome === 'sent') {
          sent += 1;
          record.sent.push(message.key);
          if (message.final) finished = true;
        }
      }

      if (gone) {
        await deleteRecord(id);
        continue;
      }
      if (messages.length > 0) {
        await saveRecord(id, {
          ...record,
          finished,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    await recordCheck({ at: new Date().toISOString(), watching: ids.length, sent });
    return NextResponse.json({ success: true, watching: ids.length, sent, price });
  } catch (err) {
    console.warn('Push check failed:', err);
    return NextResponse.json({ success: false, error: 'The check could not complete.' }, { status: 502 });
  }
}

export const GET = run;
export const POST = run;

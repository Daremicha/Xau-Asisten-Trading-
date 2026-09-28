import { NextResponse } from 'next/server';
import { getMarketSnapshot } from '@/lib/price-feed';
import { replayOrder } from '@/lib/order-replay';
import { messagesFor } from '@/lib/push-watch';
import { isGoldMarketClosed } from '@/lib/market-hours';
import { runAnalysis } from '@/lib/run-analysis';
import {
  isRepeat,
  noSetupNote,
  OFFER_TTL_MS,
  offerKey,
  SCAN_EVERY_SECONDS,
  scanRequest,
  type ScanResult,
} from '@/lib/setup-scan';
import { newSetupAlert } from '@/lib/trade-alerts';
import { reviewOnce } from '@/lib/ai-review-store';
import type { InstitutionalTradingSetup } from '@/lib/types';
import { sendPush, vapidPublicKey } from '@/lib/push-send';
import {
  claimCheck,
  claimScan,
  deleteRecord,
  loadRecord,
  type PushRecord,
  recordCheck,
  saveRecord,
  scanningIds,
  storeConfigured,
  watchingIds,
} from '@/lib/push-store';

export const dynamic = 'force-dynamic';
// A scan runs a full analysis per phone, which takes a few seconds.
export const maxDuration = 60;

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
    // Every fifteen minutes, whether or not a trade is open, look for a new
    // setup for the phones that asked. Its own lock keeps it to that pace.
    const scanned = await scanForSetups();
    // Nothing to watch means nothing to spend a quote on. The run is still
    // noted, so the app can show that the scheduler is alive.
    if (ids.length === 0) {
      await recordCheck({ at: new Date().toISOString(), watching: 0, sent: scanned });
      return NextResponse.json({ success: true, watching: 0, sent: 0, offered: scanned });
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

    await recordCheck({ at: new Date().toISOString(), watching: ids.length, sent: sent + scanned });
    return NextResponse.json({ success: true, watching: ids.length, sent, offered: scanned, price });
  } catch (err) {
    console.warn('Push check failed:', err);
    return NextResponse.json({ success: false, error: 'The check could not complete.' }, { status: 502 });
  }
}

/**
 * Runs the user's analysis for every phone that asked for new-setup alerts and
 * has no trade in play, and pushes any setup that passes. Returns how many
 * were announced.
 */
async function scanForSetups(): Promise<number> {
  const now = Date.now();
  if (isGoldMarketClosed(now)) return 0;
  const ids = await scanningIds();
  if (ids.length === 0 || !(await claimScan(SCAN_EVERY_SECONDS))) return 0;

  let offered = 0;
  for (const id of ids) {
    const record = await loadRecord(id);
    if (!record?.scan) continue;
    const at = new Date(now).toISOString();
    // Every pass is noted on the phone's record, so the app can show that the
    // scan ran and what it found, and a quiet market is not mistaken for a
    // broken alert.
    const note = (outcome: ScanResult['outcome'], text: string, extra: Partial<PushRecord> = {}) =>
      saveRecord(id, { ...record, ...extra, lastScan: { at, outcome, note: text }, updatedAt: at });

    // A trade in play, or a setup already announced and not yet loaded, is
    // enough to be getting on with.
    if (record.setup && !record.finished) {
      await note('held', 'a trade is in play on this phone');
      continue;
    }
    if (record.offer && now - Date.parse(record.offer.at) < OFFER_TTL_MS) {
      await note('held', 'an announced setup is waiting to be opened');
      continue;
    }

    const input = scanRequest(record.scan);
    if (!input) {
      await note('error', 'the settings sent by the app could not be read');
      continue;
    }
    const result = await runAnalysis(input).catch(() => null);
    if (!result || result.status !== 200) {
      const error = (result?.body as { error?: unknown } | undefined)?.error;
      await note('error', `analysis failed${typeof error === 'string' ? `: ${error.slice(0, 120)}` : ''}`);
      continue;
    }
    const setup = (result.body as { setup?: InstitutionalTradingSetup | null }).setup;
    if (!setup) {
      await note('no-setup', noSetupNote(result.body));
      continue;
    }

    const key = offerKey(setup);
    if (isRepeat(key, record.lastOffer, now)) {
      await note('held', `same ${setup.orderType} @ ${setup.entryPrice.toFixed(2)} already announced`);
      continue;
    }

    // The models' opinion rides along with the announcement. It never stops
    // one: their verdicts are recorded and judged on live results first.
    const aiReview = await reviewOnce(setup, setup.currentMarketPrice ?? null)
      .then((r) => (r.status === 'done' ? r.review : undefined))
      .catch(() => undefined);
    const stored = {
      ...setup,
      protectAtR: record.scan.protectAtR,
      ...(aiReview !== undefined ? { aiReview } : {}),
    };
    const alert = newSetupAlert(stored, setup.id);
    const outcome = await sendPush(record.subscription, {
      key: `${setup.id}:new`,
      ...alert,
      final: false,
    });
    if (outcome === 'gone') {
      await deleteRecord(id);
      continue;
    }
    if (outcome === 'sent') offered += 1;
    await note(
      outcome === 'sent' ? 'announced' : 'error',
      outcome === 'sent'
        ? `announced ${setup.orderType} @ ${setup.entryPrice.toFixed(2)}`
        : `found ${setup.orderType} @ ${setup.entryPrice.toFixed(2)} but the notification could not be sent`,
      { offer: { setup: stored, at }, lastOffer: { key, at } }
    );
  }
  return offered;
}

export const GET = run;
export const POST = run;

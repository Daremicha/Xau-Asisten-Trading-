import { NextResponse } from 'next/server';
import {
  fetchHistoryPage,
  HISTORY_SYMBOLS,
  toWire,
  type HistoryInterval,
  type HistoryPage,
  type HistorySymbol,
} from '@/lib/history-feed';

export const dynamic = 'force-dynamic';

/**
 * One page of historical candles for the backtest.
 *
 * The client walks backwards by passing the oldest timestamp it already holds
 * as `before`, until the response says the provider is exhausted. Pages are
 * cached in the running instance because the free Twelve Data plan allows only
 * eight requests a minute and a two year download needs about a dozen.
 */
/**
 * Pages kept in memory. A 24 month M15 replay needs about a dozen, so this
 * covers a full run and a re-run without holding tens of megabytes of candles
 * in a serverless instance that may be reused for anything else.
 */
const CACHE_LIMIT = 16;
const pageCache = new Map<string, HistoryPage>();

function cacheKey(interval: HistoryInterval, before: number | null, symbol: HistorySymbol): string {
  return `${symbol}:${interval}:${before ?? 'latest'}`;
}

function remember(key: string, page: HistoryPage) {
  // A rate limit notice is a temporary state, never an answer worth keeping.
  if (page.retryAfterMs !== null || page.candles.length === 0) return;
  if (pageCache.size >= CACHE_LIMIT) {
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
  pageCache.set(key, page);
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  const rawInterval = url.searchParams.get('interval') ?? '15min';
  if (rawInterval !== '5min' && rawInterval !== '15min' && rawInterval !== '1h') {
    return NextResponse.json(
      { success: false, error: 'interval must be 5min, 15min or 1h.' },
      { status: 400 }
    );
  }
  const interval: HistoryInterval = rawInterval;

  const rawSymbol = url.searchParams.get('symbol') ?? 'XAU/USD';
  if (!HISTORY_SYMBOLS.includes(rawSymbol as HistorySymbol)) {
    return NextResponse.json(
      { success: false, error: `symbol must be one of ${HISTORY_SYMBOLS.join(', ')}.` },
      { status: 400 }
    );
  }
  const symbol = rawSymbol as HistorySymbol;

  const rawBefore = url.searchParams.get('before');
  let before: number | null = null;
  if (rawBefore !== null && rawBefore !== '') {
    const parsed = Number(rawBefore);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { success: false, error: 'before must be a millisecond timestamp.' },
        { status: 400 }
      );
    }
    before = Math.floor(parsed);
  }

  const key = cacheKey(interval, before, symbol);
  const cached = pageCache.get(key);
  if (cached) {
    return NextResponse.json({ success: true, cached: true, ...cached, candles: toWire(cached.candles) });
  }

  try {
    const page = await fetchHistoryPage(interval, before, symbol);
    remember(key, page);

    // A rate limit is not an error the caller should give up on, so it comes
    // back as a normal response carrying how long to wait.
    return NextResponse.json({
      success: page.candles.length > 0 || page.retryAfterMs !== null,
      cached: false,
      ...page,
      candles: toWire(page.candles),
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'History download failed.',
      },
      { status: 502 }
    );
  }
}

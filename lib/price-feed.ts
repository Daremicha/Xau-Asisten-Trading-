/**
 * Server side XAUUSD price feed.
 *
 * Design rule: this module never invents a price. When every provider fails it
 * reports `unavailable`, or serves the last good snapshot explicitly marked
 * `stale` with its age. Callers are expected to surface that to the user rather
 * than presenting fabricated numbers as a live quote.
 */

import { Candle, round2 } from './candles';

export type FeedStatus = 'live' | 'stale' | 'unavailable';

export interface MarketSnapshot {
  status: FeedStatus;
  /** Human readable provider name, null when nothing could be reached. */
  source: string | null;
  /** ISO timestamp of the moment the data was pulled from the provider. */
  fetchedAt: string | null;
  /** Milliseconds since that fetch. Zero for a fresh pull. */
  ageMs: number;
  price: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  previousClose: number | null;
  /** Chronological M15 candles, oldest first. */
  candlesM15: Candle[];
  /** Explains the status, especially when data is stale or missing. */
  message: string;
}

interface ProviderResult {
  source: string;
  price: number;
  dayHigh: number | null;
  dayLow: number | null;
  previousClose: number | null;
  candlesM15: Candle[];
}

/**
 * How long a snapshot stays fresh before we refetch.
 *
 * This is a quota decision, not a performance one. The Twelve Data free tier
 * allows 800 requests a day. A refresh only happens when someone actually asks
 * for data, so the daily cost is (hours of use x 3600) / this value. At the 60
 * second default, eight hours of continuous use costs 480 requests, which fits
 * comfortably. Lower it only on a paid plan.
 */
const DEFAULT_CACHE_SECONDS = 60;

export function cacheSeconds(): number {
  const raw = Number(process.env.MARKET_DATA_CACHE_SECONDS);
  if (!Number.isFinite(raw) || raw < 5) return DEFAULT_CACHE_SECONDS;
  return Math.min(900, Math.floor(raw));
}
/** Beyond this age a cached snapshot is no longer offered at all. */
const MAX_STALE_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

let cached: { at: number; result: ProviderResult } | null = null;
let inFlight: Promise<ProviderResult | null> | null = null;

/** Resets the module cache. Exposed for tests. */
export function __resetFeedCache() {
  cached = null;
  inFlight = null;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // The framework data cache is shared across server invocations, so on a
    // serverless host every visitor reuses one upstream call. The in-process
    // cache below cannot do that on its own, because each invocation may run
    // on a fresh instance with empty module state.
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      next: { revalidate: cacheSeconds() },
    });
  } finally {
    clearTimeout(timer);
  }
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses a Twelve Data datetime. Forex series are published in UTC but the
 * string carries no zone designator, so one is added before parsing.
 */
export function parseTwelveDataTime(datetime: string): number {
  const trimmed = datetime.trim();
  const normalised = /(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)
    ? trimmed.replace(' ', 'T')
    : `${trimmed.replace(' ', 'T')}Z`;
  return Date.parse(normalised);
}

/** Shapes a raw Twelve Data time series payload into chronological candles. */
export function mapTwelveDataCandles(payload: unknown): Candle[] {
  const values = (payload as { values?: unknown[] })?.values;
  if (!Array.isArray(values)) return [];

  const candles: Candle[] = [];
  for (const raw of values) {
    const row = raw as Record<string, unknown>;
    const time = parseTwelveDataTime(String(row.datetime ?? ''));
    const open = toFiniteNumber(row.open);
    const high = toFiniteNumber(row.high);
    const low = toFiniteNumber(row.low);
    const close = toFiniteNumber(row.close);
    if (!Number.isFinite(time) || open === null || high === null || low === null || close === null) {
      continue;
    }
    candles.push({ time, open, high, low, close, volume: toFiniteNumber(row.volume) ?? 0 });
  }
  // Twelve Data returns newest first.
  return candles.sort((a, b) => a.time - b.time);
}

async function fromTwelveData(): Promise<ProviderResult | null> {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key || key.trim().length === 0) return null;

  // Overridable so a self hosted proxy, or a fixture server in tests, can stand
  // in for the public endpoint.
  const base = (process.env.TWELVE_DATA_BASE_URL || 'https://api.twelvedata.com').replace(/\/$/, '');
  const url =
    `${base}/time_series?symbol=XAU/USD&interval=15min&outputsize=500&format=JSON&apikey=` +
    encodeURIComponent(key.trim());

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);

  const payload = await res.json();
  if (payload?.status === 'error') {
    throw new Error(`Twelve Data: ${payload?.message ?? 'unknown error'}`);
  }

  const candles = mapTwelveDataCandles(payload);
  if (candles.length === 0) throw new Error('Twelve Data returned no candles');

  const last = candles[candles.length - 1];
  const dayCandles = candlesSinceUtcMidnight(candles, last.time);

  return {
    source: 'Twelve Data (XAU/USD spot)',
    price: last.close,
    dayHigh: dayCandles.length ? Math.max(...dayCandles.map((c) => c.high)) : null,
    dayLow: dayCandles.length ? Math.min(...dayCandles.map((c) => c.low)) : null,
    previousClose: previousDayClose(candles, last.time),
    candlesM15: candles,
  };
}

/** Shapes a raw Yahoo chart payload into chronological candles. */
export function mapYahooCandles(payload: unknown): Candle[] {
  const result = (payload as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | {
        timestamp?: number[];
        indicators?: { quote?: Array<Record<string, Array<number | null>>> };
      }
    | undefined;

  const stamps = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  if (!Array.isArray(stamps) || !quote) return [];

  const candles: Candle[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const open = toFiniteNumber(quote.open?.[i]);
    const high = toFiniteNumber(quote.high?.[i]);
    const low = toFiniteNumber(quote.low?.[i]);
    const close = toFiniteNumber(quote.close?.[i]);
    if (open === null || high === null || low === null || close === null) continue;
    candles.push({
      time: stamps[i] * 1000,
      open,
      high,
      low,
      close,
      volume: toFiniteNumber(quote.volume?.[i]) ?? 0,
    });
  }
  return candles.sort((a, b) => a.time - b.time);
}

async function fromYahoo(): Promise<ProviderResult | null> {
  const res = await fetchWithTimeout(
    'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=15m&range=5d',
    { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

  const payload = await res.json();
  const candles = mapYahooCandles(payload);
  if (candles.length === 0) throw new Error('Yahoo returned no candles');

  const meta = (payload as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> } })
    ?.chart?.result?.[0]?.meta;
  const last = candles[candles.length - 1];
  const price = toFiniteNumber(meta?.regularMarketPrice) ?? last.close;
  const dayCandles = candlesSinceUtcMidnight(candles, last.time);

  return {
    // Gold futures track spot closely but are not identical, so the label says so.
    source: 'Yahoo Finance (COMEX GC=F front month)',
    price,
    dayHigh: toFiniteNumber(meta?.regularMarketDayHigh) ??
      (dayCandles.length ? Math.max(...dayCandles.map((c) => c.high)) : null),
    dayLow: toFiniteNumber(meta?.regularMarketDayLow) ??
      (dayCandles.length ? Math.min(...dayCandles.map((c) => c.low)) : null),
    previousClose: toFiniteNumber(meta?.chartPreviousClose) ?? previousDayClose(candles, last.time),
    candlesM15: candles,
  };
}

const DAY_MS = 86_400_000;

/** Candles belonging to the same UTC day as `referenceTime`. */
export function candlesSinceUtcMidnight(candles: Candle[], referenceTime: number): Candle[] {
  const dayStart = Math.floor(referenceTime / DAY_MS) * DAY_MS;
  return candles.filter((c) => c.time >= dayStart);
}

/** Closing price of the last candle of the previous UTC day, when present. */
export function previousDayClose(candles: Candle[], referenceTime: number): number | null {
  const dayStart = Math.floor(referenceTime / DAY_MS) * DAY_MS;
  const before = candles.filter((c) => c.time < dayStart);
  return before.length ? before[before.length - 1].close : null;
}

async function pullFromProviders(): Promise<ProviderResult | null> {
  const attempts: Array<() => Promise<ProviderResult | null>> = [fromTwelveData, fromYahoo];
  const failures: string[] = [];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result && Number.isFinite(result.price) && result.price > 0) return result;
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (failures.length > 0) {
    console.warn('XAUUSD price feed providers failed:', failures.join(' | '));
  }
  return null;
}

/**
 * Returns the freshest snapshot available. Serves a cached snapshot within the
 * TTL, otherwise refetches. Concurrent callers share a single in-flight request.
 */
export async function getMarketSnapshot(): Promise<MarketSnapshot> {
  const now = Date.now();

  if (cached && now - cached.at < cacheSeconds() * 1000) {
    return toSnapshot(cached.result, cached.at, now, 'live');
  }

  if (!inFlight) {
    inFlight = pullFromProviders().finally(() => {
      inFlight = null;
    });
  }
  const fresh = await inFlight;

  if (fresh) {
    cached = { at: Date.now(), result: fresh };
    return toSnapshot(fresh, cached.at, Date.now(), 'live');
  }

  if (cached && now - cached.at <= MAX_STALE_MS) {
    return toSnapshot(cached.result, cached.at, now, 'stale');
  }

  return {
    status: 'unavailable',
    source: null,
    fetchedAt: null,
    ageMs: 0,
    price: null,
    dayHigh: null,
    dayLow: null,
    previousClose: null,
    candlesM15: [],
    message:
      'No market data provider could be reached. Set TWELVE_DATA_API_KEY for a spot XAU/USD feed, or check outbound network access.',
  };
}

function toSnapshot(
  result: ProviderResult,
  fetchedAt: number,
  now: number,
  status: 'live' | 'stale'
): MarketSnapshot {
  const ageMs = Math.max(0, now - fetchedAt);
  return {
    status,
    source: result.source,
    fetchedAt: new Date(fetchedAt).toISOString(),
    ageMs,
    price: round2(result.price),
    dayHigh: result.dayHigh === null ? null : round2(result.dayHigh),
    dayLow: result.dayLow === null ? null : round2(result.dayLow),
    previousClose: result.previousClose === null ? null : round2(result.previousClose),
    candlesM15: result.candlesM15,
    message:
      status === 'live'
        ? `Live data from ${result.source}.`
        : `Provider unreachable. Showing the last known quote from ${result.source}, ${Math.round(
            ageMs / 1000
          )} seconds old. Do not trade on it.`,
  };
}

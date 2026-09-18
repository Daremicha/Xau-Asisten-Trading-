/**
 * Server side XAUUSD price feed.
 *
 * Design rule: this module never invents a price. When every provider fails it
 * reports `unavailable`, or serves the last good snapshot explicitly marked
 * `stale` with its age. Callers are expected to surface that to the user rather
 * than presenting fabricated numbers as a live quote.
 */

import { Candle, round2 } from './candles';
import { budgetState, takeRequest } from './request-budget';

export type FeedStatus = 'live' | 'stale' | 'unavailable';

/**
 * What the quoted price actually is.
 *
 * Spot XAUUSD and COMEX gold futures are different instruments. They move
 * together but they do not trade at the same number: the futures carry the cost
 * of holding metal to delivery, which on a normal day is tens of dollars. Every
 * level this app quotes has to be in the instrument the user trades at their
 * broker, so the snapshot says which one it is carrying.
 */
export type QuotedInstrument = 'spot' | 'futures';

export interface MarketSnapshot {
  status: FeedStatus;
  /** Spot, or a futures contract that trades at a basis away from it. */
  instrument: QuotedInstrument;
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
  /**
   * Real daily candles, oldest first, empty when none could be fetched.
   *
   * The daily trend is the heaviest single input the engine has, and it cannot
   * be built by resampling the execution feed: ten days of M15 candles make
   * ten daily bars, which is not a daily picture. This is its own request, on
   * its own slow clock, because a daily candle changes once a day.
   */
  candlesD1: Candle[];
  /** Explains the status, especially when data is stale or missing. */
  message: string;
}

export interface ProviderResult {
  source: string;
  instrument: QuotedInstrument;
  price: number;
  /**
   * When the price itself was taken. A live tick is now; a candle close is as
   * old as that candle, which is what the screen has to be told.
   */
  priceTakenAt: number;
  dayHigh: number | null;
  dayLow: number | null;
  previousClose: number | null;
  candlesM15: Candle[];
  candlesD1: Candle[];
}

/**
 * How long a snapshot stays fresh before we refetch.
 *
 * This is a quota decision, not a performance one. The Twelve Data free tier
 * allows 800 requests a day, and a refresh only happens when someone actually
 * asks for data.
 *
 * Fifteen seconds is short enough that the quote on screen tracks the chart
 * rather than trailing it by a minute and a half, which is what a sixty second
 * cache behind a thirty second poll produced. The client, not this number,
 * decides how often to ask: it polls slowly when nothing is open, quickly while
 * an order is live, and not at all while the tab is in the background. Raise it
 * with MARKET_DATA_CACHE_SECONDS if the daily quota is tight.
 */
const DEFAULT_CACHE_SECONDS = 20;

/**
 * How often the browser asks for a new quote.
 *
 * Kept beside the cache window because the two together decide the daily bill:
 * the cache stops several tabs multiplying it, and these decide how often one
 * tab asks at all. A working order is read continuously by the status panel and
 * the automatic close, so it earns the fast rate. Nothing open only needs to
 * look current. A background tab spends nothing.
 */
export const QUOTE_POLL_MS = {
  /**
   * An order is working, so the status panel is being watched. The browser
   * asks this often; whether the server goes to the provider is a separate
   * question, decided by the request budget.
   */
  withOpenOrder: 10_000,
  /** Nothing open: the quote only has to look current. */
  idle: 45_000,
} as const;

/**
 * How current a tick is kept while an order is live.
 *
 * This is what the entry status panel reads, so it is the number that decides
 * whether the panel agrees with the chart beside it. Spending on it is the
 * whole point of the reserve in the request budget.
 */
const LIVE_TICK_MS = 10_000;

export function cacheSeconds(): number {
  const raw = Number(process.env.MARKET_DATA_CACHE_SECONDS);
  if (!Number.isFinite(raw) || raw < 5) return DEFAULT_CACHE_SECONDS;
  return Math.min(900, Math.floor(raw));
}
/** Beyond this age a cached snapshot is no longer offered at all. */
const MAX_STALE_MS = 30 * 60_000;

/**
 * Beyond this, a price is not current enough to place a market order against.
 *
 * Reached when the tick endpoint fails and the snapshot falls back to the close
 * of the last finished candle. The feed still works, but quoting an instant
 * order at that price is how one came to be six dollars away from the market,
 * so the snapshot is marked stale and the engine sizes down accordingly.
 */
const PRICE_TOO_OLD_MS = 120_000;
const REQUEST_TIMEOUT_MS = 8_000;

/** Fifteen minute candles requested per refresh: about ten days of market. */
const EXECUTION_CANDLES = 1000;
/**
 * Shortest gap between candle downloads.
 *
 * Structure only changes when a candle closes, so refetching a thousand
 * candles beside every tick bought nothing and cost half the daily budget.
 * Ninety seconds is a floor; the real trigger is a fifteen minute candle
 * having closed since the last download, which is at most ninety six
 * downloads a day.
 */
const CANDLE_MIN_GAP_MS = 90_000;
const M15_MS = 15 * 60_000;
/** Daily candles requested, which is most of a trading year. */
const DAILY_CANDLES = 250;
/**
 * How long a daily series is reused.
 *
 * A daily candle changes once a day. Refetching it beside every quote would
 * spend the provider quota on a number that cannot have moved.
 */
const DAILY_CACHE_MS = 60 * 60_000;

let cached: { at: number; result: ProviderResult } | null = null;
let inFlight: Promise<ProviderResult | null> | null = null;
let cachedDaily: { at: number; candles: Candle[] } | null = null;
/** The expensive half: a thousand candles, only worth refetching on a close. */
let cachedCandles: { at: number; newest: number; candles: Candle[] } | null = null;
/** The cheap half: one number, which is the one the panel is watching. */
let cachedTick: { at: number; price: number } | null = null;

/** Resets the module cache. Exposed for tests. */
export function __resetFeedCache() {
  cached = null;
  inFlight = null;
  cachedDaily = null;
  cachedCandles = null;
  cachedTick = null;
}

/**
 * Whether the candle series is worth downloading again.
 *
 * Only once a fifteen minute candle has closed since the last download, and
 * never more often than the floor above. Everything the candles feed —
 * structure, indicators, the daily read — is computed from closed candles, so
 * between closes a refetch returns the same analysis at full price.
 */
function candlesAreStale(now: number): boolean {
  if (!cachedCandles) return true;
  if (now - cachedCandles.at < CANDLE_MIN_GAP_MS) return false;
  const closedSince = Math.floor(now / M15_MS) * M15_MS;
  return cachedCandles.newest < closedSince;
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

/**
 * The current price, rather than the close of the last finished candle.
 *
 * This is the bug that made a market order unfillable. The snapshot's price was
 * taken from the newest fifteen minute candle, so between bars it was whatever
 * gold last traded at when that bar closed: on a fast move, minutes and several
 * dollars behind the market. The engine then quoted BUY INSTANT at a price that
 * no longer existed.
 *
 * One extra call per refresh, and the cheapest one the provider sells.
 */
async function twelveDataPrice(
  base: string,
  key: string,
  live: boolean,
  now: number
): Promise<number | null> {
  // How old the cached tick may be before it is worth another request. While an
  // order is live that is eight seconds, because the status panel is being
  // watched against the chart. Otherwise it is the plan's sustained rate, which
  // costs almost nothing over a day.
  const maxAge = live ? LIVE_TICK_MS : budgetState(now).sustainedIntervalSeconds * 1000;
  if (cachedTick && now - cachedTick.at < maxAge) return cachedTick.price;
  // A tick is worth having and never worth breaking the budget for: an older
  // price is still a real price, and the snapshot says how old it is.
  if (!takeRequest(false, now)) return cachedTick?.price ?? null;

  try {
    const res = await fetchWithTimeout(
      `${base}/price?symbol=XAU/USD&format=JSON&apikey=${encodeURIComponent(key)}`
    );
    if (!res.ok) return null;
    const payload = await res.json();
    const price = toFiniteNumber((payload as { price?: unknown })?.price);
    if (price === null || price <= 0) return cachedTick?.price ?? null;
    cachedTick = { at: Date.now(), price };
    return price;
  } catch {
    // The candles still carry a usable, if older, price. The snapshot reports
    // how old it is either way.
    return cachedTick?.price ?? null;
  }
}

/**
 * The daily series, cached for an hour and never allowed to fail a refresh.
 *
 * When it cannot be fetched the analysis falls back to what it did before:
 * resampling the execution feed and saying so. A missing daily read is a
 * weaker analysis, not a broken one.
 */
async function twelveDataDaily(base: string, key: string): Promise<Candle[]> {
  const now = Date.now();
  if (cachedDaily && now - cachedDaily.at < DAILY_CACHE_MS) return cachedDaily.candles;
  // Twenty four of these a day, and the daily trend is the heaviest input the
  // engine has, so it is counted and it comes before a fresher tick.
  if (!takeRequest(true, now)) return cachedDaily?.candles ?? [];

  try {
    const res = await fetchWithTimeout(
      `${base}/time_series?symbol=XAU/USD&interval=1day&outputsize=${DAILY_CANDLES}&format=JSON&apikey=` +
        encodeURIComponent(key)
    );
    if (!res.ok) return cachedDaily?.candles ?? [];
    const payload = await res.json();
    if ((payload as { status?: string })?.status === 'error') return cachedDaily?.candles ?? [];
    const candles = mapTwelveDataCandles(payload);
    if (candles.length === 0) return cachedDaily?.candles ?? [];
    cachedDaily = { at: now, candles };
    return candles;
  } catch {
    // Keep whatever was last known rather than dropping the daily read on one
    // failed request.
    return cachedDaily?.candles ?? [];
  }
}

async function fromTwelveData(live: boolean): Promise<ProviderResult | null> {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key || key.trim().length === 0) return null;

  // Overridable so a self hosted proxy, or a fixture server in tests, can stand
  // in for the public endpoint.
  const base = (process.env.TWELVE_DATA_BASE_URL || 'https://api.twelvedata.com').replace(/\/$/, '');
  // A thousand fifteen minute candles is about ten days: two hundred and fifty
  // hourly bars, which is the first length at which the hourly EMA 200 is an
  // EMA 200 rather than the longest average the feed happened to support.
  const now = Date.now();
  let candles = cachedCandles?.candles ?? [];

  // The budget may refuse even this, once a day's allowance is genuinely gone.
  // Then the analysis runs on the candles already held, which are at most a few
  // minutes old, rather than on nothing.
  if (candlesAreStale(now) && takeRequest(true, now)) {
    const url =
      `${base}/time_series?symbol=XAU/USD&interval=15min&outputsize=${EXECUTION_CANDLES}&format=JSON&apikey=` +
      encodeURIComponent(key.trim());

    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      if (candles.length === 0) throw new Error(`Twelve Data HTTP ${res.status}`);
    } else {
      const payload = await res.json();
      if (payload?.status === 'error') {
        if (candles.length === 0) {
          throw new Error(`Twelve Data: ${payload?.message ?? 'unknown error'}`);
        }
      } else {
        const fresh = mapTwelveDataCandles(payload);
        if (fresh.length > 0) {
          candles = fresh;
          cachedCandles = { at: Date.now(), newest: fresh[fresh.length - 1].time, candles: fresh };
        }
      }
    }
  }

  if (candles.length === 0) throw new Error('Twelve Data returned no candles');

  const last = candles[candles.length - 1];
  const dayCandles = candlesSinceUtcMidnight(candles, last.time);

  // Ask for the tick as well. Falling back to the candle close is correct but
  // openly older, and the snapshot says by how much. The daily series is
  // fetched alongside it and is usually served from its own hourly cache.
  const [livePrice, daily] = await Promise.all([
    twelveDataPrice(base, key.trim(), live, now),
    twelveDataDaily(base, key.trim()),
  ]);

  return {
    source: 'Twelve Data (XAU/USD spot)',
    instrument: 'spot',
    price: livePrice ?? last.close,
    // Measured from when the tick was taken, not from when it was served out of
    // the cache: a price held for the budget's sake is older, and saying so is
    // the difference between a quiet delay and a lie.
    priceTakenAt: livePrice === null ? last.time : cachedTick?.at ?? Date.now(),
    dayHigh: dayCandles.length ? Math.max(...dayCandles.map((c) => c.high)) : null,
    dayLow: dayCandles.length ? Math.min(...dayCandles.map((c) => c.low)) : null,
    previousClose: previousDayClose(candles, last.time),
    candlesM15: candles,
    candlesD1: daily,
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

/**
 * Yahoo's symbols, most faithful first.
 *
 * `XAUUSD=X` is spot gold, the same instrument a retail broker quotes.
 * `GC=F` is the front month COMEX future, which is a different contract
 * trading at the cost of carry away from spot — tens of dollars on an ordinary
 * day. It is kept as a last resort because a chart that is forty dollars off
 * is still better than no chart, but nothing may quote an order from it.
 */
export const YAHOO_SYMBOLS: Array<{ symbol: string; instrument: QuotedInstrument; source: string }> = [
  { symbol: 'XAUUSD=X', instrument: 'spot', source: 'Yahoo Finance (XAUUSD spot)' },
  {
    symbol: 'GC=F',
    instrument: 'futures',
    source: 'Yahoo Finance (COMEX GC=F front month futures, not spot)',
  },
];

async function fromYahooSymbol(
  entry: (typeof YAHOO_SYMBOLS)[number]
): Promise<ProviderResult | null> {
  const res = await fetchWithTimeout(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      entry.symbol
    )}?interval=15m&range=5d`,
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
    source: entry.source,
    instrument: entry.instrument,
    price,
    // Yahoo's meta carries the live quote; only the fallback is candle-aged.
    priceTakenAt: toFiniteNumber(meta?.regularMarketPrice) === null ? last.time : Date.now(),
    dayHigh: toFiniteNumber(meta?.regularMarketDayHigh) ??
      (dayCandles.length ? Math.max(...dayCandles.map((c) => c.high)) : null),
    dayLow: toFiniteNumber(meta?.regularMarketDayLow) ??
      (dayCandles.length ? Math.min(...dayCandles.map((c) => c.low)) : null),
    previousClose: toFiniteNumber(meta?.chartPreviousClose) ?? previousDayClose(candles, last.time),
    candlesM15: candles,
    // The fallback provider serves no separate daily series, so the analysis
    // resamples as it always did and says which candles it used.
    candlesD1: [],
  };
}

/** Spot first, the futures contract only when spot cannot be had at all. */
async function fromYahoo(): Promise<ProviderResult | null> {
  let lastError: unknown = null;
  for (const entry of YAHOO_SYMBOLS) {
    try {
      const result = await fromYahooSymbol(entry);
      if (result && Number.isFinite(result.price) && result.price > 0) return result;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return null;
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

async function pullFromProviders(live: boolean): Promise<ProviderResult | null> {
  const attempts: Array<() => Promise<ProviderResult | null>> = [() => fromTwelveData(live), fromYahoo];
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
export async function getMarketSnapshot(live = false): Promise<MarketSnapshot> {
  const now = Date.now();

  // The outer cache only absorbs bursts now. What actually reaches the provider
  // is decided inside: candles on a candle close, the tick on the budget's
  // clock, the daily series once an hour. So this can be short without costing
  // anything, which is what lets the status panel keep up.
  const burstMs = live ? Math.min(5_000, cacheSeconds() * 1000) : cacheSeconds() * 1000;
  if (cached && now - cached.at < burstMs) {
    return toSnapshot(cached.result, now, 'live');
  }

  if (!inFlight) {
    inFlight = pullFromProviders(live).finally(() => {
      inFlight = null;
    });
  }
  const fresh = await inFlight;

  if (fresh) {
    cached = { at: Date.now(), result: fresh };
    return toSnapshot(fresh, Date.now(), 'live');
  }

  if (cached && now - cached.at <= MAX_STALE_MS) {
    return toSnapshot(cached.result, now, 'stale');
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
    candlesD1: [],
    instrument: 'spot',
    message:
      'No market data provider could be reached. Set TWELVE_DATA_API_KEY for a spot XAU/USD feed, or check outbound network access.',
  };
}

/** Exposed for tests: the mapping that decides what age and status are reported. */
export function __toSnapshotForTest(
  result: ProviderResult,
  now: number,
  status: 'live' | 'stale'
): MarketSnapshot {
  return toSnapshot(result, now, status);
}

function toSnapshot(result: ProviderResult, now: number, status: 'live' | 'stale'): MarketSnapshot {
  // Measured from the moment the price was taken, not from the moment we asked
  // for it. A candle close fetched a second ago can still be minutes old, and
  // reporting that as "0s old" is how a market order came to be quoted six
  // dollars away from the market.
  const ageMs = Math.max(0, now - Math.min(result.priceTakenAt, now));
  // A live provider serving a price too old to trade on is still stale.
  const effective: 'live' | 'stale' = status === 'live' && ageMs > PRICE_TOO_OLD_MS ? 'stale' : status;

  // A futures feed is never presented as though it were the instrument the
  // user trades. It is worth showing, and worth refusing to quote orders from.
  const instrumentNote =
    result.instrument === 'futures'
      ? ` This is the COMEX futures contract, not spot XAUUSD: it trades at the cost of carry away from the price your broker quotes, so no order levels are produced from it.`
      : '';

  return {
    status: effective,
    instrument: result.instrument,
    source: result.source,
    fetchedAt: new Date(result.priceTakenAt).toISOString(),
    ageMs,
    price: round2(result.price),
    dayHigh: result.dayHigh === null ? null : round2(result.dayHigh),
    dayLow: result.dayLow === null ? null : round2(result.dayLow),
    previousClose: result.previousClose === null ? null : round2(result.previousClose),
    candlesM15: result.candlesM15,
    candlesD1: result.candlesD1,
    message:
      (effective === 'live'
        ? `Live data from ${result.source}.`
        : status === 'live'
        ? `${result.source} is answering, but the freshest price it gave is ${Math.round(
            ageMs / 1000
          )} seconds old, which is not current enough for a market order.`
        : `Provider unreachable. Showing the last known quote from ${result.source}, ${Math.round(
            ageMs / 1000
          )} seconds old. Do not trade on it.`) + instrumentNote,
  };
}

/**
 * Fifteen minute candles for a past window, for re-examining closed records.
 *
 * Separate from the live feed on purpose. The live path keeps one rolling
 * window in module state and refuses a refetch while it is fresh, which is
 * exactly wrong for a question about last Tuesday. This asks for a named range
 * and caches nothing: an audit is rare, and a stale answer to it would be worse
 * than a slow one.
 *
 * Bounded at five thousand candles, which is Twelve Data's own ceiling for one
 * request and about seven weeks of trading. One call covers every record a
 * ledger of this size holds, so the audit costs one request rather than one per
 * row.
 *
 * Returns an empty array when no key is set or the provider refuses. The caller
 * reports that as an audit it could not perform, never as a verdict.
 */
export async function fetchHistoricalCandles(
  startMs: number,
  endMs: number
): Promise<{ candles: Candle[]; message: string }> {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key || key.trim().length === 0) {
    return {
      candles: [],
      message: 'No market data key is configured, so past prices cannot be fetched.',
    };
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { candles: [], message: 'The period to examine is not a valid range.' };
  }

  // An audit is a deliberate act by the user, so it spends from the essential
  // reserve rather than being refused when the tick budget is thin.
  if (!takeRequest(true)) {
    return {
      candles: [],
      message: 'The daily market data allowance is spent. The audit can run again tomorrow.',
    };
  }

  const base = (process.env.TWELVE_DATA_BASE_URL || 'https://api.twelvedata.com').replace(/\/$/, '');
  // Twelve Data takes these as UTC 'YYYY-MM-DD HH:MM:SS'.
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

  const url =
    `${base}/time_series?symbol=XAU/USD&interval=15min` +
    `&start_date=${encodeURIComponent(stamp(startMs))}` +
    `&end_date=${encodeURIComponent(stamp(endMs))}` +
    `&outputsize=5000&format=JSON&apikey=${encodeURIComponent(key.trim())}`;

  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      return { candles: [], message: `The market data provider returned HTTP ${res.status}.` };
    }
    const payload = await res.json();
    if ((payload as { status?: string })?.status === 'error') {
      return { candles: [], message: 'The market data provider declined the request for this period.' };
    }
    const candles = mapTwelveDataCandles(payload);
    return candles.length === 0
      ? { candles: [], message: 'The provider returned no candles for this period.' }
      : { candles, message: '' };
  } catch {
    return { candles: [], message: 'The market data provider could not be reached.' };
  }
}

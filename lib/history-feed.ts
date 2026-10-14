/**
 * Historical XAUUSD candles for the backtest.
 *
 * The live feed only ever needs the last few hundred candles. A backtest over
 * two years needs tens of thousands, which no provider returns in one call, so
 * this walks backwards through the history a page at a time and hands each page
 * to the caller.
 *
 * The same rule as the live feed applies: nothing here invents a candle. When a
 * provider stops supplying history, the caller is told exactly how far the data
 * actually reached and the backtest is run over that, honestly labelled, rather
 * than over a padded series.
 */

import { Candle } from './candles';
import { tradingCandles } from './market-hours';
import { mapTwelveDataCandles, mapYahooCandles } from './price-feed';
import { requestTwelveData, twelveDataBase, twelveDataConfigured } from './twelve-data-keys';

/** Largest page Twelve Data returns in a single request. */
const TWELVE_DATA_PAGE = 5000;
const REQUEST_TIMEOUT_MS = 20_000;

export type HistoryInterval = '5min' | '15min' | '1h';

/**
 * Instruments the history can be downloaded for. Gold is what the app trades;
 * Bitcoin is here so a weekend strategy can be tested on real history before
 * anything is built on it. It trades around the clock, so its weekends are kept.
 */
export type HistorySymbol = 'XAU/USD' | 'BTC/USD';
export const HISTORY_SYMBOLS: HistorySymbol[] = ['XAU/USD', 'BTC/USD'];

export const INTERVAL_MS: Record<HistoryInterval, number> = {
  '5min': 5 * 60_000,
  '15min': 15 * 60_000,
  '1h': 60 * 60_000,
};

export interface HistoryPage {
  /** Chronological candles, oldest first. Empty when the provider had none. */
  candles: Candle[];
  provider: string | null;
  interval: HistoryInterval;
  /** Oldest candle in this page, the cursor for the next call. */
  oldestMs: number | null;
  newestMs: number | null;
  /** True when the provider has no more history before the cursor. */
  exhausted: boolean;
  /** Set when the provider asked us to slow down, in milliseconds. */
  retryAfterMs: number | null;
  message: string;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/** Twelve Data expects `YYYY-MM-DD HH:MM:SS`, in the timezone we ask for. */
export function toTwelveDataStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Rate limit notice from Twelve Data.
 *
 * The free plan allows eight requests a minute, and a backtest needs roughly a
 * dozen. Rather than failing the run, the caller is told how long to wait.
 */
function rateLimited(payload: unknown, status: number): boolean {
  if (status === 429) return true;
  const code = (payload as { code?: number })?.code;
  const message = String((payload as { message?: string })?.message ?? '');
  return code === 429 || /api credits|rate limit|too many requests/i.test(message);
}

async function twelveDataPage(
  interval: HistoryInterval,
  beforeMs: number | null,
  symbol: HistorySymbol = 'XAU/USD'
): Promise<HistoryPage | null> {
  if (!twelveDataConfigured()) return null;

  const base = twelveDataBase();
  const params = new URLSearchParams({
    symbol,
    interval,
    outputsize: String(TWELVE_DATA_PAGE),
    format: 'JSON',
    timezone: 'UTC',
  });
  // Walk backwards: each page ends one candle before the previous page started.
  if (beforeMs !== null) params.set('end_date', toTwelveDataStamp(beforeMs - 1));

  // Each configured key is tried in turn; only when all are out of credits is
  // the caller told to wait.
  const reply = (await requestTwelveData(
    (key) => `${base}/time_series?${params.toString()}&apikey=${encodeURIComponent(key)}`,
    fetchWithTimeout
  ))!;
  const payload = reply.payload;
  const res = { ok: reply.ok, status: reply.status };

  if (reply.allKeysSpent || rateLimited(payload, res.status)) {
    return {
      candles: [],
      provider: 'Twelve Data',
      interval,
      oldestMs: null,
      newestMs: null,
      exhausted: false,
      retryAfterMs: 60_000,
      message:
        'Twelve Data sedang membatasi unduhan. Paket gratis hanya delapan permintaan per menit, jadi halaman berikutnya dicoba lagi sebentar lagi.',
    };
  }

  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);
  if ((payload as { status?: string })?.status === 'error') {
    throw new Error(`Twelve Data: ${(payload as { message?: string })?.message ?? 'unknown error'}`);
  }

  const candles = mapTwelveDataCandles(payload);
  return {
    // Paging reads the raw page below; only what is handed on is filtered, so
    // a page thinned by a weekend is not mistaken for the end of the history.
    candles: symbol === 'XAU/USD' ? tradingCandles(candles) : candles,
    provider: `Twelve Data (${symbol} spot)`,
    interval,
    oldestMs: candles.length ? candles[0].time : null,
    newestMs: candles.length ? candles[candles.length - 1].time : null,
    // A short page means the provider has nothing older to give.
    exhausted: candles.length < TWELVE_DATA_PAGE,
    retryAfterMs: null,
    message: candles.length
      ? `Twelve Data returned ${candles.length} ${interval} candles.`
      : 'Twelve Data tidak punya riwayat lebih lama dari titik ini.',
  };
}

/**
 * Yahoo's fallback range.
 *
 * Yahoo serves intraday gold futures rather than spot, and only goes back sixty
 * days at fifteen minutes or two years at one hour. It is a fallback, not an
 * equal: the caller is told which provider actually supplied the series.
 */
async function yahooRange(interval: HistoryInterval, beforeMs: number | null): Promise<HistoryPage> {
  const end = beforeMs !== null ? Math.floor((beforeMs - 1) / 1000) : Math.floor(Date.now() / 1000);
  const spanSeconds = interval === '1h' ? 729 * 86_400 : 59 * 86_400;
  const start = end - spanSeconds;

  const res = await fetchWithTimeout(
    `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${
      interval === '1h' ? '1h' : interval === '5min' ? '5m' : '15m'
    }&period1=${start}&period2=${end}`,
    { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

  const candles = mapYahooCandles(await res.json());
  return {
    candles: tradingCandles(candles),
    provider: 'Yahoo Finance (GC=F gold futures)',
    interval,
    oldestMs: candles.length ? candles[0].time : null,
    newestMs: candles.length ? candles[candles.length - 1].time : null,
    // Yahoo serves the whole window it allows in one response, so one page is all there is.
    exhausted: true,
    retryAfterMs: null,
    message: candles.length
      ? `Yahoo returned ${candles.length} ${interval} candle data futures GC=F.`
      : 'Yahoo tidak mengirim candle untuk rentang ini.',
  };
}

/**
 * One page of history ending just before `beforeMs`, or the most recent page
 * when that is null. Twelve Data is preferred because it quotes spot; Yahoo
 * stands in when no key is configured or the request fails.
 */
export async function fetchHistoryPage(
  interval: HistoryInterval,
  beforeMs: number | null,
  symbol: HistorySymbol = 'XAU/USD'
): Promise<HistoryPage> {
  // The Yahoo fallback serves gold futures, which says nothing about Bitcoin.
  if (symbol !== 'XAU/USD') {
    const page = await twelveDataPage(interval, beforeMs, symbol);
    if (page) return page;
    return {
      candles: [],
      provider: null,
      interval,
      oldestMs: null,
      newestMs: null,
      exhausted: true,
      retryAfterMs: null,
      message: `Key data pasar belum dipasang, jadi riwayat ${symbol} tidak bisa diambil.`,
    };
  }
  try {
    const page = await twelveDataPage(interval, beforeMs);
    if (page) return page;
  } catch (err) {
    // Fall through to Yahoo, but say why the preferred provider was not used.
    const reason = err instanceof Error ? err.message : 'unknown error';
    try {
      const fallback = await yahooRange(interval, beforeMs);
      return { ...fallback, message: `${reason}. Beralih ke ${fallback.provider}.` };
    } catch {
      return {
        candles: [],
        provider: null,
        interval,
        oldestMs: null,
        newestMs: null,
        exhausted: true,
        retryAfterMs: null,
        message: `Tidak ada provider yang bisa memberi riwayat: ${reason}.`,
      };
    }
  }

  try {
    return await yahooRange(interval, beforeMs);
  } catch (err) {
    return {
      candles: [],
      provider: null,
      interval,
      oldestMs: null,
      newestMs: null,
      exhausted: true,
      retryAfterMs: null,
      message: `Tidak ada provider yang bisa memberi riwayat: ${
        err instanceof Error ? err.message : 'unknown error'
      }.`,
    };
  }
}

/** Merges pages into one ascending series with no duplicate timestamps. */
export function mergeCandles(existing: Candle[], incoming: Candle[]): Candle[] {
  if (incoming.length === 0) return existing;
  const byTime = new Map<number, Candle>();
  for (const candle of existing) byTime.set(candle.time, candle);
  for (const candle of incoming) byTime.set(candle.time, candle);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/** Compact wire form, so a two year download is numbers rather than JSON keys. */
export type WireCandle = [number, number, number, number, number, number];

export function toWire(candles: Candle[]): WireCandle[] {
  return candles.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume ?? 0]);
}

export function fromWire(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) return [];
  const candles: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, open, high, low, close, volume] = row as number[];
    if (![time, open, high, low, close].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      continue;
    }
    candles.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return candles.sort((a, b) => a.time - b.time);
}

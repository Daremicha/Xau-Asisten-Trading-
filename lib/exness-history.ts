import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resample, type Candle } from './candles';
import type { HistoryInterval, HistoryPage } from './history-feed';

const DATA_PATH = `${process.cwd()}/public/data/exness-xauusdc-15m.json.gz`;
const PAGE_SIZE = 5_000;
const H1_MS = 60 * 60_000;

type ExnessRow = [number, number, number, number, number, number, number?, number?, number?];
let cached: Candle[] | null = null;

function loadCandles(): Candle[] {
  if (cached) return cached;
  if (!existsSync(DATA_PATH)) return [];
  const rows = JSON.parse(gunzipSync(readFileSync(DATA_PATH)).toString('utf8')) as unknown;
  if (!Array.isArray(rows)) return [];
  cached = rows
    .filter((row): row is ExnessRow => Array.isArray(row) && row.length >= 6)
    .map(([time, open, high, low, close, ticks, spread]) => ({
      time, open, high, low, close, volume: ticks,
      ...(typeof spread === 'number' && Number.isFinite(spread) && spread >= 0 ? { spread } : {}),
    }))
    .filter((c) => [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
  return cached;
}

/**
 * Reads the preprocessed Exness XAUUSDc spot archive. It is intentionally a
 * server-side source: the raw tick archives are never shipped to the browser.
 * Missing buckets remain missing; no prices are forward-filled.
 */
export function exnessHistoryPage(interval: HistoryInterval, beforeMs: number | null): HistoryPage | null {
  if (interval !== '15min' && interval !== '1h') return null;
  const base = loadCandles();
  if (base.length === 0) return null;
  const candles = interval === '1h' ? resample(base, H1_MS) : base;
  const firstAtOrAfter = beforeMs === null ? -1 : candles.findIndex((c) => c.time >= beforeMs);
  const endIndex =
    beforeMs === null
      ? candles.length
      : firstAtOrAfter >= 0
      ? firstAtOrAfter
      : beforeMs > candles[candles.length - 1].time
      ? candles.length
      : 0;
  const start = Math.max(0, endIndex - PAGE_SIZE);
  const page = candles.slice(start, endIndex);
  const oldest = page[0]?.time ?? null;
  const newest = page[page.length - 1]?.time ?? null;
  return {
    candles: page,
    provider: 'Exness XAUUSDc spot (historical Bid/Ask midpoint)',
    interval,
    oldestMs: oldest,
    newestMs: newest,
    exhausted: start === 0,
    retryAfterMs: null,
    message: page.length
      ? `Exness XAUUSDc menyediakan ${page.length} candle ${interval}; gap pasar/sumber dipertahankan tanpa forward-fill.`
      : 'Exness tidak memiliki candle sebelum titik waktu ini.',
  };
}

export function __resetExnessHistoryCache() {
  cached = null;
}

import { describe, expect, test } from 'bun:test';
import { buildInstitutionalRead } from '../lib/analysis-pipeline';
import type { Candle } from '../lib/candles';
import type { MarketSnapshot } from '../lib/price-feed';

const M15 = 15 * 60_000;
const DAY = 24 * 60 * 60_000;
const START = Date.UTC(2026, 8, 1);

/** A gentle zigzag, so structure and swings have something real to read. */
function series(count: number, stepMs: number, base = 4300, drift = 0): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const mid = base + Math.sin(i / 5) * 12 + i * drift;
    return {
      time: START + i * stepMs,
      open: mid,
      high: mid + 4,
      low: mid - 4,
      close: mid + 1,
      volume: 800 + (i % 7) * 30,
    };
  });
}

function snapshot(candlesM15: Candle[], candlesD1: Candle[] = []): MarketSnapshot {
  const last = candlesM15[candlesM15.length - 1];
  return {
    status: 'live',
    source: 'test',
    fetchedAt: new Date(last.time).toISOString(),
    ageMs: 0,
    price: last.close,
    dayHigh: null,
    dayLow: null,
    previousClose: null,
    candlesM15,
    candlesD1,
    message: '',
  };
}

describe('where the daily read comes from', () => {
  // A thousand fifteen minute candles is about ten days, which resamples to
  // roughly ten daily bars: enough to pass a length check and nowhere near
  // enough to describe a daily trend.
  const execution = series(1000, M15);

  test('real daily candles are used when the feed supplies them', () => {
    const read = buildInstitutionalRead(snapshot(execution, series(250, DAY, 4100, 1.5)));
    expect(read).not.toBeNull();
    // Nothing was borrowed, so nothing is flagged.
    expect(read!.multiTimeframe.d1.derivedFrom).toBeUndefined();
  });

  test('without them the read says which candles it actually used', () => {
    // Two days of execution candles cannot make ten daily bars, so the daily
    // slot falls back and has to admit it.
    const read = buildInstitutionalRead(snapshot(series(192, M15)));
    expect(read).not.toBeNull();
    expect(read!.multiTimeframe.d1.derivedFrom).toBeDefined();
    expect(['H4', 'H1', 'D1']).toContain(read!.multiTimeframe.d1.derivedFrom!);
  });

  test('a daily series too short to mean anything is not used', () => {
    const read = buildInstitutionalRead(snapshot(execution, series(4, DAY)));
    expect(read).not.toBeNull();
    // Four daily candles is not a daily picture, so the fallback runs and says so.
    expect(read!.multiTimeframe.d1.derivedFrom).toBeDefined();
  });

  test('the daily read is a different read from the four hour one', () => {
    // A rising daily series against a flat execution feed: if the daily slot
    // were still resampling the execution candles, both would agree by
    // construction and the heaviest factor in the score would be one opinion
    // counted twice.
    const read = buildInstitutionalRead(snapshot(execution, series(250, DAY, 3000, 8)));
    expect(read).not.toBeNull();
    expect(read!.multiTimeframe.d1.trend).toBe('Bullish');
    expect(read!.multiTimeframe.d1.orderBlock.low).not.toBe(read!.multiTimeframe.h4.orderBlock.low);
  });
});

describe('the averages report the period they were computed over', () => {
  test('a long execution feed produces a genuine two hundred period average', () => {
    const read = buildInstitutionalRead(snapshot(series(1000, M15)));
    expect(read).not.toBeNull();
    // A thousand M15 candles is 250 hourly bars, which is enough.
    expect(read!.indicators.emaSlowPeriod).toBe(200);
    expect(read!.indicators.emaFastPeriod).toBe(50);
  });

  test('a short feed shortens the average and says so rather than lying', () => {
    const read = buildInstitutionalRead(snapshot(series(200, M15)));
    expect(read).not.toBeNull();
    expect(read!.indicators.emaSlowPeriod).toBeLessThan(200);
    expect(read!.indicators.emaSlowPeriod).toBeGreaterThan(0);
  });
});

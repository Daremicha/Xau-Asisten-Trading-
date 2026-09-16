import { describe, expect, test } from 'bun:test';
import { fromWire, mergeCandles, toTwelveDataStamp, toWire } from '../lib/history-feed';
import type { Candle } from '../lib/candles';

function candle(time: number, close = 2000): Candle {
  return { time, open: close - 1, high: close + 2, low: close - 2, close, volume: 100 };
}

describe('page assembly', () => {
  test('pages merge into one ascending series', () => {
    const older = [candle(3000), candle(1000), candle(2000)];
    const newer = [candle(5000), candle(4000)];
    const merged = mergeCandles(older, newer);
    expect(merged.map((c) => c.time)).toEqual([1000, 2000, 3000, 4000, 5000]);
  });

  test('an overlapping page does not duplicate a candle', () => {
    const merged = mergeCandles([candle(1000), candle(2000)], [candle(2000, 2100), candle(3000)]);
    expect(merged).toHaveLength(3);
    // The newer page wins, because it is the fresher read of the same bar.
    expect(merged[1].close).toBe(2100);
  });

  test('merging nothing changes nothing', () => {
    const existing = [candle(1000)];
    expect(mergeCandles(existing, [])).toBe(existing);
  });
});

describe('wire format', () => {
  test('a candle survives the round trip', () => {
    const candles = [candle(1000, 1999.5), candle(2000, 2001.25)];
    const restored = fromWire(toWire(candles));
    expect(restored).toEqual(candles);
  });

  test('malformed rows are dropped rather than becoming NaN candles', () => {
    const restored = fromWire([
      [1000, 1, 2, 0.5, 1.5, 10],
      [2000, 1, 2, 0.5],
      ['x', 1, 2, 0.5, 1.5, 10],
      null,
      [3000, 1, 2, 0.5, Number.NaN, 10],
    ]);
    expect(restored).toHaveLength(1);
    expect(restored[0].time).toBe(1000);
  });

  test('a missing volume reads as zero instead of undefined', () => {
    const restored = fromWire([[1000, 1, 2, 0.5, 1.5]]);
    expect(restored[0].volume).toBe(0);
  });

  test('anything that is not a list of rows yields nothing', () => {
    expect(fromWire(null)).toEqual([]);
    expect(fromWire({ values: [] })).toEqual([]);
  });
});

describe('provider query', () => {
  test('the cursor is formatted the way Twelve Data expects', () => {
    expect(toTwelveDataStamp(Date.UTC(2024, 4, 17, 9, 30, 0))).toBe('2024-05-17 09:30:00');
  });
});

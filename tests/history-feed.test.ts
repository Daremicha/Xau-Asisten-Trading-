import { afterEach, describe, expect, test } from 'bun:test';
import { fetchHistoryPage, fromWire, mergeCandles, toTwelveDataStamp, toWire } from '../lib/history-feed';
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

describe('weekend bars in a downloaded page', () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.TWELVE_DATA_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = realKey;
  });

  test('are dropped, and a page thinned by them is not taken for the end of history', async () => {
    process.env.TWELVE_DATA_API_KEY = 'test';
    // 5000 fifteen minute bars ending on a Wednesday, weekends included, the
    // way Twelve Data prints them. Newest first, as the API returns them.
    const end = Date.UTC(2026, 8, 23, 12, 0);
    const values = Array.from({ length: 5000 }, (_, i) => {
      const t = new Date(end - i * 900_000);
      const stamp = t.toISOString().slice(0, 19).replace('T', ' ');
      return { datetime: stamp, open: '4300', high: '4301', low: '4299', close: '4300', volume: '0' };
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 'ok', values }), { status: 200 })) as unknown as typeof fetch;

    const page = await fetchHistoryPage('15min', null);
    expect(page.candles.length).toBeLessThan(5000);
    expect(page.candles.every((c) => new Date(c.time).getUTCDay() !== 6)).toBe(true);
    expect(page.exhausted).toBe(false);
  });

  test('are kept for Bitcoin, which trades through the weekend, and the symbol is asked for', async () => {
    process.env.TWELVE_DATA_API_KEY = 'test';
    const end = Date.UTC(2026, 8, 23, 12, 0);
    const values = Array.from({ length: 3000 }, (_, i) => {
      const stamp = new Date(end - i * 900_000).toISOString().slice(0, 19).replace('T', ' ');
      return { datetime: stamp, open: '110000', high: '110050', low: '109950', close: '110000', volume: '0' };
    });
    let asked = '';
    globalThis.fetch = (async (url: string) => {
      asked = String(url);
      return new Response(JSON.stringify({ status: 'ok', values }), { status: 200 });
    }) as unknown as typeof fetch;

    const page = await fetchHistoryPage('15min', null, 'BTC/USD');
    expect(new URL(asked).searchParams.get('symbol')).toBe('BTC/USD');
    expect(page.candles).toHaveLength(3000);
    expect(page.candles.some((c) => new Date(c.time).getUTCDay() === 6)).toBe(true);
    expect(page.provider).toBe('Twelve Data (BTC/USD spot)');
  });
});

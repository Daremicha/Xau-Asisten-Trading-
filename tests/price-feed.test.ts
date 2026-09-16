import { describe, expect, test } from 'bun:test';
import {
  candlesSinceUtcMidnight,
  mapTwelveDataCandles,
  mapYahooCandles,
  parseTwelveDataTime,
  previousDayClose,
} from '../lib/price-feed';

describe('Twelve Data parsing', () => {
  test('a zoneless datetime is read as UTC, not as local time', () => {
    expect(parseTwelveDataTime('2026-09-16 04:30:00')).toBe(Date.UTC(2026, 8, 16, 4, 30, 0));
  });

  test('an explicit zone is honoured', () => {
    expect(parseTwelveDataTime('2026-09-16T04:30:00Z')).toBe(Date.UTC(2026, 8, 16, 4, 30, 0));
  });

  test('newest first rows are returned oldest first', () => {
    const candles = mapTwelveDataCandles({
      values: [
        { datetime: '2026-09-16 10:30:00', open: '4210', high: '4215', low: '4208', close: '4212', volume: '30' },
        { datetime: '2026-09-16 10:15:00', open: '4200', high: '4211', low: '4199', close: '4210', volume: '20' },
      ],
    });
    expect(candles).toHaveLength(2);
    expect(candles[0].close).toBe(4210);
    expect(candles[1].close).toBe(4212);
    expect(candles[0].time).toBeLessThan(candles[1].time);
  });

  test('rows with unusable numbers are dropped rather than becoming NaN candles', () => {
    const candles = mapTwelveDataCandles({
      values: [
        { datetime: '2026-09-16 10:15:00', open: 'x', high: '1', low: '1', close: '1', volume: '1' },
        { datetime: '2026-09-16 10:30:00', open: '1', high: '2', low: '0.5', close: '1.5', volume: '1' },
      ],
    });
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(1.5);
  });

  test('a malformed payload yields no candles instead of throwing', () => {
    expect(mapTwelveDataCandles(null)).toHaveLength(0);
    expect(mapTwelveDataCandles({})).toHaveLength(0);
    expect(mapTwelveDataCandles({ values: 'nope' })).toHaveLength(0);
  });
});

describe('Yahoo parsing', () => {
  const payload = {
    chart: {
      result: [
        {
          timestamp: [1_700_000_000, 1_700_000_900],
          indicators: {
            quote: [
              {
                open: [4200, 4210],
                high: [4211, 4216],
                low: [4199, 4208],
                close: [4210, 4212],
                volume: [20, 30],
              },
            ],
          },
        },
      ],
    },
  };

  test('candles are built in chronological order with seconds converted to milliseconds', () => {
    const candles = mapYahooCandles(payload);
    expect(candles).toHaveLength(2);
    expect(candles[0].time).toBe(1_700_000_000_000);
    expect(candles[1].close).toBe(4212);
  });

  test('null gaps in the quote arrays are skipped', () => {
    const withGap = JSON.parse(JSON.stringify(payload));
    withGap.chart.result[0].indicators.quote[0].close[0] = null;
    expect(mapYahooCandles(withGap)).toHaveLength(1);
  });

  test('a malformed payload yields no candles instead of throwing', () => {
    expect(mapYahooCandles(null)).toHaveLength(0);
    expect(mapYahooCandles({ chart: {} })).toHaveLength(0);
  });
});

describe('session helpers', () => {
  const DAY = 86_400_000;
  const candles = [
    { time: 0, open: 1, high: 2, low: 0, close: 1.5, volume: 1 },
    { time: DAY - 900_000, open: 1, high: 2, low: 0, close: 1.75, volume: 1 },
    { time: DAY, open: 2, high: 3, low: 1, close: 2.5, volume: 1 },
    { time: DAY + 900_000, open: 2, high: 3, low: 1, close: 2.75, volume: 1 },
  ];

  test('only the reference day is kept', () => {
    const today = candlesSinceUtcMidnight(candles, DAY + 900_000);
    expect(today).toHaveLength(2);
    expect(today[0].time).toBe(DAY);
  });

  test('the previous close is the last candle before midnight', () => {
    expect(previousDayClose(candles, DAY + 900_000)).toBe(1.75);
  });

  test('with no earlier day there is no previous close to report', () => {
    expect(previousDayClose(candles.slice(2), DAY + 900_000)).toBeNull();
  });
});

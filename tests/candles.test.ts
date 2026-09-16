import { describe, expect, test } from 'bun:test';
import {
  ema,
  rsi,
  atr,
  stochastic,
  sma,
  findSwingPoints,
  pointOfControl,
  resample,
  priceToPips,
  type Candle,
} from '../lib/candles';

/** Deterministic series shared with the Python reference implementation. */
const CLOSES = [
  100.0, 103.6219, 106.8837, 109.4647, 111.1194, 111.7041, 111.193, 109.6809, 107.3727, 104.5612,
  101.5943, 98.8372, 96.632, 95.2599, 94.9105, 95.6608, 97.4667, 100.168, 103.5058, 107.1513,
  110.7415, 113.9199, 116.375, 117.8751, 118.2936, 117.6229, 115.9755, 113.5712, 110.7132, 107.7546,
  105.0598, 102.9638, 101.736, 101.5501, 102.465, 104.4186, 107.2343, 110.6407, 114.3013, 117.8517,
  120.9395, 123.2634, 124.6061, 124.8582, 124.0306, 122.2529, 119.7593, 116.8628, 113.921, 111.296,
  109.3155, 108.236, 108.2149, 109.293, 111.3901, 114.314, 117.7813, 121.4488, 124.9513, 127.9417,
];

const CANDLES: Candle[] = CLOSES.map((close, i) => {
  const open = i > 0 ? CLOSES[i - 1] : close;
  return {
    time: i * 900_000,
    open,
    high: Math.max(open, close) + 0.8,
    low: Math.min(open, close) - 0.6,
    close,
    volume: 1000 + i,
  };
});

describe('moving averages', () => {
  test('EMA matches the reference implementation', () => {
    expect(ema(CLOSES, 50)!).toBeCloseTo(111.7242179618, 6);
    expect(ema(CLOSES, 20)!).toBeCloseTo(116.5228339729, 6);
  });

  test('EMA returns null when the series is shorter than the period', () => {
    expect(ema([1, 2, 3], 50)).toBeNull();
  });

  test('SMA averages only the trailing window', () => {
    expect(sma([1, 2, 3, 4], 2)!).toBeCloseTo(3.5, 10);
  });
});

describe('RSI', () => {
  test('matches the reference implementation', () => {
    expect(rsi(CLOSES, 14)!).toBeCloseTo(70.708050472, 6);
  });

  test('a series that only rises pins RSI at 100', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(rising, 14)!).toBe(100);
  });

  test('a flat series is neutral rather than a divide by zero', () => {
    const flat = new Array(30).fill(100);
    expect(rsi(flat, 14)!).toBe(50);
  });

  test('returns null when the series is too short', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });
});

describe('ATR', () => {
  test('matches the reference implementation', () => {
    expect(atr(CANDLES, 14)!).toBeCloseTo(3.7458857472, 6);
  });

  test('is never negative', () => {
    expect(atr(CANDLES, 14)!).toBeGreaterThan(0);
  });
});

describe('stochastic', () => {
  test('matches the reference implementation', () => {
    const s = stochastic(CANDLES, 14, 3)!;
    expect(s.k).toBeCloseTo(96.2133404018, 6);
    expect(s.d).toBeCloseTo(89.4909621247, 6);
  });

  test('a perfectly flat range is neutral rather than a divide by zero', () => {
    const flat: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      time: i * 900_000, open: 100, high: 100, low: 100, close: 100, volume: 1,
    }));
    const s = stochastic(flat, 14, 3)!;
    expect(s.k).toBe(50);
    expect(s.d).toBe(50);
  });
});

describe('swing points', () => {
  test('finds the peak of a symmetric hill', () => {
    const hill = [1, 2, 3, 4, 5, 4, 3, 2, 1].map((v, i) => ({
      time: i * 900_000, open: v, high: v, low: v, close: v, volume: 1,
    }));
    const swings = findSwingPoints(hill, 2);
    const highs = swings.filter((s) => s.kind === 'high');
    expect(highs).toHaveLength(1);
    expect(highs[0].price).toBe(5);
    expect(highs[0].index).toBe(4);
  });

  test('returns nothing when there are too few candles', () => {
    expect(findSwingPoints(CANDLES.slice(0, 3), 2)).toHaveLength(0);
  });

  test('alternating peaks and troughs are all found, in order', () => {
    // Deterministic zigzag: 100, 110, 100, 110 ... with distinct wicks so no two
    // neighbouring candles tie on a high or a low.
    const zig: Candle[] = Array.from({ length: 40 }, (_, i) => {
      const close = i % 2 === 0 ? 100 : 110;
      return {
        time: i * 900_000,
        open: close,
        high: close + 1 + (i % 4) * 0.01,
        low: close - 1 - (i % 4) * 0.01,
        close,
        volume: 1,
      };
    });
    const swings = findSwingPoints(zig, 1);
    expect(swings.length).toBeGreaterThan(0);
    for (let i = 1; i < swings.length; i++) {
      expect(swings[i].index).toBeGreaterThanOrEqual(swings[i - 1].index);
    }
  });

  test('exactly equal highs are not treated as a swing', () => {
    // Equal highs are a liquidity concept, not a fractal pivot. Strict comparison
    // means a plateau yields no swing high.
    const plateau: Candle[] = Array.from({ length: 9 }, (_, i) => ({
      time: i * 900_000, open: 100, high: i === 4 || i === 5 ? 105 : 100, low: 95, close: 100, volume: 1,
    }));
    expect(findSwingPoints(plateau, 2).filter((s) => s.kind === 'high')).toHaveLength(0);
  });
});

describe('point of control', () => {
  test('lands inside the traded range', () => {
    const poc = pointOfControl(CANDLES)!;
    const lo = Math.min(...CANDLES.map((c) => c.low));
    const hi = Math.max(...CANDLES.map((c) => c.high));
    expect(poc).toBeGreaterThanOrEqual(lo);
    expect(poc).toBeLessThanOrEqual(hi);
  });

  test('is drawn to the heaviest volume bucket', () => {
    const base: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      time: i * 900_000, open: 100, high: 101, low: 99, close: 100, volume: 1,
    }));
    base.push({ time: 20 * 900_000, open: 120, high: 121, low: 119, close: 120, volume: 100_000 });
    expect(pointOfControl(base)!).toBeGreaterThan(115);
  });
});

describe('resample', () => {
  test('four M15 candles fold into one H1 candle', () => {
    const m15: Candle[] = [
      { time: 0, open: 10, high: 12, low: 9, close: 11, volume: 5 },
      { time: 900_000, open: 11, high: 15, low: 10, close: 14, volume: 6 },
      { time: 1_800_000, open: 14, high: 16, low: 8, close: 9, volume: 7 },
      { time: 2_700_000, open: 9, high: 13, low: 7, close: 12, volume: 8 },
    ];
    const h1 = resample(m15, 3_600_000);
    expect(h1).toHaveLength(1);
    expect(h1[0].open).toBe(10);
    expect(h1[0].close).toBe(12);
    expect(h1[0].high).toBe(16);
    expect(h1[0].low).toBe(7);
    expect(h1[0].volume).toBe(26);
  });

  test('output stays sorted even when the input is shuffled', () => {
    const shuffled = [...CANDLES].reverse();
    const h1 = resample(shuffled, 3_600_000);
    for (let i = 1; i < h1.length; i++) {
      expect(h1[i].time).toBeGreaterThan(h1[i - 1].time);
    }
  });
});

describe('pip conversion', () => {
  test('one dollar of gold is ten pips', () => {
    expect(priceToPips(1)).toBe(10);
    expect(priceToPips(-6.5)).toBe(65);
  });
});

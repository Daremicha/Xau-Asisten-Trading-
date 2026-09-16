import { describe, expect, test } from 'bun:test';
import type { Candle } from '../lib/candles';
import { findSwingPoints } from '../lib/candles';
import {
  analyzeTimeframe,
  classifyPricingZone,
  classifyTrend,
  resolveTrend,
  computeIndicators,
  computeQuasimodo,
  computeWyckoff,
  detectStructureBreaks,
  findFairValueGap,
  findLiquidityPools,
  findOrderBlock,
} from '../lib/smc-analysis';

const M15 = 900_000;

/** Builds a deterministic candle series around `base` with a per step drift. */
function series(base: number, steps: number, drift: number, wobble = 1.2): Candle[] {
  const out: Candle[] = [];
  let close = base;
  for (let i = 0; i < steps; i++) {
    const open = close;
    // Deterministic pseudo-oscillation, no randomness.
    const swing = Math.sin(i / 2.7) * wobble;
    close = open + drift + swing;
    out.push({
      time: i * M15,
      open,
      high: Math.max(open, close) + 0.4 + Math.abs(Math.cos(i / 1.9)) * 0.3,
      low: Math.min(open, close) - 0.4 - Math.abs(Math.sin(i / 2.3)) * 0.3,
      close,
      volume: 900 + ((i * 37) % 400),
    });
  }
  return out;
}

describe('trend classification', () => {
  test('higher highs with higher lows is bullish', () => {
    const swings = findSwingPoints(series(2000, 120, 1.1), 2);
    expect(classifyTrend(swings)).toBe('Bullish');
  });

  test('lower highs with lower lows is bearish', () => {
    const swings = findSwingPoints(series(2000, 120, -1.1), 2);
    expect(classifyTrend(swings)).toBe('Bearish');
  });

  test('too few swings falls back to ranging rather than guessing', () => {
    expect(classifyTrend([])).toBe('Ranging');
  });
});

describe('break of structure', () => {
  test('a close above a prior swing high is a bullish break at that level', () => {
    const breaks = detectStructureBreaks(series(2000, 120, 1.1), findSwingPoints(series(2000, 120, 1.1), 2));
    expect(breaks.length).toBeGreaterThan(0);
    expect(breaks[breaks.length - 1].direction).toBe('bullish');
  });

  test('a falling market breaks structure downward', () => {
    const c = series(2000, 120, -1.1);
    const breaks = detectStructureBreaks(c, findSwingPoints(c, 2));
    expect(breaks.length).toBeGreaterThan(0);
    expect(breaks[breaks.length - 1].direction).toBe('bearish');
  });

  test('break levels come from actual swing prices in the data', () => {
    const c = series(2000, 120, 1.1);
    const swings = findSwingPoints(c, 2);
    const swingPrices = new Set(swings.map((s) => s.price));
    for (const b of detectStructureBreaks(c, swings)) {
      expect(swingPrices.has(b.level)).toBe(true);
    }
  });
});

describe('fair value gap', () => {
  test('detects a bullish three candle imbalance and reports it open', () => {
    const c: Candle[] = [
      { time: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
      { time: M15, open: 101, high: 108, low: 100.8, close: 107.5, volume: 90 },
      { time: 2 * M15, open: 107, high: 110, low: 105, close: 109, volume: 40 },
    ];
    const fvg = findFairValueGap(c)!;
    expect(fvg.type).toBe('Bullish FVG');
    expect(fvg.bottom).toBe(101);
    expect(fvg.top).toBe(105);
    expect(fvg.status).toBe('Open');
  });

  test('a gap price later traded back through is marked mitigated', () => {
    const c: Candle[] = [
      { time: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
      { time: M15, open: 101, high: 108, low: 100.8, close: 107.5, volume: 90 },
      { time: 2 * M15, open: 107, high: 110, low: 105, close: 109, volume: 40 },
      { time: 3 * M15, open: 109, high: 109.5, low: 100.2, close: 101, volume: 70 },
    ];
    expect(findFairValueGap(c)!.status).toBe('Mitigated');
  });

  test('detects a bearish imbalance', () => {
    const c: Candle[] = [
      { time: 0, open: 110, high: 111, low: 109, close: 109.5, volume: 10 },
      { time: M15, open: 109, high: 109.2, low: 102, close: 102.5, volume: 90 },
      { time: 2 * M15, open: 102, high: 104, low: 100, close: 101, volume: 40 },
    ];
    const fvg = findFairValueGap(c)!;
    expect(fvg.type).toBe('Bearish FVG');
    expect(fvg.top).toBe(109);
    expect(fvg.bottom).toBe(104);
  });

  test('a market with no imbalance reports none', () => {
    const flat: Candle[] = Array.from({ length: 10 }, (_, i) => ({
      time: i * M15, open: 100, high: 101, low: 99, close: 100, volume: 5,
    }));
    expect(findFairValueGap(flat)).toBeNull();
  });
});

describe('order block', () => {
  test('a bullish break points at the last down candle before the move', () => {
    const c: Candle[] = [
      { time: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
      { time: M15, open: 100.5, high: 100.8, low: 97, close: 97.5, volume: 80 }, // down candle
      { time: 2 * M15, open: 97.5, high: 106, low: 97.4, close: 105.5, volume: 120 },
    ];
    const ob = findOrderBlock(c, { index: 2, level: 101, direction: 'bullish' })!;
    expect(ob.type).toBe('Bullish OB');
    expect(ob.high).toBe(100.8);
    expect(ob.low).toBe(97);
    expect(ob.mitigated).toBe(false);
  });

  test('price returning into the zone marks it mitigated', () => {
    const c: Candle[] = [
      { time: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
      { time: M15, open: 100.5, high: 100.8, low: 97, close: 97.5, volume: 80 },
      { time: 2 * M15, open: 97.5, high: 106, low: 97.4, close: 105.5, volume: 120 },
      { time: 3 * M15, open: 105, high: 105.2, low: 98, close: 99, volume: 60 },
    ];
    expect(findOrderBlock(c, { index: 2, level: 101, direction: 'bullish' })!.mitigated).toBe(true);
  });

  test('no break means no order block', () => {
    expect(findOrderBlock(series(2000, 20, 1), null)).toBeNull();
  });
});

describe('pricing zone', () => {
  test('below the midpoint is a discount and above is a premium', () => {
    expect(classifyPricingZone(20, 100, 0)).toBe('Discount');
    expect(classifyPricingZone(80, 100, 0)).toBe('Premium');
    expect(classifyPricingZone(50, 100, 0)).toBe('Equilibrium');
  });

  test('a zero width range does not divide by zero', () => {
    expect(classifyPricingZone(100, 100, 100)).toBe('Equilibrium');
  });
});

describe('liquidity pools', () => {
  test('previous day high and low come from the previous UTC day', () => {
    const candles: Candle[] = [];
    // Previous day: a tight 1900 to 1910 band.
    for (let i = 0; i < 96; i++) {
      candles.push({ time: i * M15, open: 1905, high: 1910, low: 1900, close: 1905, volume: 10 });
    }
    // Today: trades above the previous day high.
    for (let i = 0; i < 40; i++) {
      candles.push({ time: DAY + i * M15, open: 1915, high: 1925, low: 1912, close: 1920, volume: 10 });
    }
    const pools = findLiquidityPools(candles)!;
    expect(pools.pdh).toBe(1910);
    expect(pools.pdl).toBe(1900);
    expect(pools.swept).toBe(true);
    expect(pools.sweepDetail).toContain('Previous Day High');
  });

  test('empty input yields no pools rather than invented levels', () => {
    expect(findLiquidityPools([])).toBeNull();
  });
});

const DAY = 86_400_000;

describe('indicators from real candles', () => {
  test('a strong uptrend puts price above the long average', () => {
    const ind = computeIndicators(series(2000, 250, 1.4))!;
    expect(ind.trendFromEma).toBe('Bullish');
    expect(ind.ema50).toBeGreaterThan(ind.ema200);
    expect(ind.atr14).toBeGreaterThan(0);
    expect(ind.rsi14).toBeGreaterThan(50);
  });

  test('a downtrend reads bearish', () => {
    expect(computeIndicators(series(2000, 250, -1.4))!.trendFromEma).toBe('Bearish');
  });

  test('short data yields null instead of a fabricated reading', () => {
    expect(computeIndicators(series(2000, 5, 1))).toBeNull();
  });
});

describe('wyckoff and quasimodo', () => {
  test('an advancing market is in markup with the POC inside the range', () => {
    const c = series(2000, 120, 1.2);
    const w = computeWyckoff(c, 'Bullish')!;
    expect(w.phase).toBe('Markup');
    const lo = Math.min(...c.slice(-60).map((x) => x.low));
    const hi = Math.max(...c.slice(-60).map((x) => x.high));
    expect(w.pointOfControlPOC).toBeGreaterThanOrEqual(lo);
    expect(w.pointOfControlPOC).toBeLessThanOrEqual(hi);
  });

  test('a declining market is in markdown', () => {
    expect(computeWyckoff(series(2000, 120, -1.2), 'Bearish')!.phase).toBe('Markdown');
  });

  test('quasimodo levels are drawn from swing prices, not constants', () => {
    const c = series(2000, 120, 1.2);
    const qm = computeQuasimodo(c, findSwingPoints(c, 2))!;
    const lo = Math.min(...c.map((x) => x.low));
    const hi = Math.max(...c.map((x) => x.high));
    for (const level of [qm.leftShoulder, qm.headLiquiditySweep, qm.breakLevel, qm.optimalEntryZone]) {
      expect(level).toBeGreaterThanOrEqual(lo);
      expect(level).toBeLessThanOrEqual(hi);
    }
  });
});

describe('regression: structure tracks price at any scale', () => {
  // The previous engine hardcoded levels around 2880, so a 4200 market produced
  // an order block 1300 dollars away. Every level must now sit near real price.
  for (const base of [1200, 2900, 4200, 7500]) {
    test(`levels stay near price when gold trades at ${base}`, () => {
      const candles = series(base, 300, base * 0.0004);
      const structure = analyzeTimeframe(candles, 'H1', candles)!;
      const price = candles[candles.length - 1].close;
      const band = Math.max(price * 0.15, 50);

      const levels = [
        structure.orderBlock.high,
        structure.orderBlock.low,
        structure.fairValueGap.top,
        structure.fairValueGap.bottom,
        structure.liquidityPools.pdh,
        structure.liquidityPools.pdl,
        structure.liquidityPools.asiaHigh,
        structure.liquidityPools.asiaLow,
        structure.bosLevel ?? price,
      ];

      for (const level of levels) {
        expect(Math.abs(level - price)).toBeLessThan(band);
      }
    });
  }

  test('an uptrend reports bullish structure with a bullish break', () => {
    // Wobble exceeds drift so the advance prints real pullbacks and pivots.
    const candles = series(4200, 300, 1.6, 6.5);
    const s = analyzeTimeframe(candles, 'H1', candles)!;
    expect(s.trend).toBe('Bullish');
    expect(s.bosType).toBe('Bullish BOS');
  });

  test('a downtrend reports bearish structure, not a hardcoded bullish one', () => {
    const candles = series(4200, 300, -1.6, 6.5);
    const s = analyzeTimeframe(candles, 'H1', candles)!;
    expect(s.trend).toBe('Bearish');
    expect(s.bosType).toBe('Bearish BOS');
  });

  test('insufficient candles returns null instead of placeholder structure', () => {
    expect(analyzeTimeframe(series(4200, 4, 1), 'H1', [])).toBeNull();
  });
});

describe('trend resolution when pivots are scarce', () => {
  test('a clean advance with too few pivots still reads bullish from its breaks', () => {
    const candles = series(4200, 300, 1.6); // shallow wobble, almost monotonic
    const swings = findSwingPoints(candles, 3);
    const breaks = detectStructureBreaks(candles, swings);
    expect(swings).toHaveLength(0); // no pivots at all in a near vertical advance
    expect(classifyTrend(swings)).toBe('Ranging');
    expect(resolveTrend(swings, breaks, candles)).toBe('Bullish');
  });

  test('a clean decline with too few pivots still reads bearish', () => {
    const candles = series(4200, 300, -1.6);
    const swings = findSwingPoints(candles, 3);
    expect(resolveTrend(swings, detectStructureBreaks(candles, swings), candles)).toBe('Bearish');
  });

  test('with no breaks and no displacement it stays ranging rather than guessing', () => {
    expect(resolveTrend([], [])).toBe('Ranging');
    const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({
      time: i * M15, open: 100, high: 101, low: 99, close: 100, volume: 5,
    }));
    expect(resolveTrend([], [], flat)).toBe('Ranging');
  });
});

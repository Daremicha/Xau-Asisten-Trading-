import { describe, expect, test } from 'bun:test';
import { collectTargetLevels, selectTargets, type TargetInputs } from '../lib/target-engine';
import type { Candle } from '../lib/candles';
import type { SmcStructure } from '../lib/types';

function structure(overrides: Partial<SmcStructure> = {}): SmcStructure {
  return {
    timeframe: 'H1',
    trend: 'Bullish',
    chochDetected: false,
    orderBlock: { type: 'Bullish OB', high: 1995, low: 1990, mitigated: false, volumeConfirmation: true },
    fairValueGap: { detected: false, type: 'Bullish FVG', top: 0, bottom: 0, status: 'Mitigated' },
    liquidityPools: { pdh: 2030, pdl: 1960, asiaHigh: 2012, asiaLow: 1980, swept: false },
    pricingZone: 'Equilibrium',
    ...overrides,
  };
}

function candles(count = 150): Candle[] {
  // A gentle zigzag, so swing detection has something real to find.
  return Array.from({ length: count }, (_, i) => {
    const base = 2000 + Math.sin(i / 4) * 6;
    return {
      time: Date.UTC(2026, 0, 1) + i * 900_000,
      open: base,
      high: base + 1.5,
      low: base - 1.5,
      close: base + 0.2,
      volume: 900,
    };
  });
}

function inputs(overrides: Partial<TargetInputs> = {}): TargetInputs {
  return {
    entry: 2000,
    stop: 1990,
    direction: 'long',
    tradingStyle: 'Intraday',
    atr: 4,
    rewardMultiples: [1.5, 2.6, 4.0],
    structures: { d1: structure(), h4: structure(), h1: structure(), m15: structure() },
    candles: candles(),
    pivotBias: {
      directionalBias: 'BULLISH',
      pivotPoint: 2000,
      preferredScenario: '',
      alternativeScenario: '',
      keySupportLevels: [1994, 1988, 1980],
      keyResistanceLevels: [2006, 2011, 2018],
      confidenceScore: 70,
    },
    quasimodo: null,
    ...overrides,
  };
}

describe('levels a target can sit at', () => {
  test('only levels in front of the trade are collected', () => {
    const levels = collectTargetLevels(inputs());
    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) expect(level.price).toBeGreaterThan(2000);
  });

  test('a short trade looks the other way', () => {
    const levels = collectTargetLevels(inputs({ direction: 'short' }));
    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) expect(level.price).toBeLessThan(2000);
  });

  test('every level carries the reason it is one', () => {
    for (const level of collectTargetLevels(inputs())) {
      expect(level.label.length).toBeGreaterThan(3);
    }
  });

  test('levels stacked on top of each other are not counted twice', () => {
    const levels = collectTargetLevels(
      inputs({
        structures: {
          d1: structure({ liquidityPools: { pdh: 2006.05, pdl: 1960, asiaHigh: 2006.1, asiaLow: 1980, swept: false } }),
          h4: structure(),
          h1: structure(),
          m15: structure(),
        },
      })
    );
    const near2006 = levels.filter((l) => Math.abs(l.price - 2006) < 0.3);
    expect(near2006.length).toBeLessThanOrEqual(1);
  });
});

describe('where the targets land', () => {
  test('a target sits in front of the level it was drawn from', () => {
    const result = selectTargets(inputs());
    // Risk is ten dollars and the style asks 1.5R, so the target belongs near
    // 2015. The Asia high at 2012 is the level inside that window, and the
    // target stops short of it.
    expect(result.takeProfit1).toBeLessThan(2012);
    expect(result.basis[0]).toContain('di depan');
  });

  test('targets step away from the entry in order', () => {
    const result = selectTargets(inputs());
    expect(result.takeProfit1).toBeGreaterThan(2000);
    expect(result.takeProfit2).toBeGreaterThan(result.takeProfit1);
    expect(result.takeProfit3).toBeGreaterThan(result.takeProfit2);
  });

  test('a short trade mirrors it exactly', () => {
    const result = selectTargets(inputs({ direction: 'short' }));
    expect(result.takeProfit1).toBeLessThan(2000);
    expect(result.takeProfit2).toBeLessThan(result.takeProfit1);
    expect(result.takeProfit3).toBeLessThan(result.takeProfit2);
  });

  test('a level far nearer than the reward multiple is ignored, not used', () => {
    // A level one dollar away against a ten dollar stop would need better than
    // nine wins in ten to pay for itself. Snapping to it is how a rising strike
    // rate turns into a falling account.
    const result = selectTargets(
      inputs({
        pivotBias: {
          directionalBias: 'BULLISH',
          pivotPoint: 2000,
          preferredScenario: '',
          alternativeScenario: '',
          keySupportLevels: [1999],
          keyResistanceLevels: [2001],
          confidenceScore: 60,
        },
      })
    );
    // The target lands where the multiple says, in front of the Asia high at
    // 2012, and nowhere near the dollar wide pivot.
    expect(result.takeProfit1).toBeGreaterThan(2011);
    expect(result.riskReward).toBeGreaterThanOrEqual(1.125);
    expect(result.basis[0]).not.toContain('2001');
  });

  test('reward to risk never falls below three quarters of the multiple', () => {
    for (const direction of ['long', 'short'] as const) {
      for (const atr of [1, 4, 12]) {
        const result = selectTargets(inputs({ direction, atr }));
        expect(result.riskReward).toBeGreaterThanOrEqual(1.5 * 0.75 - 0.01);
      }
    }
  });

  test('reward to risk is measured from where the target actually landed', () => {
    const result = selectTargets(inputs());
    const measured = (result.takeProfit1 - 2000) / 10;
    expect(result.riskReward).toBeCloseTo(measured, 2);
  });

  test('an empty chart leaves the target on the multiple, and says so', () => {
    const empty = structure({
      liquidityPools: { pdh: 9000, pdl: 1000, asiaHigh: 9000, asiaLow: 1000, swept: false },
      orderBlock: { type: 'Bullish OB', high: 9000, low: 8999, mitigated: false, volumeConfirmation: false },
    });
    const result = selectTargets(
      inputs({
        structures: { d1: empty, h4: empty, h1: empty, m15: empty },
        pivotBias: null,
        candles: Array.from({ length: 150 }, (_, i) => ({
          time: Date.UTC(2026, 0, 1) + i * 900_000,
          open: 2000,
          high: 2000,
          low: 2000,
          close: 2000,
          volume: 0,
        })),
      })
    );
    expect(result.usedFallback).toBe(true);
    expect(result.basis[0]).toContain('tanpa level di dekatnya');
    // Nothing on the chart, so the target is exactly the style's multiple.
    expect(result.takeProfit1).toBeCloseTo(2015, 2);
  });
});

describe('three targets, three levels', () => {
  test('a level is not used for two targets at once', () => {
    const result = selectTargets(inputs());
    const named = result.basis.map((line) => line.split(' at ')[0]);
    // Either each target names a different level, or the later ones say plainly
    // that nothing was left to aim at.
    const levelBacked = result.basis.filter((line) => line.includes('di depan'));
    const uniqueLevels = new Set(
      result.basis.filter((line) => line.includes('di depan')).map((line) => line.split(' di ').at(-1))
    );
    expect(uniqueLevels.size).toBe(levelBacked.length);
    expect(named.length).toBe(3);
  });

  test('running out of levels falls back rather than crowding the last one', () => {
    const result = selectTargets(
      inputs({
        pivotBias: {
          directionalBias: 'BULLISH',
          pivotPoint: 2000,
          preferredScenario: '',
          alternativeScenario: '',
          keySupportLevels: [],
          keyResistanceLevels: [2006],
          confidenceScore: 60,
        },
        structures: {
          d1: structure({ liquidityPools: { pdh: 9000, pdl: 1000, asiaHigh: 9000, asiaLow: 1000, swept: false } }),
          h4: structure({ liquidityPools: { pdh: 9000, pdl: 1000, asiaHigh: 9000, asiaLow: 1000, swept: false } }),
          h1: structure({ liquidityPools: { pdh: 9000, pdl: 1000, asiaHigh: 9000, asiaLow: 1000, swept: false } }),
          m15: structure({ liquidityPools: { pdh: 9000, pdl: 1000, asiaHigh: 9000, asiaLow: 1000, swept: false } }),
        },
        candles: Array.from({ length: 150 }, (_, i) => ({
          time: Date.UTC(2026, 0, 1) + i * 900_000,
          open: 2000,
          high: 2000,
          low: 2000,
          close: 2000,
          volume: 0,
        })),
      })
    );
    expect(result.takeProfit2).toBeGreaterThan(result.takeProfit1);
    expect(result.takeProfit3).toBeGreaterThan(result.takeProfit2);
    expect(result.usedFallback).toBe(true);
  });
});

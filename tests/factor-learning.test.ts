import { describe, expect, test } from 'bun:test';
import {
  alignedVotes,
  directionOfOrder,
  factorMultipliers,
  factorReliability,
  FACTOR_MULTIPLIER_MAX,
  FACTOR_MULTIPLIER_MIN,
  MIN_FACTOR_SAMPLES,
  sanitiseFactorMultipliers,
  sanitiseFactorVotes,
} from '../lib/factor-learning';
import { deriveAdaptiveWeights, matchesDefaultPrior, normalisePrior } from '../lib/learning-engine';
import type { SelfLearningMemoryRecord } from '../lib/types';

/** Deterministic, so every assertion below is reproducible. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FACTORS = ['RSI', 'EMA structure', 'Stochastic', 'Wyckoff phase', 'Order block', 'Pivot and directional bias'];

/** A filled trade whose factors voted as given and which returned `r`. */
function trade(
  index: number,
  votes: Record<string, number>,
  r: number,
  overrides: Partial<SelfLearningMemoryRecord> = {}
): SelfLearningMemoryRecord {
  return {
    id: `t${index}`,
    analysisId: `a${index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + index * 3_600_000).toISOString(),
    outcome: r > 0 ? 'TP' : 'SL',
    symbol: 'XAUUSD',
    orderType: 'BUY LIMIT',
    entryPrice: 4200,
    exitPrice: 4200,
    profitOrLossPips: 0,
    profitOrLossDollars: r * 50,
    rootCauseAnalysis: { primaryFactor: '', institutionalFlowExplanation: '', liquidityBehavior: '' },
    strategyEvolutionLesson: '',
    tradingStyle: 'Intraday',
    context: {
      anchor: 'Order Block',
      convictionScore: 60,
      session: 'London Open',
      killZoneActive: true,
      timeframesAligned: true,
      newsNearby: false,
      entryDistancePips: 30,
      stopLossPips: 80,
      rMultiple: r,
      factorVotes: votes,
    },
    adaptiveWeightAdjustments: { fvgWeightDelta: 0, orderBlockWeightDelta: 0, newsFilterWeightDelta: 0, atrBufferMultiplier: 1 },
    ...overrides,
  };
}

/**
 * A history where every factor votes at random. `rigged` makes one factor's
 * vote change the odds, the way a genuinely useful or misleading signal would.
 */
function history(
  count: number,
  seed: number,
  rigged?: { name: string; winWhenAgreed: number; winWhenOpposed: number }
): SelfLearningMemoryRecord[] {
  const rnd = mulberry32(seed);
  const out: SelfLearningMemoryRecord[] = [];
  for (let i = 0; i < count; i++) {
    const votes: Record<string, number> = {};
    for (const name of FACTORS) votes[name] = rnd() < 0.5 ? 0.6 : -0.6;
    const odds = rigged ? (votes[rigged.name] > 0 ? rigged.winWhenAgreed : rigged.winWhenOpposed) : 0.42;
    out.push(trade(i, votes, rnd() < odds ? 1.5 : -1));
  }
  return out;
}

const reading = (records: SelfLearningMemoryRecord[], name: string) =>
  factorReliability(records).find((f) => f.name === name)!;

describe('votes are recorded facing the trade that was taken', () => {
  test('a factor that voted short agreed with a short and opposed a long', () => {
    const factors = [
      { name: 'RSI', direction: -0.6 },
      { name: 'EMA structure', direction: 1 },
    ];
    expect(alignedVotes(factors, 'short')).toEqual({ RSI: 0.6, 'EMA structure': -1 });
    expect(alignedVotes(factors, 'long')).toEqual({ RSI: -0.6, 'EMA structure': 1 });
  });

  test('a factor with no usable reading is left out rather than stored as a vote', () => {
    expect(alignedVotes([{ name: 'RSI', direction: Number.NaN }], 'long')).toEqual({});
  });

  test('the direction is read from the order type', () => {
    expect(directionOfOrder('SELL LIMIT')).toBe('short');
    expect(directionOfOrder('SELL INSTANT')).toBe('short');
    expect(directionOfOrder('BUY STOP')).toBe('long');
  });
});

describe('what comes back from storage is not trusted', () => {
  test('junk votes are dropped and an empty map becomes nothing', () => {
    expect(sanitiseFactorVotes({ RSI: 0.6, Bad: 'x', Huge: 1e9, '': 1, Nan: Number.NaN })).toEqual({ RSI: 0.6 });
    expect(sanitiseFactorVotes({ Bad: 'x' })).toBeUndefined();
    expect(sanitiseFactorVotes(null)).toBeUndefined();
    expect(sanitiseFactorVotes([0.5])).toBeUndefined();
  });

  test('a stored multiplier is held to the range learning could have produced', () => {
    expect(sanitiseFactorMultipliers({ RSI: 0.1, EMA: 9, Stochastic: 1, Pivot: 0.83 })).toEqual({
      RSI: FACTOR_MULTIPLIER_MIN,
      EMA: FACTOR_MULTIPLIER_MAX,
      Pivot: 0.83,
    });
    expect(sanitiseFactorMultipliers({ Stochastic: 1 })).toBeUndefined();
  });
});

describe('a factor is judged only on evidence that can judge it', () => {
  test('too few trades on either side moves nothing, however lopsided they look', () => {
    // Seven trades RSI opposed, every one a winner; seven it backed, every one
    // a loser. Dramatic, and still not enough to say anything.
    const records = [
      ...Array.from({ length: MIN_FACTOR_SAMPLES - 1 }, (_, i) => trade(i, { RSI: -0.6 }, 1.5)),
      ...Array.from({ length: MIN_FACTOR_SAMPLES - 1 }, (_, i) => trade(100 + i, { RSI: 0.6 }, -1)),
    ];
    expect(reading(records, 'RSI').multiplier).toBe(1);
  });

  test('missed orders say nothing about direction and are left out', () => {
    const records = history(120, 5).map((r, i) =>
      i % 2 === 0 ? { ...r, outcome: 'MISSED' as const, context: { ...r.context!, rMultiple: 0 } } : r
    );
    const counted = factorReliability(records).find((f) => f.name === 'RSI')!;
    expect(counted.agreedSamples + counted.opposedSamples).toBe(60);
  });

  test('rows recorded before votes were kept are ignored, not guessed at', () => {
    const old = history(50, 9).map((r) => ({ ...r, context: { ...r.context!, factorVotes: undefined } }));
    expect(factorReliability(old)).toEqual([]);
  });

  test('a vote near zero is silence, not agreement', () => {
    const records = Array.from({ length: 20 }, (_, i) => trade(i, { RSI: 0.05 }, 1.5));
    const rsi = reading(records, 'RSI');
    expect(rsi.agreedSamples).toBe(0);
    expect(rsi.opposedSamples).toBe(0);
  });
});

describe('the engine learns which factors to trust', () => {
  test('a factor that keeps backing the losing side has its vote turned down', () => {
    // RSI agreed with trades that won 30% of the time and opposed trades that
    // won 55%: the market kept doing what RSI argued against.
    const rsi = reading(history(300, 7, { name: 'RSI', winWhenAgreed: 0.3, winWhenOpposed: 0.55 }), 'RSI');
    expect(rsi.edge!).toBeLessThan(0);
    expect(rsi.multiplier).toBeLessThan(1);
    expect(rsi.multiplier).toBeGreaterThanOrEqual(FACTOR_MULTIPLIER_MIN);
  });

  test('a factor that keeps being right has its vote turned up', () => {
    const ema = reading(
      history(300, 7, { name: 'EMA structure', winWhenAgreed: 0.58, winWhenOpposed: 0.28 }),
      'EMA structure'
    );
    expect(ema.edge!).toBeGreaterThan(0);
    expect(ema.multiplier).toBeGreaterThan(1);
    expect(ema.multiplier).toBeLessThanOrEqual(FACTOR_MULTIPLIER_MAX);
  });

  test('the factors that did not matter are left alone while one is corrected', () => {
    const records = history(300, 7, { name: 'RSI', winWhenAgreed: 0.3, winWhenOpposed: 0.55 });
    const others = factorReliability(records).filter((f) => f.name !== 'RSI');
    for (const factor of others) expect(Math.abs(factor.multiplier - 1)).toBeLessThan(0.1);
  });

  test('even a factor that was always wrong keeps half its say, and is never inverted', () => {
    // Inverting a factor would be fitting a pattern that may not survive the
    // next regime. Turning it down is the most the evidence can justify.
    const records = Array.from({ length: 200 }, (_, i) =>
      trade(i, { RSI: i % 2 === 0 ? 0.6 : -0.6 }, i % 2 === 0 ? -1 : 1.5)
    );
    const rsi = reading(records, 'RSI');
    // Close to the floor, because the evidence is overwhelming, and never
    // through it. Confidence never reaches certainty, so the floor itself is
    // approached rather than hit.
    expect(rsi.multiplier).toBeGreaterThanOrEqual(FACTOR_MULTIPLIER_MIN);
    expect(rsi.multiplier).toBeLessThan(0.6);
  });
});

describe('on a market with no pattern, nothing is learned', () => {
  test('almost every factor keeps its full say across many random histories', () => {
    // The test that separates learning from fitting noise. Eleven factors
    // judged at once will find something by chance unless the bar is high.
    let readings = 0;
    let moved = 0;
    let largest = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (const factor of factorReliability(history(150, seed))) {
        readings += 1;
        if (factor.multiplier !== 1) moved += 1;
        largest = Math.max(largest, Math.abs(factor.multiplier - 1));
      }
    }
    expect(moved / readings).toBeLessThan(0.1);
    expect(largest).toBeLessThan(0.3);
  });
});

describe('what the learning engine does with it', () => {
  const misleading = history(300, 7, { name: 'RSI', winWhenAgreed: 0.3, winWhenOpposed: 0.55 });

  test('the multiplier reaches the weights the signal engine reads, with a reason', () => {
    const learned = deriveAdaptiveWeights(misleading, 'Intraday');
    expect(learned.factorMultipliers.RSI).toBeLessThan(1);
    expect(learned.adjustments.some((line) => line.startsWith('RSI kept pointing the wrong way'))).toBe(true);
    expect(learned.factorReliability.length).toBeGreaterThan(0);
  });

  test('only factors that moved are carried as multipliers', () => {
    const learned = deriveAdaptiveWeights(misleading, 'Intraday');
    expect(learned.factorMultipliers).toEqual(factorMultipliers(learned.factorReliability));
    for (const value of Object.values(learned.factorMultipliers)) expect(value).not.toBe(1);
  });

  test('an empty history carries no multipliers at all', () => {
    expect(deriveAdaptiveWeights([], 'Intraday').factorMultipliers).toEqual({});
  });
});

describe('a backtest can hand its verdicts to live trading', () => {
  test('an adopted prior keeps the factor trust the run learned, bounded', () => {
    const prior = normalisePrior({ factorMultipliers: { RSI: 0.7, Stochastic: 7 } });
    expect(prior.factorMultipliers).toEqual({ RSI: 0.7, Stochastic: FACTOR_MULTIPLIER_MAX });
  });

  test('a prior that learned nothing about factors carries no field, so Firestore accepts it', () => {
    const prior = normalisePrior({ factorMultipliers: { RSI: 1 } });
    expect('factorMultipliers' in prior).toBe(false);
  });

  test('a run that only learned to distrust a factor is still worth offering', () => {
    expect(matchesDefaultPrior(normalisePrior(null))).toBe(true);
    expect(matchesDefaultPrior({ ...normalisePrior(null), factorMultipliers: { RSI: 0.7 } })).toBe(false);
  });

  test('live analysis starts from the adopted verdicts', () => {
    const learned = deriveAdaptiveWeights([], 'Intraday', { factorMultipliers: { RSI: 0.7 } });
    expect(learned.factorMultipliers).toEqual({ RSI: 0.7 });
    expect(learned.adjustments.some((line) => line.includes('Carried from the adopted backtest: RSI 0.7x'))).toBe(true);
  });

  test('the account’s own verdict replaces the backtest’s once it has one', () => {
    const misleading = history(300, 7, { name: 'RSI', winWhenAgreed: 0.3, winWhenOpposed: 0.55 });
    const own = deriveAdaptiveWeights(misleading, 'Intraday').factorMultipliers.RSI;
    const merged = deriveAdaptiveWeights(misleading, 'Intraday', { factorMultipliers: { RSI: 1.4 } });
    expect(merged.factorMultipliers.RSI).toBe(own);
  });
});

describe('how far back a factor is judged', () => {
  test('evenly across a whole replay when asked, so old evidence is not thrown away', () => {
    // The oldest hundred trades carry the pattern and the newest hundred are
    // flat. A short memory barely sees it; the whole-period reading does.
    const old = history(200, 3, { name: 'RSI', winWhenAgreed: 0.25, winWhenOpposed: 0.6 });
    const recent = history(200, 4).map((r, i) => ({
      ...r,
      timestamp: new Date(Date.UTC(2027, 0, 1) + i * 3_600_000).toISOString(),
    }));
    const records = [...old, ...recent];
    const whole = factorReliability(records, Number.POSITIVE_INFINITY).find((f) => f.name === 'RSI')!;
    const short = factorReliability(records, 20).find((f) => f.name === 'RSI')!;
    expect(Math.abs(whole.strength!)).toBeGreaterThan(Math.abs(short.strength!));
    expect(whole.agreedSamples + whole.opposedSamples).toBe(400);
  });

  test('evenly weighted, the averages are plain averages', () => {
    const records = [
      trade(0, { RSI: 0.6 }, 1.5),
      trade(1, { RSI: 0.6 }, -1),
      trade(2, { RSI: -0.6 }, -1),
    ];
    const rsi = factorReliability(records, Number.POSITIVE_INFINITY).find((f) => f.name === 'RSI')!;
    expect(rsi.agreedR).toBe(0.25);
    expect(rsi.opposedR).toBe(-1);
  });
});

import { describe, expect, test } from 'bun:test';
import {
  PRIOR_WEIGHTS,
  confidenceFrom,
  deriveAdaptiveWeights,
  entryBufferCeiling,
  normaliseConfluence,
  normalisePrior,
  recencyWeight,
  shrinkToward,
  summariseEvidence,
} from '../lib/learning-engine';
import type { SelfLearningMemoryRecord, TradingStyle } from '../lib/types';

let clock = 0;
function record(
  outcome: 'TP' | 'SL' | 'MISSED',
  opts: { missPips?: number; factor?: string; style?: TradingStyle } = {}
): SelfLearningMemoryRecord & { tradingStyle?: TradingStyle } {
  clock += 60_000;
  const entry = 4200;
  const missAway = (opts.missPips ?? 0) / 10;
  return {
    id: `r${clock}`,
    analysisId: `a${clock}`,
    timestamp: new Date(clock).toISOString(),
    outcome,
    symbol: 'XAUUSD',
    orderType: 'BUY LIMIT',
    entryPrice: entry,
    exitPrice: outcome === 'MISSED' ? entry + missAway : entry + (outcome === 'TP' ? 15 : -7),
    profitOrLossPips: outcome === 'TP' ? 150 : outcome === 'SL' ? -70 : 0,
    profitOrLossDollars: outcome === 'TP' ? 150 : outcome === 'SL' ? -70 : 0,
    rootCauseAnalysis: {
      primaryFactor: opts.factor ?? 'Structure',
      institutionalFlowExplanation: 'x',
      liquidityBehavior: 'y',
    },
    strategyEvolutionLesson: 'lesson',
    adaptiveWeightAdjustments: {
      fvgWeightDelta: 0, orderBlockWeightDelta: 0, newsFilterWeightDelta: 0, atrBufferMultiplier: 1,
    },
    tradingStyle: opts.style,
  };
}

describe('honest reporting of what the record set supports', () => {
  test('no trades means no win rate, not a flattering default', () => {
    const e = summariseEvidence([]);
    expect(e.winRate).toBeNull();
    expect(e.smoothedWinRate).toBeNull();
    expect(e.confidence).toBe(0);
    expect(deriveAdaptiveWeights([]).historicalWinRate).toBe(0);
  });

  test('missed orders alone produce no win rate, since none were triggered', () => {
    // The reported screen showed 80% with zero TP and zero SL.
    const e = summariseEvidence([record('MISSED'), record('MISSED'), record('MISSED')]);
    expect(e.triggeredCount).toBe(0);
    expect(e.winRate).toBeNull();
    expect(e.missRate).toBe(100);
  });

  test('a single win is not reported as a perfect strike rate', () => {
    const e = summariseEvidence([record('TP')]);
    expect(e.winRate).toBe(100);
    expect(e.smoothedWinRate).toBeLessThan(80);
  });

  test('smoothing loosens its grip as evidence accumulates', () => {
    const few = summariseEvidence(Array.from({ length: 2 }, () => record('TP')));
    const many = summariseEvidence(Array.from({ length: 40 }, () => record('TP')));
    expect(many.smoothedWinRate!).toBeGreaterThan(few.smoothedWinRate!);
  });
});

describe('recency', () => {
  test('the newest trade carries full weight and older ones decay', () => {
    expect(recencyWeight(0)).toBe(1);
    expect(recencyWeight(20)).toBeCloseTo(0.5, 6);
    expect(recencyWeight(40)).toBeCloseTo(0.25, 6);
  });

  test('recent results move the reading more than stale ones', () => {
    const staleLosses = [
      ...Array.from({ length: 30 }, () => record('SL')),
      ...Array.from({ length: 10 }, () => record('TP')),
    ];
    const e = summariseEvidence(staleLosses);
    // Raw count is 25% wins; recency weighting lifts it because the wins are newer.
    expect(e.winRate!).toBeGreaterThan(25);
  });

  test('effective sample size never exceeds the real one', () => {
    const e = summariseEvidence(Array.from({ length: 50 }, () => record('TP')));
    expect(e.effectiveSampleSize).toBeLessThan(e.sampleSize);
    expect(e.effectiveSampleSize).toBeGreaterThan(0);
  });
});

describe('adjustments scale with evidence rather than piling up', () => {
  test('confidence rises with evidence but never reaches certainty', () => {
    expect(confidenceFrom(0)).toBe(0);
    expect(confidenceFrom(8)).toBeCloseTo(0.5, 6);
    expect(confidenceFrom(1000)).toBeLessThan(1);
  });

  test('three stop outs move the buffer far less than thirty do', () => {
    const three = deriveAdaptiveWeights(Array.from({ length: 3 }, () => record('SL')));
    const thirty = deriveAdaptiveWeights(Array.from({ length: 30 }, () => record('SL')));
    const driftThree = Math.abs(three.atrBufferFactor - PRIOR_WEIGHTS.atrBufferFactor);
    const driftThirty = Math.abs(thirty.atrBufferFactor - PRIOR_WEIGHTS.atrBufferFactor);
    expect(driftThirty).toBeGreaterThan(driftThree);
  });

  test('a weight can never run away from its prior', () => {
    const many = deriveAdaptiveWeights(Array.from({ length: 500 }, () => record('MISSED', { missPips: 400 })));
    for (const [key, prior] of [
      ['fairValueGapWeight', PRIOR_WEIGHTS.fairValueGapWeight],
      ['orderBlockWeight', PRIOR_WEIGHTS.orderBlockWeight],
    ] as const) {
      expect(Math.abs(many[key] - prior)).toBeLessThanOrEqual(0.35);
    }
  });

  test('shrinkToward respects both confidence and the drift ceiling', () => {
    expect(shrinkToward(0.2, 0.6, 0, 1)).toBe(0.2);
    expect(shrinkToward(0.2, 0.6, 1, 1)).toBeCloseTo(0.6, 6);
    expect(shrinkToward(0.2, 0.6, 1, 0.05)).toBeCloseTo(0.25, 6);
  });
});

describe('the confluence weights stay a coherent distribution', () => {
  test('they sum to one after normalisation', () => {
    const w = normaliseConfluence({
      orderBlockWeight: 0.9, fairValueGapWeight: 0.1, liquiditySweepWeight: 0.4,
      newsImpactWeight: 0.2, indicatorConfluenceWeight: 0.05,
    });
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 3);
  });

  test('they still sum to one after real learning', () => {
    for (const n of [0, 1, 5, 40]) {
      const d = deriveAdaptiveWeights(Array.from({ length: n }, () => record('MISSED', { missPips: 150 })));
      const total =
        d.orderBlockWeight + d.fairValueGapWeight + d.liquiditySweepWeight +
        d.newsImpactWeight + d.indicatorConfluenceWeight;
      expect(total).toBeCloseTo(1, 2);
    }
  });

  test('no weight is ever driven to zero', () => {
    const d = deriveAdaptiveWeights(Array.from({ length: 100 }, () => record('MISSED', { missPips: 300 })));
    for (const v of [d.orderBlockWeight, d.fairValueGapWeight, d.liquiditySweepWeight,
      d.newsImpactWeight, d.indicatorConfluenceWeight]) {
      expect(v).toBeGreaterThan(0);
    }
  });
});

describe('the stop buffer adapts in both directions', () => {
  test('a poor strike rate widens it', () => {
    const d = deriveAdaptiveWeights(Array.from({ length: 30 }, () => record('SL')));
    expect(d.atrBufferFactor).toBeGreaterThan(PRIOR_WEIGHTS.atrBufferFactor);
  });

  test('a strong strike rate tightens it, which the old engine never did', () => {
    const d = deriveAdaptiveWeights(Array.from({ length: 30 }, () => record('TP')));
    expect(d.atrBufferFactor).toBeLessThan(PRIOR_WEIGHTS.atrBufferFactor);
  });

  test('it stays inside sane bounds under any history', () => {
    for (const outcome of ['TP', 'SL', 'MISSED'] as const) {
      const d = deriveAdaptiveWeights(Array.from({ length: 200 }, () => record(outcome)));
      expect(d.atrBufferFactor).toBeGreaterThanOrEqual(0.8);
      expect(d.atrBufferFactor).toBeLessThanOrEqual(2.5);
    }
  });

  test('a mixed record leaves it near the starting point', () => {
    const mixed = Array.from({ length: 20 }, (_, i) => record(i % 2 === 0 ? 'TP' : 'SL'));
    expect(Math.abs(deriveAdaptiveWeights(mixed).atrBufferFactor - PRIOR_WEIGHTS.atrBufferFactor)).toBeLessThan(0.3);
  });
});

describe('learning the actual distance orders miss by', () => {
  test('the median miss distance is measured, not guessed', () => {
    const e = summariseEvidence([
      record('MISSED', { missPips: 100 }),
      record('MISSED', { missPips: 200 }),
      record('MISSED', { missPips: 300 }),
    ]);
    expect(e.medianMissPips).toBe(200);
  });

  test('repeated misses do not pull entries toward price', () => {
    // A 24 month replay of real candles froze this adaptation and traded the
    // period again: it earned less than the defaults and raised the worst
    // drawdown from 22% to 31.6%. A missed order costs nothing, so the engine
    // no longer treats one as a problem to fix.
    const d = deriveAdaptiveWeights(Array.from({ length: 20 }, () => record('MISSED', { missPips: 200 })));
    expect(d.entryBufferPips).toBe(0);
    expect(d.adjustments.join(' ')).toContain('costs nothing');
  });

  test('a bigger miss still teaches nothing about where to put the entry', () => {
    const small = deriveAdaptiveWeights(Array.from({ length: 20 }, () => record('MISSED', { missPips: 50 })));
    const large = deriveAdaptiveWeights(Array.from({ length: 20 }, () => record('MISSED', { missPips: 400 })));
    expect(large.entryBufferPips).toBe(small.entryBufferPips);
  });

  test('misses no longer shift weight toward the shallower level either', () => {
    const d = deriveAdaptiveWeights(Array.from({ length: 30 }, () => record('MISSED', { missPips: 200 })));
    expect(d.fairValueGapWeight).toBeCloseTo(PRIOR_WEIGHTS.fairValueGapWeight, 3);
    expect(d.orderBlockWeight).toBeCloseTo(PRIOR_WEIGHTS.orderBlockWeight, 3);
  });

  test('trades that filled teach nothing about entry distance', () => {
    expect(deriveAdaptiveWeights(Array.from({ length: 20 }, () => record('TP'))).entryBufferPips).toBe(0);
  });

  test('the correction is capped so entries cannot collapse onto price', () => {
    const d = deriveAdaptiveWeights(Array.from({ length: 200 }, () => record('MISSED', { missPips: 5000 })));
    expect(d.entryBufferPips).toBeLessThanOrEqual(120);
  });
});

describe('news attribution', () => {
  test('losses traced to a release strengthen the news shield', () => {
    const base = deriveAdaptiveWeights(Array.from({ length: 20 }, () => record('SL')));
    const newsy = deriveAdaptiveWeights(
      Array.from({ length: 20 }, () => record('SL', { factor: 'FOMC release volatility' }))
    );
    expect(newsy.newsImpactWeight).toBeGreaterThan(base.newsImpactWeight);
    expect(newsy.adjustments.join(' ')).toContain('news');
  });
});

describe('learning per trading style', () => {
  test('a style with enough history is judged on its own results', () => {
    const history = [
      ...Array.from({ length: 10 }, () => record('SL', { style: 'Scalping' })),
      ...Array.from({ length: 10 }, () => record('TP', { style: 'Swing' })),
    ];
    const scalp = deriveAdaptiveWeights(history, 'Scalping');
    const swing = deriveAdaptiveWeights(history, 'Swing');
    expect(scalp.atrBufferFactor).toBeGreaterThan(swing.atrBufferFactor);
  });

  test('a style with too little history borrows the overall picture', () => {
    const history = Array.from({ length: 20 }, () => record('SL', { style: 'Swing' }));
    const scalp = deriveAdaptiveWeights(history, 'Scalping');
    const overall = deriveAdaptiveWeights(history);
    expect(scalp.atrBufferFactor).toBe(overall.atrBufferFactor);
  });
});

describe('the engine explains itself', () => {
  test('an untested engine says so rather than implying it has learned', () => {
    expect(deriveAdaptiveWeights([]).adjustments.join(' ')).toContain('No closed trades yet');
  });

  test('every adjustment is accompanied by a reason', () => {
    const d = deriveAdaptiveWeights(Array.from({ length: 20 }, () => record('MISSED', { missPips: 250 })));
    expect(d.adjustments.length).toBeGreaterThan(0);
    for (const line of d.adjustments) expect(line.length).toBeGreaterThan(20);
  });
});

describe('the headline strike rate cannot mislead on a tiny sample', () => {
  test('a single win reports well under a hundred percent', () => {
    const e = summariseEvidence([record('TP')]);
    expect(e.winRate).toBe(100);
    // This is the number the dashboard shows.
    expect(e.smoothedWinRate!).toBeLessThan(70);
  });

  test('a single loss is not reported as a total failure either', () => {
    const e = summariseEvidence([record('SL')]);
    expect(e.winRate).toBe(0);
    expect(e.smoothedWinRate!).toBeGreaterThan(20);
  });

  test('with real evidence the two converge', () => {
    const many = summariseEvidence(
      Array.from({ length: 60 }, (_, i) => record(i % 10 < 6 ? 'TP' : 'SL'))
    );
    expect(Math.abs(many.smoothedWinRate! - many.winRate!)).toBeLessThan(5);
  });
});

describe('starting from a backtested prior', () => {
  test('an empty history returns the prior it was given, not the defaults', () => {
    const prior = {
      orderBlockWeight: 0.4,
      fairValueGapWeight: 0.2,
      liquiditySweepWeight: 0.2,
      newsImpactWeight: 0.1,
      indicatorConfluenceWeight: 0.1,
      atrBufferFactor: 1.8,
      entryBufferPips: 30,
    };
    const weights = deriveAdaptiveWeights([], 'Intraday', prior);
    expect(weights.orderBlockWeight).toBeCloseTo(0.4, 3);
    expect(weights.atrBufferFactor).toBe(1.8);
    expect(weights.entryBufferPips).toBe(30);
  });

  test('a prior whose weights do not sum to one is rescaled, never used raw', () => {
    const prior = normalisePrior({
      orderBlockWeight: 4,
      fairValueGapWeight: 2,
      liquiditySweepWeight: 2,
      newsImpactWeight: 1,
      indicatorConfluenceWeight: 1,
      atrBufferFactor: 1.4,
      entryBufferPips: 12,
    });
    const total =
      prior.orderBlockWeight +
      prior.fairValueGapWeight +
      prior.liquiditySweepWeight +
      prior.newsImpactWeight +
      prior.indicatorConfluenceWeight;
    expect(total).toBeCloseTo(1, 3);
    expect(prior.orderBlockWeight).toBeCloseTo(0.4, 3);
  });

  test('an out of range prior is clamped into what the engine allows', () => {
    const prior = normalisePrior({ atrBufferFactor: 99, entryBufferPips: 9999 });
    expect(prior.atrBufferFactor).toBeLessThanOrEqual(2.5);
    expect(prior.entryBufferPips).toBeLessThanOrEqual(120);
  });

  test('junk falls back to the engine defaults instead of breaking analysis', () => {
    expect(normalisePrior(null)).toEqual({ ...PRIOR_WEIGHTS });
    const partial = normalisePrior({ atrBufferFactor: Number.NaN });
    expect(partial.atrBufferFactor).toBe(PRIOR_WEIGHTS.atrBufferFactor);
  });

  test('real trades still move the engine off the prior it started from', () => {
    const prior = { ...PRIOR_WEIGHTS, atrBufferFactor: 1.0, entryBufferPips: 0 };
    const stopOuts = Array.from({ length: 30 }, () => record('SL', { style: 'Intraday' }));
    const weights = deriveAdaptiveWeights(stopOuts, 'Intraday', prior);
    expect(weights.atrBufferFactor).toBeGreaterThan(1.0);
  });
});

describe('an entry buffer only ever comes from a backtest', () => {
  /** A filled trade whose money result can be set. */
  function filled(outcome: 'TP' | 'SL', dollars: number): SelfLearningMemoryRecord {
    return { ...record(outcome), profitOrLossDollars: dollars };
  }

  test('profitable fills do not license chasing the ones that missed', () => {
    // The fills a closer entry would add are the marginal setups, not the
    // average one, and an engine cannot see the result of a trade it never took.
    const history = [
      ...Array.from({ length: 20 }, () => record('MISSED', { missPips: 200 })),
      ...Array.from({ length: 20 }, () => filled('TP', 27)),
    ];
    expect(deriveAdaptiveWeights(history, 'Intraday').entryBufferPips).toBe(0);
  });

  test('a buffer adopted from a backtest is honoured', () => {
    const history = Array.from({ length: 20 }, () => record('MISSED', { missPips: 200 }));
    const weights = deriveAdaptiveWeights(history, 'Intraday', {
      ...PRIOR_WEIGHTS,
      entryBufferPips: 40,
    });
    expect(weights.entryBufferPips).toBe(40);
  });

  test('an adopted buffer is still capped at what the style allows', () => {
    const weights = deriveAdaptiveWeights([], 'Scalping', { ...PRIOR_WEIGHTS, entryBufferPips: 100 });
    expect(weights.entryBufferPips).toBe(28);
  });

  test('expectancy is reported per filled trade, ignoring the misses', () => {
    const evidence = summariseEvidence([
      filled('TP', 30),
      filled('SL', -10),
      record('MISSED', { missPips: 100 }),
    ]);
    expect(evidence.expectancyDollars).toBeGreaterThan(0);
    expect(evidence.expectancyDollars).toBeLessThan(30);
  });

  test('no filled trade means no expectancy, not zero', () => {
    expect(summariseEvidence([record('MISSED', { missPips: 100 })]).expectancyDollars).toBeNull();
  });
});

describe('an entry may not be dragged off its own level', () => {
  test('the ceiling follows the risk the style allows', () => {
    // 40% of the style's maximum stop: a scalp risking at most 70 pips cannot
    // have its entry moved 120.
    expect(entryBufferCeiling('Scalping')).toBe(28);
    expect(entryBufferCeiling('Intraday')).toBe(72);
    expect(entryBufferCeiling('Swing')).toBe(120);
    expect(entryBufferCeiling(undefined)).toBe(120);
  });

  test('an adopted buffer is clamped per style, however large it arrives', () => {
    const wild = { ...PRIOR_WEIGHTS, entryBufferPips: 5000 };
    expect(deriveAdaptiveWeights([], 'Intraday', wild).entryBufferPips).toBe(72);
    expect(deriveAdaptiveWeights([], 'Scalping', wild).entryBufferPips).toBe(28);
  });
});

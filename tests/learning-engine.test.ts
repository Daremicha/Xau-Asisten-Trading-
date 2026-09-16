import { describe, expect, test } from 'bun:test';
import {
  PRIOR_WEIGHTS,
  confidenceFrom,
  deriveAdaptiveWeights,
  normaliseConfluence,
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

  test('three misses move a weight far less than thirty do', () => {
    const three = deriveAdaptiveWeights(Array.from({ length: 3 }, () => record('MISSED', { missPips: 200 })));
    const thirty = deriveAdaptiveWeights(Array.from({ length: 30 }, () => record('MISSED', { missPips: 200 })));
    const driftThree = Math.abs(three.fairValueGapWeight - PRIOR_WEIGHTS.fairValueGapWeight);
    const driftThirty = Math.abs(thirty.fairValueGapWeight - PRIOR_WEIGHTS.fairValueGapWeight);
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

  test('repeated misses pull entries closer to price', () => {
    const d = deriveAdaptiveWeights(Array.from({ length: 20 }, () => record('MISSED', { missPips: 200 })));
    expect(d.entryBufferPips).toBeGreaterThan(0);
    expect(d.adjustments.join(' ')).toContain('closer to price');
  });

  test('a bigger miss teaches a bigger correction', () => {
    const small = deriveAdaptiveWeights(Array.from({ length: 20 }, () => record('MISSED', { missPips: 50 })));
    const large = deriveAdaptiveWeights(Array.from({ length: 20 }, () => record('MISSED', { missPips: 400 })));
    expect(large.entryBufferPips).toBeGreaterThan(small.entryBufferPips);
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

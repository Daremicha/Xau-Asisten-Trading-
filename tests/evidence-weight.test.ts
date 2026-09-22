/**
 * What the engine is willing to learn from, and how much.
 *
 * Every record used to count the same, weighted only by how recent it was. So
 * a trade the engine invented — a market order recorded as stopped out seconds
 * after it was offered, against a range the market traded before the order
 * existed — taught the engine exactly as forcefully as a result the trader
 * read off their own terminal.
 */
import { describe, expect, test } from 'bun:test';
import { evidenceWeight, recencyWeight, summariseEvidence } from '../lib/learning-engine';
import type { SelfLearningMemoryRecord } from '../lib/types';

function row(over: Record<string, unknown> = {}): SelfLearningMemoryRecord {
  return {
    id: 'r', analysisId: 'setup_x', timestamp: new Date().toISOString(),
    outcome: 'SL', symbol: 'XAUUSD', orderType: 'BUY LIMIT',
    entryPrice: 4300, exitPrice: 4290, profitOrLossPips: -100, profitOrLossDollars: -10,
    rootCauseAnalysis: { primaryFactor: '', institutionalFlowExplanation: '', liquidityBehavior: '' },
    strategyEvolutionLesson: '', tradingStyle: 'Intraday',
    context: {
      anchor: 'Order Block', convictionScore: 70, session: 'London', killZoneActive: false,
      timeframesAligned: true, newsNearby: false, entryDistancePips: 40,
      stopLossPips: 100, rMultiple: -1,
    },
    adaptiveWeightAdjustments: {
      fvgWeightDelta: 0, orderBlockWeightDelta: 0, newsFilterWeightDelta: 0, atrBufferMultiplier: 1,
    },
    ...over,
  } as unknown as SelfLearningMemoryRecord;
}

describe('a checked result outweighs an unchecked one', () => {
  test('the user’s own testimony carries full weight', () => {
    // They read it off their terminal. Nothing outranks that.
    expect(evidenceWeight(row({ autoResolved: false }), 0)).toBe(recencyWeight(0));
  });

  test('so does a row the audit has been over', () => {
    const audited = row({ autoResolved: true, audit: { at: 'x', verdict: 'confirmed', confirmed: true } });
    expect(evidenceWeight(audited, 0)).toBe(recencyWeight(0));
  });

  test('a machine reading nobody has examined counts for less', () => {
    const unverified = row({ autoResolved: true });
    expect(evidenceWeight(unverified, 0)).toBeLessThan(recencyWeight(0));
    // Not nothing, though: most auto-resolutions are right, and a row that
    // taught nothing would waste a real trade.
    expect(evidenceWeight(unverified, 0)).toBeGreaterThan(0);
  });

  test('recency still applies on top of it', () => {
    const old = row({ autoResolved: true });
    expect(evidenceWeight(old, 10)).toBeLessThan(evidenceWeight(old, 0));
  });
});

describe('what that changes about the picture the engine forms', () => {
  test('an unchecked losing streak moves the strike rate less than a checked one', () => {
    const wins = Array.from({ length: 4 }, () =>
      row({ outcome: 'TP', profitOrLossDollars: 10, autoResolved: false })
    );
    const unchecked = [...wins, ...Array.from({ length: 4 }, () => row({ autoResolved: true }))];
    const checked = [...wins, ...Array.from({ length: 4 }, () => row({ autoResolved: false }))];

    const a = summariseEvidence(unchecked).smoothedWinRate;
    const b = summariseEvidence(checked).smoothedWinRate;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // The same four losses hurt less when nobody has verified them.
    expect(a!).toBeGreaterThan(b!);
  });

  test('a ledger of verified results is unaffected by the change', () => {
    const verified = Array.from({ length: 6 }, () => row({ autoResolved: false }));
    expect(summariseEvidence(verified).effectiveSampleSize).toBeGreaterThan(0);
  });
});

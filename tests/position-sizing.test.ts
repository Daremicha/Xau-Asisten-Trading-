import { describe, expect, test } from 'bun:test';
import {
  assessConviction,
  drawdownFromHistory,
  effectiveRiskPercentage,
  type ConvictionInputs,
} from '../lib/position-sizing';

const NEUTRAL: ConvictionInputs = {
  confidenceScore: 50,
  timeframesAligned: false,
  killZoneActive: false,
  entryOutOfReach: false,
  dataStale: false,
  proposalRejected: false,
};

describe('a strong setup earns a bigger lot than a weak one', () => {
  test('full agreement sizes larger than a conflicted read', () => {
    const strong = assessConviction({ ...NEUTRAL, confidenceScore: 85, timeframesAligned: true, killZoneActive: true });
    const weak = assessConviction({ ...NEUTRAL, confidenceScore: 20 });
    expect(strong.multiplier).toBeGreaterThan(weak.multiplier);
    expect(strong.band).toBe('High');
    expect(weak.band).toBe('Low');
  });

  test('timeframe alignment on its own raises the size', () => {
    const aligned = assessConviction({ ...NEUTRAL, timeframesAligned: true });
    expect(aligned.multiplier).toBeGreaterThan(assessConviction(NEUTRAL).multiplier);
  });

  test('a kill zone raises it further', () => {
    const inZone = assessConviction({ ...NEUTRAL, killZoneActive: true });
    expect(inZone.multiplier).toBeGreaterThan(assessConviction(NEUTRAL).multiplier);
  });
});

describe('the budget is a normal size, and the lean above it is bounded', () => {
  test('the very best setup may ask for more than the budget, and never much more', () => {
    const best = assessConviction({
      confidenceScore: 100, timeframesAligned: true, killZoneActive: true,
      entryOutOfReach: false, dataStale: false, proposalRejected: false,
    });
    expect(best.multiplier).toBeGreaterThan(1);
    expect(best.multiplier).toBeLessThanOrEqual(1.25);
    expect(best.notes.join(' ')).toContain('a lean on a setup the engine is sure of');
  });

  test('the worst possible setup still sizes something, not zero', () => {
    const worst = assessConviction({
      confidenceScore: 0, timeframesAligned: false, killZoneActive: false,
      entryOutOfReach: true, dataStale: true, proposalRejected: true,
    });
    expect(worst.multiplier).toBeGreaterThanOrEqual(0.25);
    expect(worst.multiplier).toBeLessThan(0.5);
  });

  test('across every combination the multiplier stays inside its band', () => {
    for (const confidenceScore of [0, 25, 50, 75, 100]) {
      for (const aligned of [true, false]) {
        for (const stale of [true, false]) {
          const r = assessConviction({ ...NEUTRAL, confidenceScore, timeframesAligned: aligned, dataStale: stale });
          expect(r.multiplier).toBeGreaterThanOrEqual(0.25);
          expect(r.multiplier).toBeLessThanOrEqual(1.25);
        }
      }
    }
  });

  test('the whole budget, and no more, at the point conviction is called high', () => {
    // Seventy is where the band above earned 1.87 cent a trade against 1.13 for
    // the lowest one. At the line itself the size is exactly the budget.
    const atLine = assessConviction({ ...NEUTRAL, confidenceScore: 58, timeframesAligned: true });
    expect(atLine.convictionScore).toBe(70);
    expect(atLine.multiplier).toBe(1);
  });
});

describe('what withdraws the lean, whatever the chart says', () => {
  const sure = { ...NEUTRAL, confidenceScore: 100, timeframesAligned: true, killZoneActive: true };

  test('an account below its high water mark sizes at the budget, not above', () => {
    const drawn = assessConviction({ ...sure, drawdownPercent: 12 });
    expect(drawn.multiplier).toBeLessThanOrEqual(1);
    expect(drawn.notes.join(' ')).toContain('below its high water mark');
  });

  test('a kind of setup that has been losing sizes at the budget, not above', () => {
    const losing = assessConviction({ ...sure, measuredEdgeR: -0.4 });
    expect(losing.multiplier).toBeLessThanOrEqual(1);
    expect(losing.notes.join(' ')).toContain('have been losing');
  });

  test('a stale quote sizes at the budget, not above', () => {
    const stale = assessConviction({ ...sure, dataStale: true });
    expect(stale.multiplier).toBeLessThanOrEqual(1);
  });

  test('a healthy account with a measured edge keeps the lean', () => {
    const healthy = assessConviction({ ...sure, drawdownPercent: 2, measuredEdgeR: 0.4 });
    expect(healthy.multiplier).toBeGreaterThan(1);
  });
});

describe('conditions that should shrink the lot', () => {
  test('a stale quote cuts size sharply', () => {
    const stale = assessConviction({ ...NEUTRAL, confidenceScore: 80, dataStale: true });
    const live = assessConviction({ ...NEUTRAL, confidenceScore: 80 });
    expect(stale.multiplier).toBeLessThan(live.multiplier);
    expect(stale.notes.join(' ')).toContain('stale');
  });

  test('an entry that may never fill cuts size', () => {
    const far = assessConviction({ ...NEUTRAL, confidenceScore: 80, entryOutOfReach: true });
    expect(far.multiplier).toBeLessThan(assessConviction({ ...NEUTRAL, confidenceScore: 80 }).multiplier);
  });

  test('a rejected model proposal cuts size', () => {
    const rejected = assessConviction({ ...NEUTRAL, confidenceScore: 80, proposalRejected: true });
    expect(rejected.multiplier).toBeLessThan(assessConviction({ ...NEUTRAL, confidenceScore: 80 }).multiplier);
  });
});

describe('a small lot is never a mystery', () => {
  test('every deduction is named', () => {
    const r = assessConviction({ ...NEUTRAL, dataStale: true, entryOutOfReach: true, proposalRejected: true });
    const text = r.notes.join(' ');
    expect(text).toContain('stale');
    expect(text).toContain('may never fill');
    expect(text).toContain('rejected');
  });

  test('the first note states the outcome in plain terms', () => {
    expect(assessConviction(NEUTRAL).notes[0]).toContain('of the risk budget is committed');
  });
});

describe('the effective risk percentage', () => {
  test('scales the requested figure by the multiplier', () => {
    expect(effectiveRiskPercentage(2, 0.5)).toBe(1);
    expect(effectiveRiskPercentage(1, 1)).toBe(1);
  });

  test('keeps enough precision for a cent account', () => {
    expect(effectiveRiskPercentage(0.5, 0.375)).toBeCloseTo(0.1875, 4);
  });

  test('never returns a negative', () => {
    expect(effectiveRiskPercentage(-1, 0.5)).toBe(0);
  });
});

describe('the account state sizes the trade too', () => {
  const base = {
    confidenceScore: 70,
    timeframesAligned: true,
    killZoneActive: true,
    entryOutOfReach: false,
    dataStale: false,
    proposalRejected: false,
  };

  test('a deep drawdown commits less', () => {
    const healthy = assessConviction(base);
    const hurting = assessConviction({ ...base, drawdownPercent: 25 });
    expect(hurting.multiplier).toBeLessThan(healthy.multiplier);
    expect(hurting.notes.join(' ')).toContain('high water mark');
  });

  test('a shallow drawdown trims rather than cuts', () => {
    const light = assessConviction({ ...base, drawdownPercent: 12 });
    const heavy = assessConviction({ ...base, drawdownPercent: 25 });
    expect(light.multiplier).toBeGreaterThan(heavy.multiplier);
    expect(light.multiplier).toBeLessThan(assessConviction(base).multiplier);
  });

  test('an account at its high water mark is not penalised', () => {
    expect(assessConviction({ ...base, drawdownPercent: 0 }).multiplier).toBe(
      assessConviction(base).multiplier
    );
  });

  test('a kind of setup that has been losing commits less', () => {
    const losing = assessConviction({ ...base, measuredEdgeR: -0.5 });
    expect(losing.multiplier).toBeLessThan(assessConviction(base).multiplier);
    expect(losing.notes.join(' ')).toContain('in your own history');
  });

  test('a kind of setup that has been paying commits more', () => {
    const paying = assessConviction({ ...base, measuredEdgeR: 0.6, confidenceScore: 50 });
    const neutral = assessConviction({ ...base, confidenceScore: 50 });
    expect(paying.multiplier).toBeGreaterThan(neutral.multiplier);
  });

  test('no measured edge changes nothing', () => {
    expect(assessConviction({ ...base, measuredEdgeR: null }).multiplier).toBe(
      assessConviction(base).multiplier
    );
  });
});

describe('drawdown read from the trade history', () => {
  const trade = (profitOrLossDollars: number) => ({ profitOrLossDollars });

  test('an account at a new high is not in drawdown', () => {
    expect(drawdownFromHistory(1200, [trade(100), trade(100)])).toBe(0);
  });

  test('the fall is measured from the peak, not from the start', () => {
    // 1000 up to 1500, back to 1200: a fifth off the high water mark.
    expect(drawdownFromHistory(1200, [trade(500), trade(-300)])).toBe(20);
  });

  test('no history means no drawdown to report', () => {
    expect(drawdownFromHistory(5000, [])).toBe(0);
  });

  test('a record with no money on it counts as flat rather than breaking the sum', () => {
    expect(drawdownFromHistory(900, [trade(200), {}, trade(-300)])).toBe(25);
  });
});

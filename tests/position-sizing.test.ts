import { describe, expect, test } from 'bun:test';
import { assessConviction, effectiveRiskPercentage, type ConvictionInputs } from '../lib/position-sizing';

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

describe('the risk percentage the user chose is a ceiling, never exceeded', () => {
  test('even the best possible setup commits at most the full budget', () => {
    const best = assessConviction({
      confidenceScore: 100, timeframesAligned: true, killZoneActive: true,
      entryOutOfReach: false, dataStale: false, proposalRejected: false,
    });
    expect(best.multiplier).toBeLessThanOrEqual(1);
    expect(effectiveRiskPercentage(1, best.multiplier)).toBeLessThanOrEqual(1);
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
          expect(r.multiplier).toBeLessThanOrEqual(1);
        }
      }
    }
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

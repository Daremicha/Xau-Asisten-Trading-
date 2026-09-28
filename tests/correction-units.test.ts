import { describe, expect, test } from 'bun:test';
import { fromAccountUnits, toAccountUnits } from '../lib/account-display';
import { repairCorrectionUnits } from '../lib/record-audit';
import type { SelfLearningMemoryRecord } from '../lib/types';

const row = (over: Partial<SelfLearningMemoryRecord>): SelfLearningMemoryRecord =>
  ({
    id: 'r',
    analysisId: 'a',
    timestamp: '2026-09-23T01:11:00.000Z',
    outcome: 'SL',
    symbol: 'XAUUSD',
    orderType: 'BUY LIMIT',
    entryPrice: 4351.84,
    exitPrice: 4333.84,
    profitOrLossPips: -180,
    profitOrLossDollars: -18,
    ...over,
  }) as SelfLearningMemoryRecord;

describe('amounts typed in the account unit', () => {
  test('cents typed on a cent account are stored as dollars', () => {
    expect(fromAccountUnits(-18, 'Cent')).toBe(-0.18);
    expect(toAccountUnits(fromAccountUnits(26.35, 'Cent'), 'Cent')).toBeCloseTo(26.35, 6);
    expect(fromAccountUnits(-18, 'Standard')).toBe(-18);
  });
});

describe('repairing corrections stored before the unit was converted', () => {
  const corrected = row({ id: 'c', audit: { at: 'x', verdict: 'corrected', confirmed: false, correctedFrom: 'MISSED' } });

  test('a correction typed as 18 cents but stored as 18 dollars becomes 18 cents again', () => {
    const { records, repaired } = repairCorrectionUnits([row({ id: 'plain', profitOrLossDollars: -0.18 }), corrected], 'Cent');
    expect(repaired.map((r) => r.id)).toEqual(['c']);
    expect(records[1].profitOrLossDollars).toBe(-0.18);
    expect(records[1].audit?.moneyUnit).toBe('USD');
    // Rows nobody corrected are left exactly as they were.
    expect(records[0].profitOrLossDollars).toBe(-0.18);
  });

  test('runs once: a repaired row is not divided again', () => {
    const once = repairCorrectionUnits([corrected], 'Cent').records;
    const twice = repairCorrectionUnits(once, 'Cent');
    expect(twice.repaired).toHaveLength(0);
    expect(twice.records[0].profitOrLossDollars).toBe(-0.18);
  });

  test('leaves a dollar account alone, where the label and the storage agreed', () => {
    expect(repairCorrectionUnits([corrected], 'Standard').repaired).toHaveLength(0);
  });
});

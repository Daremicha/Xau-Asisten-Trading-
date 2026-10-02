import { describe, expect, test } from 'bun:test';
import { previousMisses } from '../lib/repeat-level';
import type { SelfLearningMemoryRecord } from '../lib/types';

const NOW = Date.parse('2026-10-02T04:00:00.000Z');
const miss = (over: Partial<SelfLearningMemoryRecord>): SelfLearningMemoryRecord =>
  ({
    id: 'r' + Math.random(),
    analysisId: 'old',
    timestamp: '2026-10-02T01:10:00.000Z',
    outcome: 'MISSED',
    orderType: 'SELL LIMIT',
    entryPrice: 4158.67,
    ...over,
  }) as SelfLearningMemoryRecord;
const setup = { id: 'now', orderType: 'SELL LIMIT' as const, entryPrice: 4158.67 };

describe('a level that already missed', () => {
  test('is counted when the same side missed within a dollar this week', () => {
    const found = previousMisses(setup, [miss({}), miss({ entryPrice: 4159.4, timestamp: '2026-10-02T01:13:00.000Z' })], NOW);
    expect(found?.count).toBe(2);
    expect(found?.lastAt).toBe('2026-10-02T01:13:00.000Z');
  });

  test('ignores other levels, the other side, filled trades, old misses and the setup itself', () => {
    const records = [
      miss({ entryPrice: 4161 }),
      miss({ orderType: 'BUY LIMIT' }),
      miss({ outcome: 'SL' }),
      miss({ timestamp: '2026-09-20T00:00:00.000Z' }),
      miss({ analysisId: 'now' }),
      miss({ id: 'bt_1' }),
    ];
    expect(previousMisses(setup, records, NOW)).toBeNull();
  });
});

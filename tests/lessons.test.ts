import { describe, expect, test } from 'bun:test';
import { sessionOfTrade, tradeLessons } from '../lib/lessons';
import type { SelfLearningMemoryRecord } from '../lib/types';

let n = 0;
const trade = (
  outcome: 'TP' | 'SL' | 'MISSED',
  over: { order?: string; r?: number; placed?: string; anchor?: string; id?: string } = {}
): SelfLearningMemoryRecord =>
  ({
    id: over.id ?? `t${n++}`,
    analysisId: 'a',
    timestamp: over.placed ?? '2026-09-29T06:00:00.000Z',
    placedAt: over.placed ?? '2026-09-29T06:00:00.000Z',
    outcome,
    symbol: 'XAUUSD',
    orderType: over.order ?? 'SELL LIMIT',
    entryPrice: 4150,
    exitPrice: 4150,
    profitOrLossPips: 0,
    profitOrLossDollars: 0,
    context: {
      anchor: over.anchor ?? 'Order Block',
      convictionScore: 30,
      session: 'Off-Hours',
      killZoneActive: false,
      timeframesAligned: false,
      newsNearby: false,
      entryDistancePips: 0,
      stopLossPips: 180,
      rMultiple: over.r ?? (outcome === 'TP' ? 1.3 : outcome === 'SL' ? -1 : 0),
    },
  }) as unknown as SelfLearningMemoryRecord;

describe('lessons from the user’s trades', () => {
  test('says plainly when there are too few closed trades', () => {
    const lessons = tradeLessons([trade('TP'), trade('SL'), trade('MISSED')]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].title).toContain('belum cukup');
  });

  test('names the kind of setup that has been losing, and how much evidence it rests on', () => {
    const records = [
      ...Array.from({ length: 4 }, () => trade('SL', { order: 'SELL INSTANT' })),
      trade('TP', { order: 'SELL INSTANT', r: 0.5 }),
      ...Array.from({ length: 4 }, () => trade('TP', { order: 'SELL LIMIT' })),
      trade('SL', { order: 'SELL LIMIT' }),
    ];
    const lessons = tradeLessons(records);
    const losing = lessons.find((l) => l.title.startsWith('Order yang terisi di harga market'));
    expect(losing?.tone).toBe('bad');
    expect(losing?.detail).toContain('1 dari 5 menang');
    expect(losing?.detail).toContain('tanda awal');
    expect(lessons.find((l) => l.title.startsWith('Order pending'))?.tone).toBe('good');
  });

  test('leaves replayed backtest rows out', () => {
    const records = [
      ...Array.from({ length: 4 }, (_, i) => trade('TP', { id: `bt_${i}` })),
      trade('SL'),
      trade('TP'),
    ];
    expect(tradeLessons(records)[0].title).toContain('belum cukup');
  });

  test('says that many misses cost nothing', () => {
    const records = [
      ...Array.from({ length: 5 }, () => trade('TP')),
      ...Array.from({ length: 6 }, () => trade('MISSED')),
    ];
    expect(tradeLessons(records).some((l) => l.title === '6 dari 11 order tidak pernah terisi')).toBe(true);
  });

  test('places trades in their WIB session', () => {
    expect(sessionOfTrade(trade('TP', { placed: '2026-09-29T08:00:00.000Z' }))).toContain('London'); // 15:00 WIB
    expect(sessionOfTrade(trade('TP', { placed: '2026-09-29T01:00:00.000Z' }))).toContain('Asia'); // 08:00 WIB
    expect(sessionOfTrade(trade('TP', { placed: '2026-09-29T13:00:00.000Z' }))).toContain('New York'); // 20:00 WIB
    expect(sessionOfTrade(trade('TP', { placed: '2026-09-29T20:00:00.000Z' }))).toContain('larut'); // 03:00 WIB
  });
});

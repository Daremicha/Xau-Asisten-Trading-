import { describe, expect, test } from 'bun:test';
import {
  auditRecord,
  auditableRecords,
  contradictsRecord,
  placementTime,
  reconstructStop,
} from '../lib/record-audit';
import type { Candle } from '../lib/candles';
import type { SelfLearningMemoryRecord } from '../lib/types';

const M15 = 15 * 60_000;
const PLACED = Date.UTC(2026, 8, 17, 12, 0, 0);

function bar(index: number, high: number, low: number): Candle {
  return {
    time: PLACED + index * M15,
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: 100,
  };
}

/** A buy limit at 4300 with a 100 pip ($10) stop, so the stop sits at 4290. */
function record(over: Record<string, unknown> = {}): SelfLearningMemoryRecord {
  return {
    id: 'learn_1',
    analysisId: 'setup_' + PLACED.toString(36) + 'ab12',
    placedAt: new Date(PLACED).toISOString(),
    // When the row was written: an hour after the order went on the book.
    timestamp: new Date(PLACED + 4 * M15).toISOString(),
    outcome: 'MISSED',
    symbol: 'XAUUSD',
    orderType: 'BUY LIMIT',
    entryPrice: 4300,
    exitPrice: 4311,
    profitOrLossPips: 0,
    profitOrLossDollars: 0,
    rootCauseAnalysis: { primaryFactor: '', institutionalFlowExplanation: '', liquidityBehavior: '' },
    strategyEvolutionLesson: '',
    tradingStyle: 'Intraday',
    autoResolved: true,
    context: {
      anchor: 'Order Block',
      convictionScore: 70,
      session: 'London',
      killZoneActive: false,
      timeframesAligned: true,
      newsNearby: false,
      entryDistancePips: 40,
      stopLossPips: 100,
      rMultiple: 0,
    },
    adaptiveWeightAdjustments: {
      fvgWeightDelta: 0,
      orderBlockWeightDelta: 0,
      newsFilterWeightDelta: 0,
      atrBufferMultiplier: 1,
    },
    ...over,
  } as unknown as SelfLearningMemoryRecord;
}

describe('finding when the order was actually placed', () => {
  test('the explicit field is used when a row carries one', () => {
    expect(placementTime(record())).toBe(PLACED);
  });

  test('an older row recovers it from the analysis id', () => {
    // Rows written before the field existed. The id is
    // setup_<base36 milliseconds><four random characters>.
    const older = record({ placedAt: undefined });
    expect(placementTime(older)).toBe(PLACED);
  });

  test('the row write time is never mistaken for the placement time', () => {
    // This is the bug the field exists to prevent: a miss is recorded long
    // after its order went on the book, and auditing from there searches the
    // wrong window entirely.
    const written = Date.parse(record().timestamp);
    expect(written).toBeGreaterThan(PLACED);
    expect(placementTime(record({ placedAt: undefined }))).not.toBe(written);
  });

  test('an unusable id yields nothing rather than a guess', () => {
    expect(placementTime(record({ placedAt: undefined, analysisId: 'nonsense' }))).toBeNull();
  });
});

describe('rebuilding the stop from what the row kept', () => {
  test('a buy is protected below its entry, a sell above', () => {
    expect(reconstructStop(record())).toBe(4290);
    expect(reconstructStop(record({ orderType: 'SELL LIMIT' }))).toBe(4310);
  });

  test('a row with no stop distance cannot be replayed', () => {
    expect(reconstructStop({ ...record(), context: undefined })).toBeNull();
  });
});

describe('a stop loss booked against a level the market never touched', () => {
  // The reported trade: a market sell recorded as stopped out seconds later,
  // while the market was still where the order opened.
  const phantom = record({
    outcome: 'SL',
    orderType: 'SELL INSTANT',
    entryPrice: 4346.31,
    exitPrice: 4364.31,
    profitOrLossDollars: -18,
    context: { ...(record().context as object), stopLossPips: 180 },
    placedAt: new Date(PLACED).toISOString(),
    timestamp: new Date(PLACED + 4_000).toISOString(),
  });

  test('is contradicted, because price stayed at the entry', () => {
    const candles = [bar(0, 4350, 4342), bar(1, 4351, 4344)];
    const verdict = auditRecord(phantom, candles);
    expect(verdict.kind).toBe('contradicted');
    if (verdict.kind !== 'contradicted') throw new Error('expected a contradiction');
    expect(verdict.reason).toContain('never reached the stop');
    expect(contradictsRecord(verdict)).toBe(true);
  });

  test('a stop the market genuinely traded through is confirmed', () => {
    // Same order, but price really does run up through 4364.31.
    const real = { ...phantom, timestamp: new Date(PLACED + 3 * M15).toISOString() };
    const candles = [bar(0, 4350, 4342), bar(1, 4366, 4348)];
    const verdict = auditRecord(real, candles);
    expect(verdict.kind).toBe('confirmed');
    expect(contradictsRecord(verdict)).toBe(false);
  });
});

describe('a take profit booked against a level the market never reached', () => {
  const claimedWin = record({
    outcome: 'TP',
    orderType: 'SELL INSTANT',
    entryPrice: 4346.31,
    exitPrice: 4329.0,
    profitOrLossDollars: 17.32,
    context: { ...(record().context as object), stopLossPips: 180 },
    timestamp: new Date(PLACED + 4_000).toISOString(),
  });

  test('is contradicted when price never went there', () => {
    const candles = [bar(0, 4350, 4342), bar(1, 4351, 4344)];
    const verdict = auditRecord(claimedWin, candles);
    expect(verdict.kind).toBe('contradicted');
    if (verdict.kind !== 'contradicted') throw new Error('expected a contradiction');
    expect(verdict.reason).toContain('never reached 4329.00');
  });

  test('is confirmed when it did', () => {
    const real = { ...claimedWin, timestamp: new Date(PLACED + 3 * M15).toISOString() };
    const candles = [bar(0, 4350, 4342), bar(1, 4348, 4327)];
    expect(auditRecord(real, candles).kind).toBe('confirmed');
  });

  test('a win that was really a loss is caught', () => {
    // Price ran to the stop before ever reaching the claimed target.
    const real = { ...claimedWin, timestamp: new Date(PLACED + 3 * M15).toISOString() };
    const candles = [bar(0, 4350, 4342), bar(1, 4366, 4344)];
    const verdict = auditRecord(real, candles);
    expect(verdict.kind).toBe('contradicted');
    if (verdict.kind !== 'contradicted') throw new Error('expected a contradiction');
    expect(verdict.reason).toContain('not a take profit');
  });
});

describe('a missed entry', () => {
  test('that price never came near is confirmed, and keeps its lesson', () => {
    const candles = [bar(0, 4310, 4305), bar(1, 4315, 4308), bar(2, 4320, 4312)];
    const verdict = auditRecord(record(), candles);
    expect(verdict.kind).toBe('confirmed');
    expect(verdict.actual).toBe('never-filled');
  });

  test('that actually filled and ran is contradicted', () => {
    const candles = [bar(0, 4306, 4302), bar(1, 4303, 4298), bar(2, 4318, 4310)];
    const verdict = auditRecord(record(), candles);
    expect(verdict.kind).toBe('contradicted');
    expect(verdict.bestPrice).toBe(4318);
  });

  test('that filled and was stopped out is contradicted as a loss', () => {
    const candles = [bar(0, 4303, 4298), bar(1, 4302, 4288)];
    const verdict = auditRecord(record(), candles);
    expect(verdict.kind).toBe('contradicted');
    if (verdict.kind !== 'contradicted') throw new Error('expected a contradiction');
    expect(verdict.reason).toContain('stop loss, not a missed entry');
  });
});

describe('the window is the trade’s own lifetime', () => {
  test('price reaching a level after the row was written does not count', () => {
    // The row was written four bars in. The market reached the entry long
    // after, which belongs to no part of this trade.
    const candles = [bar(0, 4310, 4305), bar(1, 4312, 4306), bar(20, 4303, 4298), bar(21, 4330, 4310)];
    expect(auditRecord(record(), candles).kind).toBe('confirmed');
  });

  test('price reaching a level before the order was placed does not count', () => {
    const late = record({
      placedAt: new Date(PLACED + 5 * M15).toISOString(),
      timestamp: new Date(PLACED + 8 * M15).toISOString(),
    });
    // The dip to the entry happens at bar 1, long before the order existed.
    const candles = [bar(0, 4310, 4305), bar(1, 4303, 4298), bar(6, 4312, 4307), bar(7, 4314, 4309)];
    expect(auditRecord(late, candles).kind).toBe('confirmed');
  });
});

describe('what it refuses to conclude', () => {
  test('history that does not cover the trade is unknown', () => {
    const candles = [bar(100, 4306, 4302), bar(101, 4303, 4298)];
    const verdict = auditRecord(record(), candles);
    expect(verdict.kind).toBe('unknown');
    expect(contradictsRecord(verdict)).toBe(false);
  });

  test('no history at all is unknown', () => {
    expect(auditRecord(record(), []).kind).toBe('unknown');
  });

  test('a row with no placement time it can recover is unknown', () => {
    const verdict = auditRecord(
      record({ placedAt: undefined, analysisId: 'nonsense' }),
      [bar(0, 4303, 4298)]
    );
    expect(verdict.kind).toBe('unknown');
  });

  test('a row with no stop distance is unknown, not a guess', () => {
    expect(auditRecord(record({ context: undefined }), [bar(0, 4303, 4298)]).kind).toBe('unknown');
  });
});

describe('which rows are put back to the market at all', () => {
  test('only the ones the engine closed by itself', () => {
    const rows = [
      record({ id: 'a', autoResolved: true }),
      // The user's own testimony about their own terminal.
      record({ id: 'b', autoResolved: false }),
      // Already settled by an earlier audit.
      record({ id: 'c', autoResolved: true, audit: { at: 'x', verdict: 'genuine', confirmed: true } }),
    ];
    expect(auditableRecords(rows).map((r) => r.id)).toEqual(['a']);
  });
});

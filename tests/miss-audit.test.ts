import { describe, expect, test } from 'bun:test';
import { auditMiss, contradictsRecord, reconstructStop } from '../lib/miss-audit';
import type { Candle } from '../lib/candles';
import type { SelfLearningMemoryRecord } from '../lib/types';

const M15 = 15 * 60_000;
const START = Date.UTC(2026, 8, 17, 12, 0, 0);

function bar(index: number, high: number, low: number): Candle {
  return { time: START + index * M15, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100 };
}

/** A recorded miss on a buy limit at 4300 with a 100 pip (=$10) stop. */
function missRecord(overrides: Record<string, unknown> = {}): SelfLearningMemoryRecord {
  return {
    id: 'rec-1',
    analysisId: 'a-1',
    timestamp: new Date(START).toISOString(),
    outcome: 'MISSED',
    symbol: 'XAUUSD',
    orderType: 'BUY LIMIT',
    entryPrice: 4300,
    exitPrice: 4311,
    profitOrLossPips: 0,
    profitOrLossDollars: 0,
    rootCauseAnalysis: {
      primaryFactor: '',
      institutionalFlowExplanation: '',
      liquidityBehavior: '',
    },
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
    ...overrides,
  } as unknown as SelfLearningMemoryRecord;
}

describe('rebuilding the stop from what the record kept', () => {
  test('a buy is protected below its entry', () => {
    expect(reconstructStop(missRecord())).toBe(4290);
  });

  test('a sell is protected above it', () => {
    expect(reconstructStop(missRecord({ orderType: 'SELL LIMIT' }))).toBe(4310);
  });

  test('a record with no stop distance cannot be replayed', () => {
    const r = missRecord();
    expect(reconstructStop({ ...r, context: undefined })).toBeNull();
  });
});

describe('the miss that was not a miss', () => {
  test('an order that filled and ran in profit is reported as such', () => {
    const candles = [
      bar(0, 4306, 4302),
      bar(1, 4303, 4298), // fills at 4300
      bar(2, 4318, 4310), // runs well past
      bar(3, 4312, 4309), // drifts back to where the record was written
    ];
    const verdict = auditMiss(missRecord(), candles);
    expect(verdict.kind).toBe('filled-profitable');
    if (verdict.kind !== 'filled-profitable') throw new Error('expected a profitable fill');
    expect(verdict.bestPrice).toBe(4318);
    expect(verdict.runPips).toBe(180);
    // 18 dollars of run against 10 dollars of risk.
    expect(verdict.rMultiple).toBe(1.8);
    expect(contradictsRecord(verdict)).toBe(true);
  });

  test('an order that filled and was stopped out is a loss, not a miss', () => {
    const candles = [bar(0, 4306, 4302), bar(1, 4303, 4298), bar(2, 4302, 4288)];
    const verdict = auditMiss(missRecord(), candles);
    expect(verdict.kind).toBe('filled-stopped');
    expect(contradictsRecord(verdict)).toBe(true);
  });

  test('the stop is read before the run, so a bar holding both is a loss', () => {
    const candles = [bar(0, 4303, 4298), bar(1, 4330, 4289)];
    const verdict = auditMiss(missRecord(), candles);
    expect(verdict.kind).toBe('filled-stopped');
  });

  test('a fill that went nowhere is neither confirmed nor overturned', () => {
    const candles = [bar(0, 4301, 4298), bar(1, 4301, 4299)];
    const verdict = auditMiss(missRecord(), candles);
    expect(verdict.kind).toBe('filled-open');
  });

  test('a market order could never have been missed', () => {
    const candles = [bar(0, 4302, 4298), bar(1, 4318, 4305)];
    const verdict = auditMiss(missRecord({ orderType: 'BUY INSTANT' }), candles);
    expect(verdict.kind).toBe('filled-profitable');
  });
});

describe('the miss that was real, and keeps its lesson', () => {
  test('price never reaching the entry is confirmed genuine', () => {
    const candles = [bar(0, 4310, 4305), bar(1, 4315, 4308), bar(2, 4320, 4312)];
    const verdict = auditMiss(missRecord(), candles);
    expect(verdict.kind).toBe('genuine');
    if (verdict.kind !== 'genuine') throw new Error('expected a genuine miss');
    // The closest the market came: 4305 against a 4300 entry.
    expect(verdict.closestApproachPips).toBe(50);
    expect(contradictsRecord(verdict)).toBe(false);
  });

  test('a touch after the window closed is not a fill', () => {
    // An intraday order is live for eight hours; this touch is on the next day.
    const candles = [bar(0, 4310, 4305), bar(1, 4312, 4306), bar(200, 4303, 4298)];
    const verdict = auditMiss(missRecord(), candles);
    expect(verdict.kind).toBe('genuine');
  });

  test('a scalp closes its window sooner than an intraday order', () => {
    // Ninety minutes is six fifteen minute bars; the touch here is on the tenth.
    const candles = [bar(0, 4310, 4305), bar(10, 4303, 4298), bar(11, 4320, 4310)];
    expect(auditMiss(missRecord({ tradingStyle: 'Scalping' }), candles).kind).toBe('genuine');
    // The same path inside an intraday window is a fill.
    expect(auditMiss(missRecord({ tradingStyle: 'Intraday' }), candles).kind).toBe(
      'filled-profitable'
    );
  });

  test('the approach is measured from whichever side the order waited on', () => {
    // A buy stop sits above the market and waits for price to rise to it.
    const candles = [bar(0, 4295, 4290), bar(1, 4297, 4292)];
    const verdict = auditMiss(
      missRecord({ orderType: 'BUY STOP', entryPrice: 4300 }),
      candles
    );
    expect(verdict.kind).toBe('genuine');
    if (verdict.kind !== 'genuine') throw new Error('expected a genuine miss');
    // Closest was a 4297 high against a 4300 entry: three dollars, thirty pips.
    expect(verdict.closestApproachPips).toBe(30);
  });
});

describe('what it refuses to conclude', () => {
  test('history that does not reach the record is unknown', () => {
    const candles = [bar(0, 4306, 4302), bar(1, 4303, 4298)];
    const verdict = auditMiss(
      missRecord({ timestamp: new Date(START - 100 * M15).toISOString() }),
      candles
    );
    expect(verdict.kind).toBe('unknown');
    expect(contradictsRecord(verdict)).toBe(false);
  });

  test('no history at all is unknown', () => {
    expect(auditMiss(missRecord(), []).kind).toBe('unknown');
  });

  test('a record with no stop distance is unknown, not a guess', () => {
    const verdict = auditMiss(missRecord({ context: undefined }), [bar(0, 4303, 4298)]);
    expect(verdict.kind).toBe('unknown');
  });

  test('an unreadable timestamp is unknown', () => {
    expect(auditMiss(missRecord({ timestamp: 'nope' }), [bar(0, 4303, 4298)]).kind).toBe('unknown');
  });
});

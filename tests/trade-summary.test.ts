import { describe, expect, test } from 'bun:test';
import { resultOf, tradeSummaryText } from '../lib/trade-summary';
import type { SelfLearningMemoryRecord } from '../lib/types';

const record = (overrides: Partial<SelfLearningMemoryRecord>): SelfLearningMemoryRecord =>
  ({
    id: 'r1',
    analysisId: 'a1',
    timestamp: '2026-09-24T07:30:00.000Z',
    outcome: 'TP',
    symbol: 'XAUUSD',
    orderType: 'SELL LIMIT',
    entryPrice: 4280.2,
    exitPrice: 4253.85,
    profitOrLossPips: 263.5,
    profitOrLossDollars: 0.2635,
    context: { rMultiple: 1.46 },
    ...overrides,
  }) as unknown as SelfLearningMemoryRecord;

const settings = { tradingStyle: 'Intraday', minConviction: 0, protectStopAtR: 1, dailyLossLimit: 3 };

describe('the copied trade summary', () => {
  const text = tradeSummaryText(
    [
      record({}),
      record({ id: 'r2', timestamp: '2026-09-24T12:00:00.000Z', outcome: 'SL', exitPrice: 4298.85, profitOrLossDollars: -0.1865, context: { rMultiple: -1 } as never }),
      record({ id: 'r3', timestamp: '2026-09-25T02:00:00.000Z', outcome: 'SL', exitPrice: 4280.2, profitOrLossDollars: 0, context: { rMultiple: 0 } as never }),
      record({ id: 'r4', timestamp: '2026-09-25T03:00:00.000Z', outcome: 'MISSED', profitOrLossDollars: 0, context: undefined }),
      record({ id: 'bt_1_1', timestamp: '2026-01-01T00:00:00.000Z' }),
    ],
    { equity: 3.78, accountType: 'Cent', settings, now: Date.parse('2026-09-25T14:00:00.000Z') }
  );

  test('states the account and the settings the trades were taken under', () => {
    expect(text).toContain('Account: Cent - balance 378.00 Cent');
    expect(text).toContain('Settings: Intraday - conviction Take all - SL to entry at 1R - daily limit 3%');
  });

  test('counts a stop at the entry as a break-even, and leaves backtest trades out', () => {
    expect(text).toContain('Trades: 3 closed (TP 1 - SL 1 - BE 1) - 1 missed');
    expect(text).not.toContain('2026-01-01');
  });

  test('lists every trade in WIB, oldest first, in the account currency', () => {
    expect(text).toContain('1|2026-09-24 14:30|SMC|SELL LIMIT|4280.20|4253.85|TP|+26.35 Cent|+1.46');
    expect(text).toContain('3|2026-09-25 09:00|SMC|SELL LIMIT|4280.20|4280.20|BE|');
    expect(text).toContain('4|2026-09-25 10:00|SMC|SELL LIMIT|4280.20|-|MISSED|-|-');
  });

  test('a stop anywhere but the entry is a loss', () => {
    expect(resultOf(record({ outcome: 'SL', exitPrice: 4298.85 }))).toBe('SL');
  });
});

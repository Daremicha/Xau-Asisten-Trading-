import { describe, expect, test } from 'bun:test';
import {
  closedResults,
  dailyLossLimitReached,
  dailyLossNote,
  netToday,
  nextTradingDayStart,
  tradingDayStart,
} from '../lib/daily-loss';
import type { SelfLearningMemoryRecord } from '../lib/types';

const iso = (ms: number) => new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);

describe('the trading day', () => {
  test('starts at 17:00 New York: 21:00 UTC in summer, 22:00 UTC in winter', () => {
    expect(iso(tradingDayStart(at('2026-09-23T10:00:00Z')))).toBe('2026-09-22T21:00:00.000Z');
    expect(iso(tradingDayStart(at('2026-09-22T21:00:00Z')))).toBe('2026-09-22T21:00:00.000Z');
    expect(iso(tradingDayStart(at('2026-09-22T20:59:00Z')))).toBe('2026-09-21T21:00:00.000Z');
    expect(iso(tradingDayStart(at('2026-01-14T10:00:00Z')))).toBe('2026-01-13T22:00:00.000Z');
  });

  test('the next day follows, and the weekend is stepped over', () => {
    expect(iso(nextTradingDayStart(at('2026-09-23T10:00:00Z')))).toBe('2026-09-23T21:00:00.000Z');
    // Friday afternoon: nothing opens until Sunday evening.
    expect(iso(nextTradingDayStart(at('2026-09-25T15:00:00Z')))).toBe('2026-09-27T21:00:00.000Z');
    // Thursday evening's day ends at Friday's close, then the same.
    expect(iso(nextTradingDayStart(at('2026-09-24T23:00:00Z')))).toBe('2026-09-27T21:00:00.000Z');
  });
});

describe('the limit', () => {
  const now = at('2026-09-23T10:00:00Z');
  const closed = [
    { closedAt: at('2026-09-22T19:00:00Z'), net: -5 }, // yesterday's day
    { closedAt: at('2026-09-23T02:00:00Z'), net: -2 },
    { closedAt: at('2026-09-23T08:00:00Z'), net: 0.5 },
  ];

  test("counts only today's closed trades", () => {
    expect(netToday(closed, now)).toBeCloseTo(-1.5);
  });

  test("is measured against the balance the day started with", () => {
    // Started the day at 51.5, lost 1.5: 2.9%.
    expect(dailyLossLimitReached(-1.5, 50, 3)).toBe(false);
    expect(dailyLossLimitReached(-1.5, 50, 2)).toBe(true);
    expect(dailyLossLimitReached(-3, 97, 3)).toBe(true);
  });

  test('a winning day, or no limit, never stops trading', () => {
    expect(dailyLossLimitReached(2, 50, 3)).toBe(false);
    expect(dailyLossLimitReached(-40, 10, null)).toBe(false);
    expect(dailyLossLimitReached(-40, 10, 0)).toBe(false);
  });

  test('the note says how much was lost and when trading resumes', () => {
    const note = dailyLossNote(-3, 97, 3, at('2026-09-23T21:00:00Z'));
    expect(note).toContain('3.0%');
    expect(note).toContain('04:00 WIB');
  });

  test('missed orders are not losses', () => {
    const record = (outcome: SelfLearningMemoryRecord['outcome'], pnl: number) =>
      ({ outcome, profitOrLossDollars: pnl, timestamp: '2026-09-23T02:00:00.000Z' }) as SelfLearningMemoryRecord;
    expect(closedResults([record('SL', -2), record('MISSED', -9), record('TP', 1)]).map((r) => r.net)).toEqual([-2, 1]);
  });
});

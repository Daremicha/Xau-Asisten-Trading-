import { describe, expect, test } from 'bun:test';
import {
  byQuarter,
  expectancyInterval,
  MIN_INTERVAL_TRADES,
  monteCarloRiskReport,
  robustnessReport,
  stressed,
  type RResult,
} from '../lib/robustness';
import { liveVersusReplay } from '../lib/lessons';
import type { SelfLearningMemoryRecord } from '../lib/types';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 1);

/** Trades spread a day apart, cycling through the given results. */
function series(pattern: number[], count: number, riskDistance = 18): RResult[] {
  return Array.from({ length: count }, (_, i) => ({
    openedAt: START + i * DAY,
    rMultiple: pattern[i % pattern.length],
    riskDistance,
  }));
}

describe('the range around the average', () => {
  test('is not quoted for too few trades', () => {
    expect(expectancyInterval([1, -1, 1])).toBeNull();
  });

  test('brackets the average and is the same every time for the same trades', () => {
    const rs = series([1.5, -1, -1, 1.5, -1], 60).map((r) => r.rMultiple);
    const a = expectancyInterval(rs)!;
    const b = expectancyInterval(rs)!;
    expect(a).toEqual(b);
    expect(a.low).toBeLessThanOrEqual(a.mean);
    expect(a.high).toBeGreaterThanOrEqual(a.mean);
    expect(a.trades).toBe(60);
  });

  test('narrows as trades accumulate', () => {
    const pattern = [1.5, -1, -1, 1.5, -1];
    const few = expectancyInterval(series(pattern, 30).map((r) => r.rMultiple))!;
    const many = expectancyInterval(series(pattern, 600).map((r) => r.rMultiple))!;
    expect(many.high - many.low).toBeLessThan(few.high - few.low);
  });
});

describe('quarters', () => {
  test('group trades by calendar quarter, oldest first', () => {
    const rows = byQuarter(series([1], 200));
    expect(rows[0].label).toBe('2025 Q1');
    expect(rows[1].label).toBe('2025 Q2');
    expect(rows.reduce((a, q) => a + q.trades, 0)).toBe(200);
  });
});

describe('the cost stress', () => {
  test('takes the extra cost off each trade in proportion to its stop', () => {
    const [r] = stressed([{ openedAt: START, rMultiple: 1, riskDistance: 10 }], 0.5);
    expect(r).toBeCloseTo(0.95, 6);
  });

  test('leaves a trade with no known stop as it was', () => {
    expect(stressed([{ openedAt: START, rMultiple: 1 }], 0.5)).toEqual([1]);
  });
});

describe('the verdict', () => {
  test('a steady edge holds', () => {
    const report = robustnessReport(series([1.5, 1.5, -1, -1, 1.5, -1, 1.5], 400));
    expect(report.verdict).toBe('holds');
    expect(report.expectancy!.low).toBeGreaterThan(0);
  });

  test('a losing average fails', () => {
    expect(robustnessReport(series([1, -1, -1], 100)).verdict).toBe('fails');
  });

  test('a thin edge that costs could erase is fragile', () => {
    // +0.02R a trade on an $18 stop: $0.30 of extra cost is 0.017R.
    const report = robustnessReport(series([1.04, -1], 40));
    expect(report.verdict).toBe('fragile');
  });

  test('too few trades is said plainly', () => {
    expect(robustnessReport(series([1], MIN_INTERVAL_TRADES - 1)).verdict).toBe('insufficient');
  });
});

describe('Monte Carlo sequence risk', () => {
  test('is deterministic and reports drawdown and losing-streak percentiles', () => {
    const rs = series([1.5, -1, -1, 1.5, -1], 60).map((r) => r.rMultiple);
    const first = monteCarloRiskReport(rs, { simulations: 200, riskPerTradePercent: 0.5 });
    const second = monteCarloRiskReport(rs, { simulations: 200, riskPerTradePercent: 0.5 });

    expect(first).not.toBeNull();
    expect(first).toEqual(second);
    expect(first!.simulations).toBe(200);
    expect(first!.trades).toBe(60);
    expect(first!.maxDrawdownPercent.p95).toBeGreaterThanOrEqual(first!.maxDrawdownPercent.median);
    expect(first!.losingStreak.p95).toBeGreaterThanOrEqual(first!.losingStreak.median);
    expect(first!.probabilityOfRuinPercent).toBeGreaterThanOrEqual(0);
    expect(first!.probabilityOfRuinPercent).toBeLessThanOrEqual(100);
  });

  test('waits for enough trades before making a sequence-risk claim', () => {
    expect(monteCarloRiskReport(Array.from({ length: MIN_INTERVAL_TRADES - 1 }, () => 1))).toBeNull();
  });
});

function record(i: number, r: number): SelfLearningMemoryRecord {
  return {
    id: `live-${i}`,
    analysisId: `a-${i}`,
    timestamp: new Date(START + i * DAY).toISOString(),
    outcome: r > 0 ? 'TP' : 'SL',
    context: { rMultiple: r },
  } as unknown as SelfLearningMemoryRecord;
}

describe('live trades against the replay', () => {
  test('waits for enough trades before comparing', () => {
    const lesson = liveVersusReplay([record(0, 1), record(1, -1)]);
    expect(lesson.tone).toBe('info');
    expect(lesson.detail).toContain(`${MIN_INTERVAL_TRADES}`);
  });

  test('a short run near break-even is still within chance of the replay', () => {
    const rows = Array.from({ length: 35 }, (_, i) => record(i, i % 2 === 0 ? 1 : -1));
    expect(liveVersusReplay(rows).title).toContain('sejalan dengan backtest');
  });

  test('a long run clearly under the replay is called out', () => {
    const rows = Array.from({ length: 300 }, (_, i) => record(i, i % 3 === 0 ? 1 : -1));
    const lesson = liveVersusReplay(rows);
    expect(lesson.tone).toBe('bad');
    expect(lesson.title).toContain('lebih buruk daripada backtest');
  });

  test('replayed rows are not counted as live trades', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ ...record(i, -1), id: `bt_${i}` }));
    expect(liveVersusReplay(rows).title).toContain('0 trade tertutup');
  });
});

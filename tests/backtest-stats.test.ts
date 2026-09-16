import { describe, expect, test } from 'bun:test';
import {
  comparePhases,
  compareRuns,
  rollingWinRate,
  summariseTrades,
} from '../lib/backtest-stats';
import type { BacktestResult, BacktestTrade } from '../lib/backtest-engine';

function trade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    sequence: 1,
    openedAt: 0,
    closedAt: 3_600_000,
    orderType: 'BUY LIMIT',
    direction: 'long',
    entryPrice: 2000,
    fillPrice: 2000,
    stopLoss: 1990,
    takeProfit1: 2015,
    filled: true,
    outcome: 'TP',
    exitPrice: 2015,
    reason: 'The first target was reached.',
    lotSize: 0.1,
    grossDollars: 150,
    costDollars: 18,
    netDollars: 132,
    pips: 150,
    rMultiple: 1.3,
    equityAfter: 5132,
    confidenceScore: 60,
    holdingHours: 1,
    ...overrides,
  };
}

const win = (net: number) => trade({ outcome: 'TP', netDollars: net, rMultiple: net / 100 });
const loss = (net: number) => trade({ outcome: 'SL', netDollars: net, rMultiple: net / 100 });
const miss = () =>
  trade({ filled: false, outcome: 'MISSED', netDollars: 0, pips: 0, rMultiple: 0, costDollars: 0, grossDollars: 0 });

describe('trade statistics', () => {
  test('an empty run reports nothing rather than zero percent', () => {
    const stats = summariseTrades([], 5000);
    expect(stats.winRate).toBeNull();
    expect(stats.expectancyDollars).toBeNull();
    expect(stats.profitFactor).toBeNull();
    expect(stats.finalEquity).toBe(5000);
  });

  test('win rate counts filled trades only', () => {
    const stats = summariseTrades([win(100), loss(-50), miss(), miss()], 5000);
    expect(stats.totalSignals).toBe(4);
    expect(stats.filled).toBe(2);
    expect(stats.winRate).toBe(50);
    expect(stats.missRate).toBe(50);
  });

  test('profit factor is gross profit over gross loss', () => {
    const stats = summariseTrades([win(200), loss(-100), win(100), loss(-100)], 5000);
    expect(stats.profitFactor).toBe(1.5);
    expect(stats.netDollars).toBe(100);
    expect(stats.returnPercent).toBe(2);
    expect(stats.expectancyDollars).toBe(25);
  });

  test('drawdown is measured from the running peak', () => {
    const stats = summariseTrades([win(500), loss(-250), loss(-250), win(100)], 5000);
    // Peak 5500, trough 5000, so the worst drawdown is 500 of 5500.
    expect(stats.maxDrawdownPercent).toBe(9.1);
    expect(stats.worstLosingStreak).toBe(2);
  });

  test('a run with no losses has no profit factor to report', () => {
    const stats = summariseTrades([win(50), win(70)], 5000);
    expect(stats.profitFactor).toBeNull();
    expect(stats.wins).toBe(2);
  });
});

function result(trades: BacktestTrade[], startingEquity = 5000): BacktestResult {
  return {
    summary: {
      from: 0,
      to: 1,
      bars: 100,
      intervalMs: 900_000,
      tradingStyle: 'Intraday',
      accountType: 'Standard',
      brokerId: 'EXNESS',
      startingEquity,
      riskPercentage: 1,
      adaptive: true,
      skipped: 0,
    },
    trades,
    equityCurve: [],
    finalWeights: {
      orderBlockWeight: 0.28,
      fairValueGapWeight: 0.24,
      liquiditySweepWeight: 0.22,
      newsImpactWeight: 0.14,
      indicatorConfluenceWeight: 0.12,
      atrBufferFactor: 1.25,
      totalAnalysesLearned: trades.length,
      historicalWinRate: 0,
    },
    records: [],
  };
}

describe('did the later trades go better', () => {
  test('a thin sample refuses to draw a conclusion', () => {
    const comparison = comparePhases(result([win(100), loss(-50), win(80), loss(-40)]));
    expect(comparison.verdict).toBe('insufficient');
    expect(comparison.explanation).toContain('Too few');
  });

  test('a better second half is reported as an improvement', () => {
    const early = Array.from({ length: 12 }, () => loss(-100));
    const late = Array.from({ length: 12 }, () => win(150));
    const comparison = comparePhases(result([...early, ...late]));
    expect(comparison.verdict).toBe('improved');
    expect(comparison.expectancyDelta).toBe(250);
    expect(comparison.winRateDelta).toBe(100);
  });

  test('a worse second half is not dressed up', () => {
    const early = Array.from({ length: 12 }, () => win(150));
    const late = Array.from({ length: 12 }, () => loss(-100));
    const comparison = comparePhases(result([...early, ...late]));
    expect(comparison.verdict).toBe('declined');
    expect(comparison.explanation).toContain('did not help');
  });
});

describe('learning against a control', () => {
  const control = result(Array.from({ length: 20 }, () => loss(-40)));

  test('an adaptive run that earned more is called better', () => {
    const adaptive = result(Array.from({ length: 20 }, () => win(60)));
    const comparison = compareRuns(control, adaptive);
    expect(comparison.verdict).toBe('better');
    expect(comparison.netDelta).toBe(2000);
    expect(comparison.winRateDelta).toBe(100);
  });

  test('an adaptive run that earned less is called worse', () => {
    const adaptive = result(Array.from({ length: 20 }, () => loss(-90)));
    const comparison = compareRuns(control, adaptive);
    expect(comparison.verdict).toBe('worse');
    expect(comparison.explanation).toContain('did not pay');
  });

  test('a difference smaller than a tenth of a percent is called noise', () => {
    const adaptive = result([...Array.from({ length: 19 }, () => loss(-40)), loss(-40.5)]);
    const comparison = compareRuns(control, adaptive);
    expect(comparison.verdict).toBe('same');
  });
});

describe('learning curve', () => {
  test('the rolling win rate follows the sequence', () => {
    const trades = [
      ...Array.from({ length: 5 }, () => loss(-50)),
      ...Array.from({ length: 5 }, () => win(50)),
    ].map((t, i) => ({ ...t, sequence: i + 1 }));

    const curve = rollingWinRate(trades, 5);
    expect(curve[0]).toEqual({ sequence: 5, winRate: 0 });
    expect(curve.at(-1)).toEqual({ sequence: 10, winRate: 100 });
  });

  test('a run shorter than the window produces no points rather than a fake one', () => {
    expect(rollingWinRate([win(10), loss(-10)], 20)).toHaveLength(0);
  });
});

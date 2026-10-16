import { describe, expect, test } from 'bun:test';
import { assessDeploymentGate } from '../lib/deployment-gate';
import type { BacktestStats } from '../lib/backtest-stats';

function stats(overrides: Partial<BacktestStats> = {}): BacktestStats {
  return {
    totalSignals: 400,
    filled: 350,
    missed: 50,
    wins: 180,
    losses: 170,
    winRate: 51.4,
    missRate: 12.5,
    netDollars: 1000,
    returnPercent: 10,
    profitFactor: 1.2,
    expectancyDollars: 2.85,
    expectancyR: 0.12,
    maxDrawdownPercent: 20,
    worstLosingStreak: 10,
    averageHoldingHours: 8,
    finalEquity: 11000,
    ...overrides,
  };
}

const goodInput = {
  coverage: { complete: true, provider: 'Twelve Data (XAU/USD spot)' },
  frozenStats: stats(),
  folds: [{ frozenStats: stats() }, { frozenStats: stats({ filled: 320 }) }],
  realisticProfitable: true,
  stressProfitable: true,
};

describe('deployment gate', () => {
  test('allows only a sufficiently large complete spot OOS result', () => {
    const result = assessDeploymentGate(goodInput);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('minimal 300 trade OOS');
  });

  test('rejects incomplete futures data and thin evidence', () => {
    const result = assessDeploymentGate({
      ...goodInput,
      coverage: { complete: false, provider: 'Yahoo Finance (GC=F gold futures)' },
      frozenStats: stats({ filled: 80, profitFactor: 1.05, expectancyR: -0.01 }),
      folds: [{ frozenStats: stats({ expectancyR: -0.01 }) }],
      realisticProfitable: false,
      stressProfitable: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('provider bukan data spot');
    expect(result.reason).toContain('trade test belum mencapai 300');
    expect(result.reason).toContain('stress cost ekstrem tidak profitable');
  });
});

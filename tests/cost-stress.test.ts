import { describe, expect, test } from 'bun:test';
import { stressCost, stressTrade, type CostScenario } from '../lib/cost-stress';
import type { BacktestTrade } from '../lib/backtest-engine';
import type { ForexFactoryEvent } from '../lib/types';

const scenario: CostScenario = {
  id: 'test',
  label: 'Test',
  extraSpreadDollars: 0.1,
  extraSlippageDollars: 0,
  swapDollarsPerLotDay: 0,
  newsSlippageDollars: 0,
  newsWindowMinutes: 30,
};

function trade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    sequence: 1,
    openedAt: Date.parse('2026-01-01T10:00:00Z'),
    closedAt: Date.parse('2026-01-01T12:00:00Z'),
    orderType: 'BUY INSTANT',
    direction: 'long',
    entryPrice: 2000,
    fillPrice: 2000,
    stopLoss: 1999,
    takeProfit1: 2002,
    filled: true,
    outcome: 'TP',
    exitPrice: 2002,
    reason: 'test',
    lotSize: 1,
    grossDollars: 200,
    costDollars: 0,
    netDollars: 200,
    pips: 20,
    rMultiple: 2,
    equityAfter: 1200,
    confidenceScore: 70,
    convictionScore: 70,
    holdingHours: 2,
    riskBudgetDollars: 100,
    actualRiskDollars: 100,
    minimumLotForced: false,
    ...overrides,
  };
}

const news: ForexFactoryEvent = {
  id: 'n1',
  title: 'CPI',
  country: 'United States',
  currency: 'USD',
  impact: 'High',
  time: '10:00',
  date: '2026-01-01',
  scheduledTimestamp: '2026-01-01T10:15:00Z',
  forecast: '',
  previous: '',
  marketImplication: 'test',
};

describe('cost stress', () => {
  test('baseline scenario preserves replay result exactly', () => {
    const result = stressTrade(trade(), {
      id: 'baseline',
      label: 'Baseline',
      extraSpreadDollars: 0,
      extraSlippageDollars: 0,
      swapDollarsPerLotDay: 0,
      newsSlippageDollars: 0,
      newsWindowMinutes: 30,
    });
    expect(result.netDollars).toBe(200);
    expect(result.extraCostDollars).toBe(0);
  });

  test('price cost scales with risk distance', () => {
    const closeStop = stressTrade(trade(), scenario);
    const wideStop = stressTrade(trade({ stopLoss: 1998 }), scenario);
    expect(closeStop.extraCostDollars).toBe(10);
    expect(wideStop.extraCostDollars).toBe(5);
  });

  test('swap scales with holding days and lot size', () => {
    const result = stressTrade(
      trade({ holdingHours: 48, lotSize: 2 }),
      { ...scenario, extraSpreadDollars: 0, swapDollarsPerLotDay: 0.03 }
    );
    expect(result.extraCostDollars).toBe(0.12);
  });

  test('news surcharge applies only near high-impact USD release', () => {
    const near = stressTrade(
      trade(),
      { ...scenario, extraSpreadDollars: 0, newsSlippageDollars: 0.2 },
      [news]
    );
    const far = stressTrade(
      trade({ openedAt: Date.parse('2026-01-01T14:00:00Z'), closedAt: Date.parse('2026-01-01T15:00:00Z') }),
      { ...scenario, extraSpreadDollars: 0, newsSlippageDollars: 0.2 },
      [news]
    );
    expect(near.extraCostDollars).toBe(20);
    expect(far.extraCostDollars).toBe(0);
  });

  test('aggregate report computes adjusted profit factor and drawdown', () => {
    const result = stressCost(
      [trade(), trade({ sequence: 2, netDollars: -80, rMultiple: -0.8, openedAt: 2, closedAt: 3 })],
      1000,
      { ...scenario, extraSpreadDollars: 0 }
    );
    expect(result.trades).toBe(2);
    expect(result.netDollars).toBe(120);
    expect(result.profitFactor).toBe(2.5);
    expect(result.maxDrawdownPercent).toBe(6.7);
    expect(result.profitable).toBe(true);
  });
});

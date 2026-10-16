import type { BacktestTrade } from './backtest-engine';
import { roundMoney } from './trade-result';
import type { ForexFactoryEvent } from './types';

export interface CostScenario {
  id: string;
  label: string;
  /** Extra price cost per filled trade, beyond baseline replay costs. */
  extraSpreadDollars: number;
  extraSlippageDollars: number;
  /** Extra USD cost per lot per 24 hours held. */
  swapDollarsPerLotDay: number;
  /** Extra price cost when entry or exit is near a high-impact USD release. */
  newsSlippageDollars: number;
  newsWindowMinutes: number;
}

export interface CostStressReport {
  scenario: CostScenario;
  trades: number;
  adjustedTrades: number;
  netDollars: number;
  averageR: number | null;
  profitFactor: number | null;
  maxDrawdownPercent: number;
  profitable: boolean;
}

/** Scenario values are assumptions, not broker-historical observations. */
export const DEFAULT_COST_SCENARIOS: CostScenario[] = [
  {
    id: 'baseline',
    label: 'Baseline replay',
    extraSpreadDollars: 0,
    extraSlippageDollars: 0,
    swapDollarsPerLotDay: 0,
    newsSlippageDollars: 0,
    newsWindowMinutes: 30,
  },
  {
    id: 'realistic-extra-cost',
    label: 'Realistis: biaya ekstra',
    extraSpreadDollars: 0.05,
    extraSlippageDollars: 0.1,
    swapDollarsPerLotDay: 0.03,
    newsSlippageDollars: 0.2,
    newsWindowMinutes: 30,
  },
  {
    id: 'stress-extra-cost',
    label: 'Stress: spread dan news melebar',
    extraSpreadDollars: 0.15,
    extraSlippageDollars: 0.3,
    swapDollarsPerLotDay: 0.08,
    newsSlippageDollars: 0.5,
    newsWindowMinutes: 60,
  },
];

function round(value: number, places = 3): number {
  return parseFloat(value.toFixed(places));
}

function highImpactNewsNear(
  trade: Pick<BacktestTrade, 'openedAt' | 'closedAt'>,
  events: ForexFactoryEvent[],
  windowMinutes: number
): boolean {
  const windowMs = Math.max(0, windowMinutes) * 60_000;
  return events.some((event) => {
    if (event.currency !== 'USD' || event.impact !== 'High') return false;
    const release = Date.parse(event.scheduledTimestamp);
    if (!Number.isFinite(release)) return false;
    return Math.abs(release - trade.openedAt) <= windowMs || Math.abs(release - trade.closedAt) <= windowMs;
  });
}

export function extraCostDollars(
  trade: Pick<BacktestTrade, 'filled' | 'fillPrice' | 'stopLoss' | 'actualRiskDollars' | 'lotSize' | 'holdingHours' | 'openedAt' | 'closedAt'>,
  scenario: CostScenario,
  events: ForexFactoryEvent[] = []
): number {
  if (!trade.filled || trade.actualRiskDollars <= 0) return 0;
  const riskDistance = Math.abs(trade.fillPrice - trade.stopLoss);
  if (riskDistance <= 0) return 0;

  const priceCost = scenario.extraSpreadDollars + scenario.extraSlippageDollars;
  const newsCost = highImpactNewsNear(trade, events, scenario.newsWindowMinutes)
    ? scenario.newsSlippageDollars
    : 0;
  const extraPriceDollars = ((priceCost + newsCost) / riskDistance) * trade.actualRiskDollars;
  const holdingDays = Math.max(0, trade.holdingHours) / 24;
  const swapDollars = holdingDays * Math.max(0, scenario.swapDollarsPerLotDay) * Math.max(0, trade.lotSize);
  return roundMoney(Math.max(0, extraPriceDollars + swapDollars));
}

export function stressTrade(
  trade: BacktestTrade,
  scenario: CostScenario,
  events: ForexFactoryEvent[] = []
): { netDollars: number; rMultiple: number; extraCostDollars: number } {
  const extra = extraCostDollars(trade, scenario, events);
  const netDollars = roundMoney(trade.netDollars - extra);
  const rMultiple = trade.actualRiskDollars > 0 ? netDollars / trade.actualRiskDollars : trade.rMultiple;
  return { netDollars, rMultiple: round(rMultiple), extraCostDollars: extra };
}

export function stressCost(
  trades: BacktestTrade[],
  startingEquity: number,
  scenario: CostScenario,
  events: ForexFactoryEvent[] = []
): CostStressReport {
  const filled = trades.filter((trade) => trade.filled);
  const adjusted = filled.map((trade) => stressTrade(trade, scenario, events));
  const netDollars = roundMoney(adjusted.reduce((sum, trade) => sum + trade.netDollars, 0));
  const grossProfit = adjusted.filter((trade) => trade.netDollars > 0).reduce((sum, trade) => sum + trade.netDollars, 0);
  const grossLoss = Math.abs(adjusted.filter((trade) => trade.netDollars < 0).reduce((sum, trade) => sum + trade.netDollars, 0));

  let equity = startingEquity;
  let peak = startingEquity;
  let maxDrawdownPercent = 0;
  for (const trade of adjusted) {
    equity += trade.netDollars;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - equity) / peak) * 100);
  }

  return {
    scenario,
    trades: filled.length,
    adjustedTrades: adjusted.filter((trade) => trade.extraCostDollars > 0).length,
    netDollars,
    averageR: adjusted.length ? round(adjusted.reduce((sum, trade) => sum + trade.rMultiple, 0) / adjusted.length) : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 2) : null,
    maxDrawdownPercent: round(maxDrawdownPercent, 1),
    profitable: netDollars > 0,
  };
}

export function stressCostScenarios(
  trades: BacktestTrade[],
  startingEquity: number,
  scenarios: CostScenario[] = DEFAULT_COST_SCENARIOS,
  events: ForexFactoryEvent[] = []
): CostStressReport[] {
  return scenarios.map((scenario) => stressCost(trades, startingEquity, scenario, events));
}

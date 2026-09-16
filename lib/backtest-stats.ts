/**
 * What a replay actually proved.
 *
 * A backtest is only worth reading if it answers two questions honestly: did
 * this edge make money over the period, and did learning from the results make
 * the later trades better than the earlier ones. Everything here is derived
 * from the closed trades; nothing is assumed.
 */

import { BacktestResult, BacktestTrade } from './backtest-engine';
import { roundMoney } from './trade-result';

export interface BacktestStats {
  /** Orders the engine produced, filled or not. */
  totalSignals: number;
  /** Orders that actually filled. */
  filled: number;
  missed: number;
  wins: number;
  losses: number;
  /** Wins over filled trades, or null when nothing filled. */
  winRate: number | null;
  /** Share of orders that never filled. */
  missRate: number | null;
  netDollars: number;
  returnPercent: number;
  /** Gross profit divided by gross loss. Null when there were no losses. */
  profitFactor: number | null;
  /** Average result per filled trade, in dollars. */
  expectancyDollars: number | null;
  /** Average result per filled trade as a multiple of risk. */
  expectancyR: number | null;
  maxDrawdownPercent: number;
  /** Longest run of losing trades, which is what actually breaks an account. */
  worstLosingStreak: number;
  averageHoldingHours: number | null;
  finalEquity: number;
}

function round(value: number, places = 2): number {
  return parseFloat(value.toFixed(places));
}

/**
 * Percentages and ratios round to two places; money does not. Two decimals of
 * a dollar is a whole unit on a cent account, which is how an average of 0.45
 * cent a trade came to be displayed as zero.
 */
const money = roundMoney;

export function summariseTrades(trades: BacktestTrade[], startingEquity: number): BacktestStats {
  const filled = trades.filter((t) => t.filled);
  const missed = trades.length - filled.length;
  const wins = filled.filter((t) => t.netDollars > 0);
  const losses = filled.filter((t) => t.netDollars <= 0);

  const grossProfit = wins.reduce((acc, t) => acc + t.netDollars, 0);
  const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.netDollars, 0));
  const net = filled.reduce((acc, t) => acc + t.netDollars, 0);

  let peak = startingEquity;
  let maxDd = 0;
  let equity = startingEquity;
  let streak = 0;
  let worstStreak = 0;

  for (const trade of trades) {
    if (trade.filled) {
      equity += trade.netDollars;
      if (equity > peak) peak = equity;
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
      if (trade.netDollars <= 0) {
        streak += 1;
        worstStreak = Math.max(worstStreak, streak);
      } else {
        streak = 0;
      }
    }
  }

  const holdSum = filled.reduce((acc, t) => acc + t.holdingHours, 0);

  return {
    totalSignals: trades.length,
    filled: filled.length,
    missed,
    wins: wins.length,
    losses: losses.length,
    winRate: filled.length ? round((wins.length / filled.length) * 100, 1) : null,
    missRate: trades.length ? round((missed / trades.length) * 100, 1) : null,
    netDollars: money(net),
    returnPercent: startingEquity > 0 ? round((net / startingEquity) * 100, 2) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    expectancyDollars: filled.length ? money(net / filled.length) : null,
    expectancyR: filled.length
      ? round(filled.reduce((acc, t) => acc + t.rMultiple, 0) / filled.length)
      : null,
    maxDrawdownPercent: round(maxDd, 1),
    worstLosingStreak: worstStreak,
    averageHoldingHours: filled.length ? round(holdSum / filled.length, 1) : null,
    finalEquity: money(startingEquity + net),
  };
}

export interface PhaseComparison {
  /** Trades in each half, so a tiny sample is visible rather than hidden. */
  firstHalf: BacktestStats;
  secondHalf: BacktestStats;
  /** Change in win rate, in percentage points. Null when a half had no fills. */
  winRateDelta: number | null;
  /** Change in expectancy per filled trade, in dollars. */
  expectancyDelta: number | null;
  /** Plain reading of whether the later trades were better. */
  verdict: 'improved' | 'unchanged' | 'declined' | 'insufficient';
  explanation: string;
}

/** Splits a run down the middle to show whether the later half traded better. */
export function comparePhases(result: BacktestResult): PhaseComparison {
  const { trades, summary } = result;
  const midpoint = Math.floor(trades.length / 2);
  const first = trades.slice(0, midpoint);
  const second = trades.slice(midpoint);

  const firstStats = summariseTrades(first, summary.startingEquity);
  const secondStats = summariseTrades(second, firstStats.finalEquity);

  const winRateDelta =
    firstStats.winRate !== null && secondStats.winRate !== null
      ? round(secondStats.winRate - firstStats.winRate, 1)
      : null;
  const expectancyDelta =
    firstStats.expectancyDollars !== null && secondStats.expectancyDollars !== null
      ? money(secondStats.expectancyDollars - firstStats.expectancyDollars)
      : null;

  // Ten filled trades a side is the least that can support any statement at
  // all, and even that is thin. Below it the honest answer is "not enough".
  if (firstStats.filled < 10 || secondStats.filled < 10 || expectancyDelta === null) {
    return {
      firstHalf: firstStats,
      secondHalf: secondStats,
      winRateDelta,
      expectancyDelta,
      verdict: 'insufficient',
      explanation:
        'Too few filled trades in one half of the period to say whether learning changed anything.',
    };
  }

  const improved = expectancyDelta > 0.01 * Math.max(1, Math.abs(firstStats.expectancyDollars ?? 1));
  const declined = expectancyDelta < -0.01 * Math.max(1, Math.abs(firstStats.expectancyDollars ?? 1));

  return {
    firstHalf: firstStats,
    secondHalf: secondStats,
    winRateDelta,
    expectancyDelta,
    verdict: improved ? 'improved' : declined ? 'declined' : 'unchanged',
    explanation: improved
      ? `The second half earned ${expectancyDelta > 0 ? '+' : ''}$${expectancyDelta} more per trade than the first.`
      : declined
      ? `The second half earned $${Math.abs(expectancyDelta)} less per trade than the first, so learning did not help over this period.`
      : 'The two halves traded about the same, so learning made no measurable difference here.',
  };
}

export interface LearningComparison {
  control: BacktestStats;
  adaptive: BacktestStats;
  /** Difference in net result, adaptive minus control. */
  netDelta: number;
  winRateDelta: number | null;
  expectancyDelta: number | null;
  verdict: 'better' | 'same' | 'worse';
  explanation: string;
}

/**
 * The comparison the whole exercise exists for: the same period traded twice,
 * once on the engine's starting parameters and once with the learning engine
 * updating after every closed trade.
 */
export function compareRuns(control: BacktestResult, adaptive: BacktestResult): LearningComparison {
  const controlStats = summariseTrades(control.trades, control.summary.startingEquity);
  const adaptiveStats = summariseTrades(adaptive.trades, adaptive.summary.startingEquity);

  const netDelta = money(adaptiveStats.netDollars - controlStats.netDollars);
  const winRateDelta =
    controlStats.winRate !== null && adaptiveStats.winRate !== null
      ? round(adaptiveStats.winRate - controlStats.winRate, 1)
      : null;
  const expectancyDelta =
    controlStats.expectancyDollars !== null && adaptiveStats.expectancyDollars !== null
      ? money(adaptiveStats.expectancyDollars - controlStats.expectancyDollars)
      : null;

  // A difference smaller than a tenth of a percent of the starting balance is
  // noise, not a finding.
  const threshold = Math.max(0.01, control.summary.startingEquity * 0.001);
  const verdict: LearningComparison['verdict'] =
    netDelta > threshold ? 'better' : netDelta < -threshold ? 'worse' : 'same';

  return {
    control: controlStats,
    adaptive: adaptiveStats,
    netDelta,
    winRateDelta,
    expectancyDelta,
    verdict,
    explanation:
      verdict === 'better'
        ? `Learning from each result earned $${netDelta} more over the same candles than running on fixed parameters.`
        : verdict === 'worse'
        ? `Learning from each result earned $${Math.abs(netDelta)} less than running on fixed parameters over this period, so the adaptation did not pay here.`
        : 'Both runs finished within noise of each other, so learning neither helped nor hurt over this period.',
  };
}

/** Rolling win rate over the trade sequence, for the learning curve chart. */
export function rollingWinRate(trades: BacktestTrade[], window = 20): Array<{ sequence: number; winRate: number }> {
  const filled = trades.filter((t) => t.filled);
  const points: Array<{ sequence: number; winRate: number }> = [];
  for (let i = window - 1; i < filled.length; i++) {
    const slice = filled.slice(i - window + 1, i + 1);
    const wins = slice.filter((t) => t.netDollars > 0).length;
    points.push({ sequence: filled[i].sequence, winRate: round((wins / window) * 100, 1) });
  }
  return points;
}

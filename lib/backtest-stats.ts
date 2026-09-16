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
import { formatAccountMoney } from './account-display';

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
      ? `The second half earned ${formatAccountMoney(expectancyDelta, summary.accountType, {
          signed: true,
        })} more per trade than the first.`
      : declined
      ? `The second half earned ${formatAccountMoney(
          Math.abs(expectancyDelta),
          summary.accountType
        )} less per trade than the first, so the later signals were not the better ones.`
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

/** Wording that changes with what is being compared against the control. */
interface ComparisonPhrasing {
  better: (amount: string) => string;
  worse: (amount: string) => string;
  same: string;
}

const LEARNING_PHRASING: ComparisonPhrasing = {
  better: (amount) =>
    `Learning from each result earned ${amount} more over the same candles than running on fixed parameters.`,
  worse: (amount) =>
    `Learning from each result earned ${amount} less than running on fixed parameters over this period, so the adaptation did not pay here.`,
  same: 'Both runs finished within noise of each other, so learning neither helped nor hurt over this period.',
};

const ADOPTION_PHRASING: ComparisonPhrasing = {
  better: (amount) =>
    `Held fixed from the start, the learned parameters earned ${amount} more than the engine defaults over the same candles.`,
  worse: (amount) =>
    `Held fixed from the start, the learned parameters earned ${amount} less than the engine defaults, so adopting them would have cost money over this period.`,
  same: 'Held fixed from the start, the learned parameters finished within noise of the engine defaults, so adopting them changes little.',
};

/**
 * The comparison the whole exercise exists for: the same period traded twice,
 * once on the engine's starting parameters and once with the learning engine
 * updating after every closed trade.
 */
export function compareRuns(control: BacktestResult, adaptive: BacktestResult): LearningComparison {
  return compareAgainstControl(control, adaptive, LEARNING_PHRASING);
}

/**
 * What adopting the learned parameters would actually have done.
 *
 * The learning run's final weights are the end of a path, not a configuration
 * that was ever traded as such. Freezing them from the first candle and
 * replaying the same period is the only honest test of the adopt button, and
 * this compares that run against the defaults.
 */
export function compareAdoption(control: BacktestResult, frozen: BacktestResult): LearningComparison {
  return compareAgainstControl(control, frozen, ADOPTION_PHRASING);
}

function compareAgainstControl(
  control: BacktestResult,
  adaptive: BacktestResult,
  phrasing: ComparisonPhrasing
): LearningComparison {
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
        ? phrasing.better(formatAccountMoney(netDelta, control.summary.accountType))
        : verdict === 'worse'
        ? phrasing.worse(formatAccountMoney(Math.abs(netDelta), control.summary.accountType))
        : phrasing.same,
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

/** Conviction bands, chosen to match the Low / Moderate / High labels. */
export const CONVICTION_BANDS: Array<{ label: string; min: number; max: number }> = [
  { label: 'Below 40', min: 0, max: 40 },
  { label: '40 to 54', min: 40, max: 55 },
  { label: '55 to 69', min: 55, max: 70 },
  { label: '70 and above', min: 70, max: 101 },
];

export interface ConvictionBucket {
  label: string;
  min: number;
  signals: number;
  filled: number;
  winRate: number | null;
  netDollars: number;
  expectancyDollars: number | null;
}

/**
 * Splits the run by the conviction each setup scored when it was taken.
 *
 * This is the cheapest honest answer to "should the engine trade less": the
 * trades already happened, so grouping them by the score they had at entry
 * shows exactly which bands paid for themselves and which ones funded the
 * losses, without replaying anything.
 */
export function convictionBreakdown(trades: BacktestTrade[]): ConvictionBucket[] {
  return CONVICTION_BANDS.map((band) => {
    const inBand = trades.filter(
      (t) => t.convictionScore >= band.min && t.convictionScore < band.max
    );
    const filled = inBand.filter((t) => t.filled);
    const wins = filled.filter((t) => t.netDollars > 0).length;
    const net = filled.reduce((acc, t) => acc + t.netDollars, 0);

    return {
      label: band.label,
      min: band.min,
      signals: inBand.length,
      filled: filled.length,
      winRate: filled.length ? round((wins / filled.length) * 100, 1) : null,
      netDollars: money(net),
      expectancyDollars: filled.length ? money(net / filled.length) : null,
    };
  });
}

/**
 * What the run would have earned had it refused everything below a threshold.
 *
 * Trades are independent of each other in this engine, so dropping the weak
 * ones is a sum over what is left. Compounding would differ slightly, which is
 * why this is reported as evidence for choosing a floor rather than as a second
 * backtest result.
 */
export function netAboveThreshold(trades: BacktestTrade[], threshold: number): number {
  return money(
    trades
      .filter((t) => t.filled && t.convictionScore >= threshold)
      .reduce((acc, t) => acc + t.netDollars, 0)
  );
}

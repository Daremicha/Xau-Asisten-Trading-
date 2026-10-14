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
import { matchesDefaultPrior } from './learning-engine';

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
        'Trade terisi di salah satu paruh periode terlalu sedikit untuk menilai apakah belajar mengubah sesuatu.',
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
      ? `Paruh kedua menghasilkan ${formatAccountMoney(expectancyDelta, summary.accountType, {
          signed: true,
        })} lebih banyak per trade daripada paruh pertama.`
      : declined
      ? `Paruh kedua menghasilkan ${formatAccountMoney(
          Math.abs(expectancyDelta),
          summary.accountType
        )} lebih sedikit per trade daripada paruh pertama, jadi sinyal belakangan tidak lebih baik.`
      : 'Kedua paruh hasilnya hampir sama, jadi belajar tidak membuat perbedaan yang terukur di sini.',
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
        ? `Belajar dari setiap hasil menghasilkan ${formatAccountMoney(
            netDelta,
            control.summary.accountType
          )} lebih banyak di candle yang sama daripada parameter tetap.`
        : verdict === 'worse'
        ? `Belajar dari setiap hasil menghasilkan ${formatAccountMoney(
            Math.abs(netDelta),
            control.summary.accountType
          )} lebih sedikit daripada parameter tetap di periode ini, jadi penyesuaian tidak menguntungkan di sini.`
        : 'Kedua run selesai dengan selisih sebatas noise, jadi belajar tidak membantu maupun merugikan di periode ini.',
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
  { label: 'Di bawah 40', min: 0, max: 40 },
  { label: '40 sampai 54', min: 40, max: 55 },
  { label: '55 sampai 69', min: 55, max: 70 },
  { label: '70 ke atas', min: 70, max: 101 },
];

export interface ConvictionBucket {
  label: string;
  min: number;
  /** Top of the band, exclusive. */
  max: number;
  signals: number;
  filled: number;
  winRate: number | null;
  netDollars: number;
  expectancyDollars: number | null;
  /**
   * Result per filled trade in the first and second half of the period.
   *
   * A band that loses money overall may have lost it all in one stretch, which
   * is a thing that happened rather than a property of the band. Splitting it
   * is the cheapest guard against reading one bad month as a rule.
   */
  firstHalfPerTrade: number | null;
  secondHalfPerTrade: number | null;
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
  // The halves are cut on the run's own timeline, not on each band's, so every
  // band is judged over the same two stretches of market.
  const opened = trades.map((t) => t.openedAt).sort((a, b) => a - b);
  const midpoint = opened.length ? opened[Math.floor(opened.length / 2)] : 0;

  return CONVICTION_BANDS.map((band) => {
    const inBand = trades.filter(
      (t) => t.convictionScore >= band.min && t.convictionScore < band.max
    );
    const filled = inBand.filter((t) => t.filled);
    const wins = filled.filter((t) => t.netDollars > 0).length;
    const net = filled.reduce((acc, t) => acc + t.netDollars, 0);

    const perTrade = (subset: BacktestTrade[]) =>
      subset.length ? money(subset.reduce((acc, t) => acc + t.netDollars, 0) / subset.length) : null;

    return {
      label: band.label,
      min: band.min,
      max: band.max,
      signals: inBand.length,
      filled: filled.length,
      winRate: filled.length ? round((wins / filled.length) * 100, 1) : null,
      netDollars: money(net),
      expectancyDollars: filled.length ? money(net / filled.length) : null,
      firstHalfPerTrade: perTrade(filled.filter((t) => t.openedAt < midpoint)),
      secondHalfPerTrade: perTrade(filled.filter((t) => t.openedAt >= midpoint)),
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

/** A floor that leaves fewer trades than this cannot be told apart from luck. */
export const MIN_FLOOR_TRADES = 50;

/**
 * How much better, per unit of drawdown, a floor has to be before it is worth
 * the signals it throws away.
 */
const FLOOR_ADVANTAGE = 1.25;

export interface FloorOutcome {
  floor: number;
  /** Filled trades left above the floor. */
  trades: number;
  netDollars: number;
  returnPercent: number;
  /** Worst fall from a high, replaying only the trades above the floor. */
  maxDrawdownPercent: number;
  /** Money made in each half of the period, on the run's own timeline. */
  firstHalfNet: number;
  secondHalfNet: number;
  /** True when the floor made money in both halves. */
  consistent: boolean;
  /** Return divided by worst drawdown: what the floor paid for the pain it caused. */
  returnToDrawdown: number | null;
}

export interface FloorVerdict {
  floors: FloorOutcome[];
  /** The floor this period supports, which is 0 when taking everything is best. */
  recommended: number;
  reason: string;
}

/**
 * Which conviction floor this period supports, judged on risk and not only on
 * money.
 *
 * The old rule picked whichever floor left the most money, and so always
 * favoured taking everything. That is only right when every trade risks the
 * same small share of the balance and the drawdown takes care of itself. On a
 * small account it does not: when the broker minimum lot already risks twice
 * the budget, each extra trade is another full-size bet, and a floor that
 * earns a little less from a fraction of the trades can be the far better
 * account to hold. A 24 month replay showed exactly that. Taking everything
 * earned the most and fell 63% from its high. The 70+ band earned less in
 * total from a fourteenth of the trades, and was the only band that made money
 * in both halves of the period.
 *
 * So a floor is judged on return per unit of drawdown. It has to leave enough
 * trades to mean something and make money in both halves of the period, and it
 * has to beat taking everything by a clear margin before it is worth the
 * signals it refuses.
 */
export function assessFloors(
  trades: BacktestTrade[],
  startingEquity: number,
  floors: number[],
  accountType: BacktestResult['summary']['accountType']
): FloorVerdict {
  const opened = trades.map((t) => t.openedAt).sort((a, b) => a - b);
  const midpoint = opened.length ? opened[Math.floor(opened.length / 2)] : 0;

  const outcomes: FloorOutcome[] = floors.map((floor) => {
    const kept = trades.filter((t) => t.filled && t.convictionScore >= floor);
    const stats = summariseTrades(kept, startingEquity);
    const sum = (subset: BacktestTrade[]) => money(subset.reduce((acc, t) => acc + t.netDollars, 0));
    const firstHalfNet = sum(kept.filter((t) => t.openedAt < midpoint));
    const secondHalfNet = sum(kept.filter((t) => t.openedAt >= midpoint));
    return {
      floor,
      trades: kept.length,
      netDollars: stats.netDollars,
      returnPercent: stats.returnPercent,
      maxDrawdownPercent: stats.maxDrawdownPercent,
      firstHalfNet,
      secondHalfNet,
      consistent: firstHalfNet > 0 && secondHalfNet > 0,
      returnToDrawdown:
        kept.length > 0 ? round(stats.returnPercent / Math.max(stats.maxDrawdownPercent, 1), 2) : null,
    };
  });

  const baseline = outcomes.find((o) => o.floor === 0) ?? outcomes[0];
  const amount = (value: number) => formatAccountMoney(value, accountType, { signed: true });
  const describe = (o: FloorOutcome) =>
    `${amount(o.netDollars)} dari ${o.trades} trade dengan drawdown terburuk ${o.maxDrawdownPercent}%`;

  const eligible = outcomes.filter(
    (o) => o.trades >= MIN_FLOOR_TRADES && o.consistent && o.netDollars > 0 && o.returnToDrawdown !== null
  );

  if (eligible.length === 0) {
    return {
      floors: outcomes,
      recommended: 0,
      reason: `Tidak ada batas yang untung di kedua paruh periode ini dengan minimal ${MIN_FLOOR_TRADES} trade, jadi tidak ada yang layak dijadikan aturan. Mengambil semua setup menghasilkan ${describe(
        baseline
      )}.`,
    };
  }

  const best = eligible.reduce((a, b) => ((b.returnToDrawdown ?? 0) > (a.returnToDrawdown ?? 0) ? b : a));
  const baselineRatio = baseline.returnToDrawdown ?? 0;
  const clearlyBetter =
    best.floor !== baseline.floor &&
    (baselineRatio <= 0 || (best.returnToDrawdown ?? 0) >= baselineRatio * FLOOR_ADVANTAGE);

  if (!clearlyBetter) {
    return {
      floors: outcomes,
      recommended: 0,
      reason: `Mengambil semua setup menghasilkan ${describe(
        baseline
      )}, dan tidak ada batas yang jelas lebih untung per poin drawdown, jadi batas tidak akan membantu.`,
    };
  }

  const multiple =
    baselineRatio > 0 ? ` Itu ${round((best.returnToDrawdown ?? 0) / baselineRatio, 1)} kali hasil per poin drawdown.` : '';

  return {
    floors: outcomes,
    recommended: best.floor,
    reason: `Batas ${best.floor} menghasilkan ${describe(best)}, dibanding ${describe(
      baseline
    )} kalau mengambil semua, dan untung di kedua paruh periode.${multiple} Pasang batas itu di atas lalu jalankan ulang untuk mengujinya dengan benar, lengkap dengan ukuran lot dan pertumbuhan saldo.`,
  };
}

/** Conviction floors the lab offers and judges: off, then the band boundaries. */
export const FLOOR_CHOICES = [0, 40, 55, 70];

export interface FloorCheck {
  floor: number;
  /** What refusing the weaker trades of the take-everything run suggested. */
  estimate: FloorOutcome;
  /** What trading the period with the floor actually did. */
  actual: FloorOutcome;
  /** True when the real run made money in both halves, as the estimate claimed. */
  held: boolean;
  reason: string;
}

/**
 * Whether a recommended floor survives being traded.
 *
 * The estimate removes trades from a run that took everything. A run with the
 * floor is a different run: with the weaker setups refused, the engine is free
 * when other setups appear, and takes those instead. A 24 month replay showed
 * the gap plainly. The estimate for a floor of 70 was 99 trades, profitable in
 * both halves; trading it took 174, and the second half lost money. So a
 * recommendation is only offered as one once the real run agrees.
 */
export function confirmFloor(estimate: FloorOutcome, run: BacktestResult): FloorCheck {
  const accountType = run.summary.accountType;
  const actual = {
    ...assessFloors(run.trades, run.summary.startingEquity, [0], accountType).floors[0],
    floor: estimate.floor,
  };
  const held = actual.consistent && actual.netDollars > 0;
  const amount = (value: number) => formatAccountMoney(value, accountType, { signed: true });
  const traded = `Diuji sungguhan dengan batas ${estimate.floor}, periode ini menghasilkan ${amount(actual.netDollars)} dari ${
    actual.trades
  } trade dengan drawdown terburuk ${actual.maxDrawdownPercent}%`;
  const why =
    actual.trades !== estimate.trades
      ? ` Jumlahnya ${actual.trades} trade, bukan ${estimate.trades} seperti perkiraan: karena setup lemah ditolak, engine bebas mengambil setup lain.`
      : '';

  return {
    floor: estimate.floor,
    estimate,
    actual,
    held,
    reason: held
      ? `${traded}, dan untung di kedua paruh. Rekomendasinya bertahan.${why}`
      : `${traded}, ${
          actual.netDollars > 0 ? 'tapi tidak untung di kedua paruh' : 'dan rugi secara keseluruhan'
        } (${amount(actual.firstHalfNet)} lalu ${amount(
          actual.secondHalfNet
        )}). Perkiraannya tidak bertahan, jadi periode ini tidak mendukung batas tersebut.${why}`,
  };
}

/**
 * Margin over the defaults below which a win is not distinguishable from luck.
 *
 * One period contains its own accidents. A set of parameters that beats the
 * defaults by a hair over two years has not shown an edge, it has shown noise,
 * and adopting it would be reading the accidents as a rule.
 */
const ADOPTION_MARGIN_SHARE = 0.05;

export interface AdoptionVerdict {
  /** True only when adopting is an improvement this period actually supports. */
  worthAdopting: boolean;
  /** One sentence, always set, saying why it is or is not worth adopting. */
  reason: string;
  /** Frozen net minus the defaults' net. */
  netDelta: number;
  /** Frozen worst drawdown minus the defaults', in percentage points. */
  drawdownDelta: number;
}

/**
 * Whether the learned parameters are worth putting on a live account.
 *
 * The button they control is a promise: if it can be pressed, adopting is an
 * improvement. So it takes more than earning a little more. The parameters must
 * differ from the defaults at all, beat them by a margin larger than one
 * period's luck, and not buy that with a deeper drawdown.
 */
export function assessAdoption(control: BacktestResult, frozen: BacktestResult): AdoptionVerdict {
  const accountType = control.summary.accountType;
  const controlStats = summariseTrades(control.trades, control.summary.startingEquity);
  const frozenStats = summariseTrades(frozen.trades, frozen.summary.startingEquity);

  const netDelta = money(frozenStats.netDollars - controlStats.netDollars);
  const drawdownDelta = round(frozenStats.maxDrawdownPercent - controlStats.maxDrawdownPercent, 1);
  const amount = (value: number) => formatAccountMoney(Math.abs(value), accountType);
  const drawdowns = `${frozenStats.maxDrawdownPercent}% dibanding ${controlStats.maxDrawdownPercent}%`;

  const no = (reason: string): AdoptionVerdict => ({
    worthAdopting: false,
    reason,
    netDelta,
    drawdownDelta,
  });

  if (matchesDefaultPrior(frozen.finalWeights)) {
    return no(
      'Run belajar tidak menemukan yang layak diubah dan berakhir di setelan bawaan engine, yang sudah dipakai analisis live. Tidak ada yang perlu dipakai.'
    );
  }

  if (netDelta <= 0) {
    return no(
      `Dipakai tetap sejak candle pertama, parameter ini menghasilkan ${amount(
        netDelta
      )} lebih sedikit daripada setelan bawaan engine. Memakainya akan merugikan di periode ini.`
    );
  }

  // Either five percent of what the defaults made, or a tenth of a percent of
  // the balance, whichever is larger. The second keeps a tiny account honest.
  const margin = Math.max(
    ADOPTION_MARGIN_SHARE * Math.abs(controlStats.netDollars),
    control.summary.startingEquity * 0.001
  );

  if (netDelta < margin) {
    return no(
      `Dipakai tetap, parameter ini menghasilkan ${amount(
        netDelta
      )} lebih banyak daripada setelan bawaan, selisih yang terlalu kecil untuk dibedakan dari kebetulan dalam satu periode.`
    );
  }

  if (drawdownDelta > 0) {
    return no(
      `Dipakai tetap, parameter ini menghasilkan ${amount(
        netDelta
      )} lebih banyak daripada setelan bawaan, tapi drawdown terburuknya lebih dalam, ${drawdowns}. Perjalanannya lebih berat untuk keunggulan yang sama.`
    );
  }

  return {
    worthAdopting: true,
    reason: `Dipakai tetap sejak candle pertama, parameter ini menghasilkan ${amount(
      netDelta
    )} lebih banyak daripada setelan bawaan engine, dengan drawdown terburuk ${drawdowns}. Periode ini mendukung untuk memakainya.`,
    netDelta,
    drawdownDelta,
  };
}

export interface ProtectionVerdict {
  /** True only when moving the stop to entry improved this period. */
  worthUsing: boolean;
  /** One sentence, always set, saying what the rule did over the period. */
  reason: string;
  /** Trades that ended on a stop already moved to entry, instead of a full loss. */
  savedTrades: number;
  /** Protected net minus the unprotected net. */
  netDelta: number;
  /** Protected worst drawdown minus the unprotected one, in percentage points. */
  drawdownDelta: number;
  /** Win rate of the protected run, which a scratch exit counts against. */
  winRate: number | null;
}

/**
 * Whether moving the stop to entry once a trade has paid is worth doing live.
 *
 * This is the rule every trader reaches for after a run of stop outs, and it is
 * not free: a trade that touches the trigger and then goes on to the target
 * still ends at nothing if price dips back first. Over a period it either paid
 * for that or it did not, and the only way to know is to trade the same setups
 * both ways, which is what the two runs here are.
 *
 * The bar is deliberately not "it lost less": a rule that costs money to make
 * the equity curve look calmer is still a rule that costs money. It passes when
 * it earned at least as much, and made the worst stretch meaningfully easier to
 * sit through, or when it plainly earned more.
 */
export function assessProtection(control: BacktestResult, guarded: BacktestResult): ProtectionVerdict {
  const accountType = control.summary.accountType;
  const controlStats = summariseTrades(control.trades, control.summary.startingEquity);
  const guardedStats = summariseTrades(guarded.trades, guarded.summary.startingEquity);

  const netDelta = money(guardedStats.netDollars - controlStats.netDollars);
  const drawdownDelta = round(guardedStats.maxDrawdownPercent - controlStats.maxDrawdownPercent, 1);
  const savedTrades = guarded.trades.filter((t) => t.protectedExit).length;
  const amount = (value: number) => formatAccountMoney(Math.abs(value), accountType);
  const drawdowns = `${guardedStats.maxDrawdownPercent}% dibanding ${controlStats.maxDrawdownPercent}%`;

  const base = { savedTrades, netDelta, drawdownDelta, winRate: guardedStats.winRate };

  if (savedTrades === 0) {
    return {
      ...base,
      worthUsing: false,
      reason:
        'Tidak ada trade di periode ini yang cukup jauh untung untuk memindah stop-nya, jadi aturan ini tidak akan mengubah apa pun.',
    };
  }

  // Earning more is the plain case, and it needs a margin: over one period a
  // handful of cent either way is the sample, not the rule.
  const margin = Math.max(
    ADOPTION_MARGIN_SHARE * Math.abs(controlStats.netDollars),
    control.summary.startingEquity * 0.001
  );

  if (netDelta >= margin && drawdownDelta <= 0) {
    return {
      ...base,
      worthUsing: true,
      reason: `Stop dipindah ke entry di ${savedTrades} trade, dan periode ini menghasilkan ${amount(
        netDelta
      )} lebih banyak dengan cara itu, dengan drawdown terburuk ${drawdowns}. Periode ini mendukung untuk memakainya.`,
    };
  }

  // The other case it passes: the money is no worse and the ride is clearly
  // easier, which is what this rule is actually for.
  if (netDelta >= 0 && drawdownDelta <= -1) {
    return {
      ...base,
      worthUsing: true,
      reason: `Stop dipindah ke entry di ${savedTrades} trade. Periode ini menghasilkan ${amount(
        netDelta
      )} lebih banyak dan drawdown terburuk turun ke ${drawdowns}, jadi hasil yang sama didapat dengan perjalanan lebih tenang.`,
    };
  }

  if (netDelta < 0) {
    return {
      ...base,
      worthUsing: false,
      reason: `Stop dipindah ke entry di ${savedTrades} trade, dan itu merugikan ${amount(
        netDelta
      )} selama periode ini: trade yang ditutup impas lebih sering sedang menuju target daripada berbalik. Drawdown terburuk ${drawdowns}.`,
    };
  }

  return {
    ...base,
    worthUsing: false,
    reason: `Stop dipindah ke entry di ${savedTrades} trade dan periode ini berakhir ${amount(
      netDelta
    )} lebih untung, selisih yang terlalu kecil untuk dibedakan dari kebetulan. Drawdown terburuk ${drawdowns}.`,
  };
}

export interface RiskFloorReport {
  /** True when at least one trade had to risk more than the setting asked. */
  forced: boolean;
  /** Filled trades where the minimum lot was larger than the budget allowed. */
  forcedTrades: number;
  filledTrades: number;
  /** Risk the setting asked for, as a share of the balance at the time. */
  askedPercent: number;
  /** What those trades actually risked, as a share of the balance at the time. */
  actualPercent: number;
  /** Balance at which the setting would start to be honoured, in dollars. */
  balanceNeeded: number;
  /** One sentence, or an empty string when there is nothing to warn about. */
  message: string;
}

/**
 * Whether the risk percentage was real or decorative.
 *
 * A broker's smallest lot is a floor, and on a small balance it can sit above
 * the risk the user asked for. When it does, changing the percentage changes
 * nothing at all: every trade is the same minimum lot either way, and the
 * account is taking whatever risk that lot happens to carry. A backtest that
 * shows two risk settings producing the same trades is not broken — it is this
 * — and it should say so rather than leave the user to notice.
 */
export function assessRiskFloor(result: BacktestResult): RiskFloorReport {
  const filled = result.trades.filter((t) => t.filled);
  const forcedTrades = filled.filter((t) => t.minimumLotForced);
  const accountType = result.summary.accountType;

  const empty: RiskFloorReport = {
    forced: false,
    forcedTrades: 0,
    filledTrades: filled.length,
    askedPercent: result.summary.riskPercentage,
    actualPercent: result.summary.riskPercentage,
    balanceNeeded: result.summary.startingEquity,
    message: '',
  };

  if (forcedTrades.length === 0) return empty;

  // Balance at the time is what the trade was sized against, so the share is
  // measured there rather than against the balance the run started with.
  const shares = forcedTrades.map((t) => {
    const balanceBefore = t.equityAfter - t.netDollars;
    return balanceBefore > 0 ? (t.actualRiskDollars / balanceBefore) * 100 : 0;
  });
  const actualPercent = round(shares.reduce((acc, v) => acc + v, 0) / shares.length, 2);
  const typicalRisk =
    forcedTrades.reduce((acc, t) => acc + t.actualRiskDollars, 0) / forcedTrades.length;
  const asked = result.summary.riskPercentage;
  const balanceNeeded = asked > 0 ? money(typicalRisk / (asked / 100)) : 0;
  const share = Math.round((forcedTrades.length / Math.max(filled.length, 1)) * 100);

  return {
    forced: true,
    forcedTrades: forcedTrades.length,
    filledTrades: filled.length,
    askedPercent: asked,
    actualPercent,
    balanceNeeded,
    message: `Setelan risiko ${asked}% tidak bisa dipenuhi di ${share}% trade yang terisi: lot terkecil broker sudah berisiko sekitar ${actualPercent}% saldo. Sampai saldo mendekati ${formatAccountMoney(
      balanceNeeded,
      accountType
    )}, mengubah persentase risiko tidak berpengaruh, karena setiap trade tetap memakai lot minimum yang sama.`,
  };
}

/**
 * Filled trades a band needs before it may be refused outright.
 *
 * Under forty a bad stretch and a bad band look identical, and a rule built on
 * a handful of trades is a rule built on an accident.
 */
const MIN_DEAD_BAND_TRADES = 40;
/** And this many in each half, so neither half carries the verdict alone. */
const MIN_DEAD_BAND_HALF = 12;

export interface DeadBandVerdict {
  /** True only when one band lost money in both halves of the period. */
  worthSkipping: boolean;
  /** The band to refuse, when there is one. */
  band: { label: string; min: number; max: number } | null;
  /** What refusing it would have added over the period. */
  estimatedGain: number;
  /** One sentence, always set. */
  reason: string;
}

/**
 * Whether one conviction band is bad enough to refuse outright.
 *
 * A floor assumes conviction is a ladder: the higher the score the better the
 * trade. This run says otherwise — the lowest band paid the most — so a floor
 * throws away the good with the bad. Refusing a single band in the middle is
 * the narrower instrument, and it is also the easier one to fool yourself with,
 * because any period contains some slice that lost money.
 *
 * So the bar is not "this band lost money". It is: enough trades to mean
 * something, and losing in both halves of the period rather than in one bad
 * stretch that the other half quietly paid for.
 */
export function assessDeadBand(control: BacktestResult): DeadBandVerdict {
  const accountType = control.summary.accountType;
  const buckets = convictionBreakdown(control.trades);
  const amount = (value: number) => formatAccountMoney(Math.abs(value), accountType);

  const none = (reason: string): DeadBandVerdict => ({
    worthSkipping: false,
    band: null,
    estimatedGain: 0,
    reason,
  });

  const candidates = buckets.filter(
    (b) =>
      b.netDollars < 0 &&
      b.filled >= MIN_DEAD_BAND_TRADES &&
      b.firstHalfPerTrade !== null &&
      b.secondHalfPerTrade !== null &&
      b.firstHalfPerTrade < 0 &&
      b.secondHalfPerTrade < 0
  );

  if (candidates.length === 0) {
    const losing = buckets.filter((b) => b.netDollars < 0 && b.filled > 0);
    if (losing.length === 0) {
      return none('Semua rentang conviction untung di periode ini, jadi tidak ada yang perlu ditolak.');
    }
    return none(
      `Rentang ${losing[0].label} rugi ${amount(
        losing[0].netDollars
      )} selama periode ini, tapi tidak konsisten di kedua paruh, atau trade-nya terlalu sedikit untuk membedakan rentang yang buruk dari periode yang sial. Menolaknya berarti menjadikan kebetulan satu periode sebagai aturan.`
    );
  }

  // Count the halves properly before trusting the split: a band can lose in
  // both halves on two trades in one of them.
  const solid = candidates.filter((b) => b.filled >= MIN_DEAD_BAND_TRADES + MIN_DEAD_BAND_HALF);
  const worst = (solid.length ? solid : candidates).sort((a, b) => a.netDollars - b.netDollars)[0];

  return {
    worthSkipping: true,
    band: { label: worst.label, min: worst.min, max: worst.max },
    estimatedGain: money(-worst.netDollars),
    reason: `Setup dengan skor ${worst.label.toLowerCase()} rugi ${amount(
      worst.netDollars
    )} dari ${worst.filled} trade terisi, rugi ${amount(
      worst.firstHalfPerTrade ?? 0
    )} per trade di paruh pertama dan ${amount(
      worst.secondHalfPerTrade ?? 0
    )} per trade di paruh kedua. Menolak rentang itu saja, dan tetap mengambil sisanya, akan menambah sekitar ${amount(
      worst.netDollars
    )}.`,
  };
}

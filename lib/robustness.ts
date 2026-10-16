/**
 * Whether a set of results would survive being looked at harder.
 *
 * A total over one period says little on its own. Three questions say more:
 * did it pay in most stretches of time rather than one lucky run, how wide is
 * the honest range around the average once chance is allowed for, and does it
 * still pay if trading costs turn out worse than assumed. Everything here works
 * from results in R, so the backtest and the user's own live trades are judged
 * the same way.
 */

export interface RResult {
  /** When the trade was placed, epoch milliseconds. */
  openedAt: number;
  /** The result as a multiple of the risk taken, after costs. */
  rMultiple: number;
  /** Dollars of price between the fill and the stop, for the cost stress. */
  riskDistance?: number;
}

export interface PeriodRow {
  label: string;
  trades: number;
  totalR: number;
  averageR: number | null;
  profitFactor: number | null;
}

export interface ExpectancyInterval {
  /** Average result per trade, in R. */
  mean: number;
  /** The range the average falls in for 95 of 100 resamples of these trades. */
  low: number;
  high: number;
  trades: number;
}

export interface RobustnessReport {
  quarters: PeriodRow[];
  /** Quarters with at least MIN_QUARTER_TRADES that made money, out of those that had them. */
  positiveQuarters: number;
  countedQuarters: number;
  expectancy: ExpectancyInterval | null;
  stress: { extraDollars: number; averageR: number | null; profitFactor: number | null };
  verdict: 'holds' | 'fragile' | 'fails' | 'insufficient';
  explanation: string;
}

export interface MonteCarloReport {
  simulations: number;
  trades: number;
  riskPerTradePercent: number;
  ruinDrawdownPercent: number;
  /** Median, 95th percentile, and worst simulated maximum drawdown. */
  maxDrawdownPercent: { median: number; p95: number; worst: number };
  /** Median, 95th percentile, and worst simulated losing streak. */
  losingStreak: { median: number; p95: number; worst: number };
  /** Share of simulations whose maximum drawdown reached the ruin threshold. */
  probabilityOfRuinPercent: number;
}

/** Fewer trades than this in a quarter and its result is not counted either way. */
export const MIN_QUARTER_TRADES = 10;
/** Fewer trades than this and no range is worth quoting. */
export const MIN_INTERVAL_TRADES = 20;
/** How much worse than assumed the cost stress makes every trade, in dollars of price. */
export const STRESS_EXTRA_DOLLARS = 0.3;

const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places;

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * fraction)));
  return values[index];
}

function profitFactor(rs: number[]): number | null {
  const won = rs.filter((r) => r > 0).reduce((a, r) => a + r, 0);
  const lost = -rs.filter((r) => r < 0).reduce((a, r) => a + r, 0);
  return lost > 0 ? round(won / lost, 2) : null;
}

/** A small seeded generator, so the same trades always give the same range. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The average result with a 95% range, by resampling the trades with
 * replacement. Null under MIN_INTERVAL_TRADES, where any range is mostly noise.
 */
export function expectancyInterval(rs: number[], resamples = 2000, seed = 7): ExpectancyInterval | null {
  if (rs.length < MIN_INTERVAL_TRADES) return null;
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let k = 0; k < resamples; k++) {
    let sum = 0;
    for (let j = 0; j < rs.length; j++) sum += rs[Math.floor(random() * rs.length)];
    means.push(sum / rs.length);
  }
  means.sort((a, b) => a - b);
  const mean = rs.reduce((a, r) => a + r, 0) / rs.length;
  return {
    mean: round(mean),
    low: round(means[Math.floor(resamples * 0.025)]),
    high: round(means[Math.min(resamples - 1, Math.floor(resamples * 0.975))]),
    trades: rs.length,
  };
}

/** Results grouped by calendar quarter (UTC), oldest first. */
export function byQuarter(results: RResult[]): PeriodRow[] {
  const groups = new Map<string, number[]>();
  for (const r of [...results].sort((a, b) => a.openedAt - b.openedAt)) {
    const d = new Date(r.openedAt);
    const label = `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    (groups.get(label) ?? groups.set(label, []).get(label)!).push(r.rMultiple);
  }
  return [...groups.entries()].map(([label, rs]) => ({
    label,
    trades: rs.length,
    totalR: round(rs.reduce((a, r) => a + r, 0), 2),
    averageR: rs.length ? round(rs.reduce((a, r) => a + r, 0) / rs.length) : null,
    profitFactor: profitFactor(rs),
  }));
}

/**
 * Each result made worse by `extraDollars` of price, as if spread and slippage
 * together cost that much more than the replay charged. Results without a
 * known stop distance are left as they are.
 */
export function stressed(results: RResult[], extraDollars = STRESS_EXTRA_DOLLARS): number[] {
  return results.map((r) =>
    r.riskDistance && r.riskDistance > 0 ? r.rMultiple - extraDollars / r.riskDistance : r.rMultiple
  );
}

export interface MonteCarloOptions {
  simulations?: number;
  /** Used only to convert R multiples into a compounded equity curve. */
  riskPerTradePercent?: number;
  /** Drawdown threshold used for the probability-of-ruin label. */
  ruinDrawdownPercent?: number;
  seed?: number;
}

/**
 * Shuffle the observed R results without replacement and measure account paths.
 * This tests sequence risk, not future profitability: it cannot fix selection bias,
 * missing costs, or a mismatch between historical and live market data.
 */
export function monteCarloRiskReport(
  rMultiples: number[],
  options: MonteCarloOptions = {}
): MonteCarloReport | null {
  const results = rMultiples.filter(Number.isFinite);
  if (results.length < MIN_INTERVAL_TRADES) return null;

  const simulations = Math.max(100, Math.floor(options.simulations ?? 2_000));
  const riskPerTradePercent = Math.max(0.01, options.riskPerTradePercent ?? 0.5);
  const ruinDrawdownPercent = Math.max(1, options.ruinDrawdownPercent ?? 30);
  const random = mulberry32(options.seed ?? 19);
  const drawdowns: number[] = [];
  const streaks: number[] = [];
  let ruinCount = 0;

  for (let simulation = 0; simulation < simulations; simulation += 1) {
    const shuffled = [...results];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    let equity = 1;
    let peak = 1;
    let maxDrawdown = 0;
    let currentStreak = 0;
    let worstStreak = 0;
    for (const rMultiple of shuffled) {
      equity *= Math.max(0.01, 1 + (rMultiple * riskPerTradePercent) / 100);
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak > 0 ? ((peak - equity) / peak) * 100 : 100);
      if (rMultiple <= 0) {
        currentStreak += 1;
        worstStreak = Math.max(worstStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
    }
    drawdowns.push(maxDrawdown);
    streaks.push(worstStreak);
    if (maxDrawdown >= ruinDrawdownPercent) ruinCount += 1;
  }

  drawdowns.sort((a, b) => a - b);
  streaks.sort((a, b) => a - b);
  return {
    simulations,
    trades: results.length,
    riskPerTradePercent: round(riskPerTradePercent, 2),
    ruinDrawdownPercent: round(ruinDrawdownPercent, 1),
    maxDrawdownPercent: {
      median: round(percentile(drawdowns, 0.5), 1),
      p95: round(percentile(drawdowns, 0.95), 1),
      worst: round(drawdowns[drawdowns.length - 1], 1),
    },
    losingStreak: {
      median: Math.round(percentile(streaks, 0.5)),
      p95: Math.round(percentile(streaks, 0.95)),
      worst: Math.round(streaks[streaks.length - 1]),
    },
    probabilityOfRuinPercent: round((ruinCount / simulations) * 100, 1),
  };
}

export function robustnessReport(results: RResult[], extraDollars = STRESS_EXTRA_DOLLARS): RobustnessReport {
  const quarters = byQuarter(results);
  const counted = quarters.filter((q) => q.trades >= MIN_QUARTER_TRADES);
  const positiveQuarters = counted.filter((q) => q.totalR > 0).length;
  const rs = results.map((r) => r.rMultiple);
  const expectancy = expectancyInterval(rs);
  const worse = stressed(results, extraDollars);
  const stress = {
    extraDollars,
    averageR: worse.length ? round(worse.reduce((a, r) => a + r, 0) / worse.length) : null,
    profitFactor: profitFactor(worse),
  };

  if (!expectancy) {
    return {
      quarters,
      positiveQuarters,
      countedQuarters: counted.length,
      expectancy,
      stress,
      verdict: 'insufficient',
      explanation: `${rs.length} trade terisi. Rentang di sekitar rata-rata butuh minimal ${MIN_INTERVAL_TRADES}.`,
    };
  }

  const share = counted.length ? positiveQuarters / counted.length : 0;
  const stressHolds = (stress.averageR ?? 0) > 0;
  let verdict: RobustnessReport['verdict'];
  let explanation: string;
  if (expectancy.mean <= 0) {
    verdict = 'fails';
    explanation = `Rata-rata trade rugi ${expectancy.mean.toFixed(3)}R. Tidak ada keunggulan di sini.`;
  } else if (expectancy.low > 0 && stressHolds && share >= 0.6) {
    verdict = 'holds';
    explanation = `Bahkan batas bawah rentangnya di atas nol, ${positiveQuarters} dari ${counted.length} kuartal untung, dan tetap untung walaupun biaya $${extraDollars.toFixed(
      2
    )} per trade lebih mahal dari perkiraan.`;
  } else {
    verdict = 'fragile';
    const reasons = [
      expectancy.low <= 0 ? 'batas bawah rentangnya nol atau di bawah nol, jadi untungnya bisa saja hanya kebetulan' : null,
      !stressHolds ? `tidak lagi untung kalau biaya $${extraDollars.toFixed(2)} per trade lebih mahal dari perkiraan` : null,
      share < 0.6 ? `hanya ${positiveQuarters} dari ${counted.length} kuartal yang untung` : null,
    ].filter(Boolean);
    explanation = `Rata-rata untung, tapi ${reasons.join(', dan ')}.`;
  }

  return { quarters, positiveQuarters, countedQuarters: counted.length, expectancy, stress, verdict, explanation };
}

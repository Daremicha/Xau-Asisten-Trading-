/**
 * Conviction-scaled position sizing.
 *
 * Risking the same percentage on every setup treats a four-timeframe alignment
 * during the London kill zone exactly like a ranging chart with one weak
 * confluence. Professionals do not do that: the risk percentage is a ceiling
 * for the best setups, and weaker ones get a fraction of it.
 *
 * Conviction only ever scales the risk DOWN. The percentage the user chose is
 * never exceeded, whatever the engine thinks of a setup.
 */

export interface ConvictionInputs {
  /** Weighted confluence agreement, 0 to 100. */
  confidenceScore: number;
  /** True when every higher timeframe agrees with the trade direction. */
  timeframesAligned: boolean;
  /** True when execution falls inside an institutional kill zone. */
  killZoneActive: boolean;
  /** True when no point of interest was within the style's reach. */
  entryOutOfReach: boolean;
  /** Feed state. A stale quote is not a basis for a full size position. */
  dataStale: boolean;
  /** True when a language model proposal was rejected for breaking a rule. */
  proposalRejected: boolean;
  /**
   * How far the account sits below its own high water mark, as a percentage.
   *
   * The portfolio panel tracked this from the first version and nothing ever
   * read it. A drawdown is the one signal that does not come from the chart: it
   * says the edge and the current market disagree, whatever the setup looks
   * like, and the standard answer is to commit less until they agree again.
   */
  drawdownPercent?: number;
  /**
   * What this kind of setup has actually returned, in multiples of risk, once
   * enough of them have closed to mean anything. Null when the history is too
   * thin to say.
   */
  measuredEdgeR?: number | null;
}

export interface ConvictionResult {
  /** Fraction of the user's risk budget to actually commit, 0.25 to 1. */
  multiplier: number;
  /** Zero to one hundred, for display. */
  convictionScore: number;
  /** Short label: Low, Moderate, High. */
  band: 'Low' | 'Moderate' | 'High';
  /** Sentences explaining every deduction applied. */
  notes: string[];
}

/** Never size below this fraction of budget; a trade worth taking is worth sizing. */
const MIN_MULTIPLIER = 0.25;

/**
 * Turns the engine's reading of a setup into a fraction of the risk budget.
 *
 * Starts from the weighted confluence score and deducts for each condition that
 * makes the setup less trustworthy. Every deduction is named, so a small lot is
 * never a mystery.
 */
export function assessConviction(inputs: ConvictionInputs): ConvictionResult {
  const notes: string[] = [];

  // Confluence is the base. A score of 50 is an even argument, so it earns half.
  let score = Math.max(0, Math.min(100, inputs.confidenceScore));

  if (inputs.timeframesAligned) {
    score += 12;
    notes.push('Every higher timeframe agrees with the direction, which raises conviction.');
  } else {
    score -= 8;
    notes.push('The higher timeframes disagree with each other, which lowers conviction.');
  }

  if (inputs.killZoneActive) {
    score += 6;
    notes.push('Execution falls inside an institutional kill zone.');
  }

  // The account's own state, which no amount of chart reading can see.
  const drawdown = inputs.drawdownPercent ?? 0;
  if (drawdown >= 20) {
    score -= 20;
    notes.push(
      `The account is ${drawdown.toFixed(1)}% below its high water mark, so position size is cut while the edge and the market disagree.`
    );
  } else if (drawdown >= 10) {
    score -= 10;
    notes.push(`The account is ${drawdown.toFixed(1)}% below its high water mark, so size is trimmed.`);
  }

  // What this kind of setup has actually returned, when enough have closed.
  if (typeof inputs.measuredEdgeR === 'number') {
    if (inputs.measuredEdgeR <= -0.2) {
      score -= 12;
      notes.push(
        `Setups like this one have returned ${inputs.measuredEdgeR.toFixed(2)}R in your own history, so less is committed to it.`
      );
    } else if (inputs.measuredEdgeR >= 0.2) {
      score += 8;
      notes.push(
        `Setups like this one have returned ${inputs.measuredEdgeR.toFixed(2)}R in your own history.`
      );
    }
  }

  if (inputs.entryOutOfReach) {
    score -= 25;
    notes.push('No point of interest was within reach, so the entry may never fill.');
  }

  if (inputs.dataStale) {
    score -= 30;
    notes.push('The quote is stale, so size is cut sharply until live data returns.');
  }

  if (inputs.proposalRejected) {
    score -= 10;
    notes.push('A language model proposal was rejected for breaking a structural rule.');
  }

  const convictionScore = Math.max(0, Math.min(100, Math.round(score)));

  // Map conviction onto the usable band. 100 earns the full budget, 0 earns the
  // floor, and everything between scales linearly.
  const multiplier = parseFloat(
    (MIN_MULTIPLIER + (1 - MIN_MULTIPLIER) * (convictionScore / 100)).toFixed(3)
  );

  const band: ConvictionResult['band'] =
    convictionScore >= 70 ? 'High' : convictionScore >= 45 ? 'Moderate' : 'Low';

  notes.unshift(
    `Conviction ${convictionScore} of 100 (${band}), so ${Math.round(
      multiplier * 100
    )}% of the risk budget is committed.`
  );

  return { multiplier, convictionScore, band, notes };
}

/** The risk percentage actually used, after conviction scaling. */
export function effectiveRiskPercentage(requested: number, multiplier: number): number {
  // Rounded to four places so a cent account still sees the difference.
  return parseFloat(Math.max(0, requested * multiplier).toFixed(4));
}

/**
 * How far the account sits below its own high water mark.
 *
 * Reconstructed from the closed trades rather than stored, so it needs nothing
 * the analysis request does not already carry: the current balance, and the
 * money each recorded trade moved. Returns zero when there is no history, which
 * is the honest answer for an account that has not traded yet.
 */
export function drawdownFromHistory(
  equity: number,
  records: Array<{ profitOrLossDollars?: number }>
): number {
  if (equity <= 0 || records.length === 0) return 0;

  const moves = records.map((r) => (Number.isFinite(r.profitOrLossDollars) ? r.profitOrLossDollars! : 0));
  const start = equity - moves.reduce((acc, m) => acc + m, 0);

  let running = start;
  let peak = start;
  for (const move of moves) {
    running += move;
    if (running > peak) peak = running;
  }

  if (peak <= 0 || equity >= peak) return 0;
  return parseFloat((((peak - equity) / peak) * 100).toFixed(1));
}

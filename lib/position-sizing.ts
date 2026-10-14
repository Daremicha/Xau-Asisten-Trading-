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
  /**
   * Reward to risk on the first target, measured from where it actually landed.
   *
   * Targets sit on structure now, so this varies trade by trade. One inside a
   * one to one needs better than even odds just to break even, which is a
   * smaller position, not a refusal: the level is real, the payout is thin.
   */
  rewardToRisk?: number;
}

export interface ConvictionResult {
  /**
   * Share of the user's risk budget to actually commit.
   *
   * A quarter at the bottom and the whole budget from seventy up. Never more
   * than the budget. See `CONVICTION_FULL` below.
   */
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
 * The score at which the whole risk budget is committed.
 *
 * Seventy is where the backtest's own conviction breakdown separates: the band
 * above it returned 1.87 cent a trade against 1.13 for the lowest one. Above it
 * the size stays at the budget; the user's percentage is a ceiling.
 */
const CONVICTION_FULL = 70;

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
    notes.push('Semua timeframe besar searah, jadi conviction naik.');
  } else {
    score -= 8;
    notes.push('Timeframe besar tidak searah satu sama lain, jadi conviction turun.');
  }

  if (inputs.killZoneActive) {
    score += 6;
    notes.push('Eksekusi ada di dalam kill zone institusional.');
  }

  // The account's own state, which no amount of chart reading can see.
  const drawdown = inputs.drawdownPercent ?? 0;
  if (drawdown >= 20) {
    score -= 20;
    notes.push(
      `Akun ${drawdown.toFixed(1)}% di bawah puncak saldonya, jadi ukuran posisi dipotong selama keunggulan dan pasar tidak sejalan.`
    );
  } else if (drawdown >= 10) {
    score -= 10;
    notes.push(`Akun ${drawdown.toFixed(1)}% di bawah puncak saldonya, jadi ukuran dikurangi sedikit.`);
  }

  // What this kind of setup has actually returned, when enough have closed.
  if (typeof inputs.measuredEdgeR === 'number') {
    if (inputs.measuredEdgeR <= -0.2) {
      score -= 12;
      notes.push(
        `Setup seperti ini menghasilkan ${inputs.measuredEdgeR.toFixed(2)}R di riwayatmu sendiri, jadi risikonya dikurangi.`
      );
    } else if (inputs.measuredEdgeR >= 0.2) {
      score += 8;
      notes.push(
        `Setup seperti ini menghasilkan ${inputs.measuredEdgeR.toFixed(2)}R di riwayatmu sendiri.`
      );
    }
  }

  // What the first target actually pays for the stop it carries.
  if (typeof inputs.rewardToRisk === 'number' && inputs.rewardToRisk > 0) {
    if (inputs.rewardToRisk < 0.75) {
      score -= 15;
      notes.push(
        `Target pertama membayar ${inputs.rewardToRisk.toFixed(
          2
        )} kali risiko, jadi butuh tingkat menang tinggi supaya layak, dan ukurannya disesuaikan.`
      );
    } else if (inputs.rewardToRisk < 1) {
      score -= 8;
      notes.push(
        `Target pertama membayar ${inputs.rewardToRisk.toFixed(2)} kali risiko, sedikit di bawah satu banding satu.`
      );
    }
  }

  if (inputs.entryOutOfReach) {
    score -= 25;
    notes.push('Tidak ada area menarik dalam jangkauan, jadi entry-nya mungkin tidak pernah terisi.');
  }

  if (inputs.dataStale) {
    score -= 30;
    notes.push('Harga tertunda, jadi ukuran dipotong tajam sampai data live kembali.');
  }

  if (inputs.proposalRejected) {
    score -= 10;
    notes.push('Usulan model bahasa (AI) ditolak karena melanggar aturan struktur.');
  }

  const convictionScore = Math.max(0, Math.min(100, Math.round(score)));

  // Conviction decides what share of the budget is used: a quarter at zero,
  // all of it at seventy and above. Never more than the budget: the risk the
  // user set is a ceiling, and a confident reading of the chart is not a
  // reason to lose more than they agreed to.
  const raw = MIN_MULTIPLIER + (1 - MIN_MULTIPLIER) * (Math.min(convictionScore, CONVICTION_FULL) / CONVICTION_FULL);
  const multiplier = parseFloat(raw.toFixed(3));

  const band: ConvictionResult['band'] =
    convictionScore >= 70 ? 'High' : convictionScore >= 45 ? 'Moderate' : 'Low';

  notes.unshift(
    `Conviction ${convictionScore} dari 100 (${band}), jadi ${Math.round(multiplier * 100)}% dari batas risiko yang dipakai.`
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

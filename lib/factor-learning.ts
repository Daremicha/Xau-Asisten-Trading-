/**
 * Which parts of the read actually earn their vote.
 *
 * Every setup is the sum of a dozen opinions — the higher timeframe, the order
 * block, RSI, the EMA stack, Wyckoff, the pivot — and until now the engine
 * learned from its results only at the level of the whole trade. It could tell
 * that order block entries paid better than gap entries, but not that RSI had
 * been arguing for the losing side for fifty trades running. A factor that
 * keeps pointing the wrong way kept its full say.
 *
 * This measures each factor on its own. For every filled trade the record
 * keeps how each factor voted relative to the direction actually taken. A
 * factor is then judged on one question: were trades it agreed with better
 * than trades it opposed? A factor with a real edge shows a gap in its favour.
 * A factor that misleads shows the gap reversed — the trades it argued against
 * were the ones that worked.
 *
 * The result is a multiplier on that factor's weight, never a sign flip and
 * never a veto. The bar for moving is deliberately high: a gap has to clear
 * twice its own standard error before anything changes, both sides need a real
 * sample, and even then the move is scaled by how much evidence there is. On a
 * market with no pattern in it the multipliers stay at one, which is the test
 * that this is learning rather than fitting noise.
 */

import type { SelfLearningMemoryRecord } from './types';
import { verificationWeight } from './evidence-weight';

/** A factor may lose at most half its say, or gain at most half again. */
export const FACTOR_MULTIPLIER_MIN = 0.5;
export const FACTOR_MULTIPLIER_MAX = 1.5;

/** A vote this close to zero is silence, not agreement or opposition. */
const VOTE_DEADZONE = 0.1;

/** Filled trades needed on each side before a factor can be judged at all. */
export const MIN_FACTOR_SAMPLES = 8;

/** Evidence at which a justified move reaches half its full size. */
const CONFIDENCE_MIDPOINT = 8;

/**
 * Standard errors a gap must clear before it moves anything.
 *
 * Eleven factors are judged at once, so a loose bar finds something in every
 * record set. At one standard error a patternless market moved a third of
 * them; at two, a pattern has to be real to show.
 */
export const NOISE_BAR_STANDARD_ERRORS = 2;

/**
 * Trades back at which a trade counts half, for this measure only.
 *
 * Far longer than the engine's own twenty. Whether RSI tends to be right on
 * gold is a slow property of the market, not this week's mood, and a short
 * memory leaves too little evidence to ever clear the bar above. The first
 * version used sixty, which over a 24 month replay of 1,391 filled trades
 * meant the verdict rested on roughly the last 170: the replay reported that
 * no factor was reliably right or wrong over the period while having looked
 * at an eighth of it. At 250 a live account is weighed almost evenly, and a
 * two year replay counts most of its own history.
 */
export const FACTOR_HALF_LIFE = 250;

/** How far a factor's say moves for each standard error past the bar. */
const STEP_PER_STANDARD_ERROR = 0.15;

/** Most names a stored vote map may carry, so a corrupt row cannot bloat one. */
const MAX_FACTORS = 24;

/**
 * Each factor's vote, turned to face the trade that was actually taken.
 *
 * Positive means the factor argued for this trade, negative that it argued
 * against it and was outvoted. Stored this way so a long and a short can be
 * pooled: what matters is whether the factor was on the right side, not which
 * side that was.
 */
export function alignedVotes(
  factors: ReadonlyArray<{ name: string; direction: number }>,
  direction: 'long' | 'short'
): Record<string, number> {
  const sign = direction === 'long' ? 1 : -1;
  const out: Record<string, number> = {};
  for (const factor of factors) {
    if (!factor || typeof factor.name !== 'string' || !Number.isFinite(factor.direction)) continue;
    out[factor.name] = parseFloat((factor.direction * sign).toFixed(3));
  }
  return out;
}

/** The direction an order trades, read from its type. */
export function directionOfOrder(orderType: string): 'long' | 'short' {
  return orderType.includes('SELL') ? 'short' : 'long';
}

/**
 * Makes a vote map read from storage or a request safe to learn from.
 *
 * The map arrives from the browser on its way into the ledger, so anything that
 * is not a short name paired with a finite, sensible number is dropped rather
 * than trusted. Returns undefined when nothing usable is left.
 */
export function sanitiseFactorVotes(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  let count = 0;
  for (const [name, vote] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_FACTORS) break;
    if (name.length === 0 || name.length > 64) continue;
    if (typeof vote !== 'number' || !Number.isFinite(vote) || Math.abs(vote) > 5) continue;
    out[name] = vote;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

/**
 * Makes a stored set of factor multipliers safe to apply.
 *
 * They arrive from browser storage or a synced profile when a backtest's
 * result has been adopted, so each is bounded to the range learning could
 * have produced and anything else is dropped. A multiplier of one says
 * nothing and is left out. Returns undefined when nothing is left, so the
 * caller can omit the field — Firestore refuses an undefined value.
 */
export function sanitiseFactorMultipliers(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  let count = 0;
  for (const [name, multiplier] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_FACTORS) break;
    if (name.length === 0 || name.length > 64) continue;
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) continue;
    const bounded = parseFloat(
      Math.max(FACTOR_MULTIPLIER_MIN, Math.min(FACTOR_MULTIPLIER_MAX, multiplier)).toFixed(2)
    );
    if (bounded === 1) continue;
    out[name] = bounded;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

export interface FactorReliability {
  name: string;
  /** Filled trades the factor argued for. */
  agreedSamples: number;
  /** Filled trades the factor argued against and was outvoted. */
  opposedSamples: number;
  /** Average result, in R, of the trades it argued for. */
  agreedR: number | null;
  /** Average result, in R, of the trades it argued against. */
  opposedR: number | null;
  /** agreedR minus opposedR. Positive is a factor worth listening to. */
  edge: number | null;
  /** How far that gap is from noise, in its own standard errors. */
  strength: number | null;
  /** What the factor's weight is multiplied by from here on. */
  multiplier: number;
}

interface Side {
  sumW: number;
  sumW2: number;
  sumWR: number;
  sumWR2: number;
  count: number;
}

const emptySide = (): Side => ({ sumW: 0, sumW2: 0, sumWR: 0, sumWR2: 0, count: 0 });

function add(side: Side, w: number, r: number) {
  side.sumW += w;
  side.sumW2 += w * w;
  side.sumWR += w * r;
  side.sumWR2 += w * r * r;
  side.count += 1;
}

/** Weighted mean, the variance of that mean, and the effective sample size. */
function describe(side: Side): { mean: number; varianceOfMean: number; effective: number } | null {
  if (side.count === 0 || side.sumW <= 0) return null;
  const mean = side.sumWR / side.sumW;
  const variance = Math.max(0, side.sumWR2 / side.sumW - mean * mean);
  // Kish's effective sample size: recency weighting means fifty old trades are
  // not fifty trades' worth of evidence.
  const effective = (side.sumW * side.sumW) / Math.max(side.sumW2, 1e-12);
  // A side where every trade returned the same R has no measured spread, which
  // is not the same as no uncertainty. One R of spread per trade is the floor.
  const spread = Math.max(variance, 0.25);
  return { mean, varianceOfMean: spread / Math.max(effective, 1), effective };
}

function newestFirst(records: SelfLearningMemoryRecord[]): SelfLearningMemoryRecord[] {
  return [...records].sort((a, b) => {
    const ta = Date.parse(a.timestamp ?? '');
    const tb = Date.parse(b.timestamp ?? '');
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return 0;
  });
}

/**
 * How reliable each factor has been, measured on filled trades.
 *
 * Misses are left out: an order that never filled says nothing about whether
 * the direction was right. Rows recorded before votes were kept are left out
 * too, rather than guessed at.
 */
export function factorReliability(
  records: SelfLearningMemoryRecord[],
  /** Trades back at which one counts half. Infinity weighs the whole record evenly. */
  halfLife: number = FACTOR_HALF_LIFE
): FactorReliability[] {
  const usable = newestFirst(records).filter(
    (r) =>
      (r.outcome === 'TP' || r.outcome === 'SL') &&
      r.context?.factorVotes &&
      Number.isFinite(r.context.rMultiple)
  );

  const sides = new Map<string, { agreed: Side; opposed: Side }>();

  usable.forEach((record, index) => {
    const recency = Number.isFinite(halfLife) && halfLife > 0 ? Math.pow(0.5, index / halfLife) : 1;
    const w = recency * verificationWeight(record);
    const r = record.context!.rMultiple;
    const votes = sanitiseFactorVotes(record.context!.factorVotes) ?? {};
    for (const [name, vote] of Object.entries(votes)) {
      if (!sides.has(name)) sides.set(name, { agreed: emptySide(), opposed: emptySide() });
      const entry = sides.get(name)!;
      if (vote > VOTE_DEADZONE) add(entry.agreed, w, r);
      else if (vote < -VOTE_DEADZONE) add(entry.opposed, w, r);
    }
  });

  const out: FactorReliability[] = [];
  for (const [name, { agreed, opposed }] of sides) {
    const a = describe(agreed);
    const o = describe(opposed);
    const base: FactorReliability = {
      name,
      agreedSamples: agreed.count,
      opposedSamples: opposed.count,
      agreedR: a ? parseFloat(a.mean.toFixed(2)) : null,
      opposedR: o ? parseFloat(o.mean.toFixed(2)) : null,
      edge: null,
      strength: null,
      multiplier: 1,
    };

    if (!a || !o) {
      out.push(base);
      continue;
    }

    const edge = a.mean - o.mean;
    const standardError = Math.sqrt(a.varianceOfMean + o.varianceOfMean);
    const strength = standardError > 0 ? edge / standardError : 0;
    base.edge = parseFloat(edge.toFixed(2));
    base.strength = parseFloat(strength.toFixed(2));

    if (agreed.count < MIN_FACTOR_SAMPLES || opposed.count < MIN_FACTOR_SAMPLES) {
      out.push(base);
      continue;
    }

    // Only evidence beyond the noise bar counts, and the move grows with how
    // far beyond it the evidence sits rather than with the raw size of the
    // gap. A small sample produces large gaps by chance; it does not produce
    // a gap many standard errors wide.
    const beyondNoise = Math.max(0, Math.abs(strength) - NOISE_BAR_STANDARD_ERRORS);
    if (beyondNoise === 0) {
      out.push(base);
      continue;
    }

    const smallerSide = Math.min(a.effective, o.effective);
    const confidence = smallerSide / (smallerSide + CONFIDENCE_MIDPOINT);
    const shift = Math.sign(edge) * Math.min(0.5, beyondNoise * STEP_PER_STANDARD_ERROR) * confidence;
    base.multiplier = parseFloat(
      Math.max(FACTOR_MULTIPLIER_MIN, Math.min(FACTOR_MULTIPLIER_MAX, 1 + shift)).toFixed(2)
    );
    out.push(base);
  }

  // Most informative first: the factors that moved, then the rest by sample.
  return out.sort(
    (x, y) =>
      Math.abs(y.multiplier - 1) - Math.abs(x.multiplier - 1) ||
      y.agreedSamples + y.opposedSamples - (x.agreedSamples + x.opposedSamples)
  );
}

/** Only the multipliers that differ from one, which is what the engine applies. */
export function factorMultipliers(reliability: FactorReliability[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const factor of reliability) {
    if (factor.multiplier !== 1) out[factor.name] = factor.multiplier;
  }
  return out;
}

/** A plain sentence for a factor whose say changed, for the dashboard. */
export function describeFactorChange(factor: FactorReliability): string {
  const trades = factor.agreedSamples + factor.opposedSamples;
  if (factor.multiplier < 1) {
    return `${factor.name} kept pointing the wrong way: trades it argued for returned ${factor.agreedR}R, trades it argued against returned ${factor.opposedR}R, over ${trades} trades. Its vote now counts ${factor.multiplier}x.`;
  }
  return `${factor.name} has been reliable: trades it argued for returned ${factor.agreedR}R against ${factor.opposedR}R when it was outvoted, over ${trades} trades. Its vote now counts ${factor.multiplier}x.`;
}

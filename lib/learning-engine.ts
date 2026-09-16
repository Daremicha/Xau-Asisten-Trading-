/**
 * Adaptive learning from closed trades.
 *
 * The previous version summed every stored delta linearly, which meant three
 * missed orders moved a weight by fifteen percentage points while a hundred
 * trades would simply pin it to its clamp. It also treated a trade from last
 * month exactly like this morning's, never lowered a widened stop buffer after
 * a winning run, and learned nothing quantitative from a missed order beyond
 * "nudge the gap weight".
 *
 * This version weights evidence by recency, scales every adjustment by how much
 * evidence actually supports it, keeps the confluence weights a proper
 * distribution, moves the stop buffer in both directions, and learns the actual
 * distance by which pending orders miss.
 */

import { AdaptiveStrategyEngineWeights, SelfLearningMemoryRecord, TradingStyle } from './types';

/** The engine's starting beliefs, used before evidence and shrunk toward. */
export const PRIOR_WEIGHTS = {
  orderBlockWeight: 0.28,
  fairValueGapWeight: 0.24,
  liquiditySweepWeight: 0.22,
  newsImpactWeight: 0.14,
  indicatorConfluenceWeight: 0.12,
  atrBufferFactor: 1.25,
  entryBufferPips: 0,
} as const;

/** Trades older than this many positions back count half as much. */
const RECENCY_HALF_LIFE = 20;
/** Evidence needed before adjustments reach roughly half their full size. */
const CONFIDENCE_MIDPOINT = 8;
/** A single weight may never drift further than this from its prior. */
const MAX_WEIGHT_DRIFT = 0.18;
/** Bounds on the learned stop buffer. */
const ATR_BUFFER_MIN = 0.8;
const ATR_BUFFER_MAX = 2.5;
/** Bound on how far entries may be pulled toward price, in pips. */
const MAX_ENTRY_BUFFER_PIPS = 120;

export interface LearningEvidence {
  /** Every record considered. */
  sampleSize: number;
  /** Sample size after recency weighting, so stale evidence counts for less. */
  effectiveSampleSize: number;
  /** Trades that actually filled and resolved. */
  triggeredCount: number;
  /** Win rate over triggered trades, or null when none have resolved. */
  winRate: number | null;
  /** Win rate pulled toward even odds, so a 1 for 1 start is not called 100%. */
  smoothedWinRate: number | null;
  /** Share of orders that never filled. */
  missRate: number | null;
  /** Typical distance by which pending orders missed, in pips. */
  medianMissPips: number | null;
  /** Zero to one. How much the engine should trust its own adjustments. */
  confidence: number;
}

/** Recency weight for a record, newest first. */
export function recencyWeight(positionFromNewest: number): number {
  return Math.pow(0.5, positionFromNewest / RECENCY_HALF_LIFE);
}

/** Evidence grows with sample size but saturates, so it never reaches certainty. */
export function confidenceFrom(effectiveSampleSize: number): number {
  if (effectiveSampleSize <= 0) return 0;
  return effectiveSampleSize / (effectiveSampleSize + CONFIDENCE_MIDPOINT);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Newest first, so recency weighting has a stable order even without timestamps. */
function newestFirst(records: SelfLearningMemoryRecord[]): SelfLearningMemoryRecord[] {
  return [...records].sort((a, b) => {
    const ta = Date.parse(a.timestamp ?? '');
    const tb = Date.parse(b.timestamp ?? '');
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return 0;
  });
}

/** Summarises what the record set actually supports. */
export function summariseEvidence(records: SelfLearningMemoryRecord[]): LearningEvidence {
  const ordered = newestFirst(records);

  let effective = 0;
  let weightedWins = 0;
  let weightedTriggered = 0;
  let weightedMissed = 0;
  let weightedTotal = 0;
  const missDistances: number[] = [];

  ordered.forEach((record, index) => {
    const w = recencyWeight(index);
    effective += w;
    weightedTotal += w;

    if (record.outcome === 'TP') {
      weightedWins += w;
      weightedTriggered += w;
    } else if (record.outcome === 'SL') {
      weightedTriggered += w;
    } else if (record.outcome === 'MISSED') {
      weightedMissed += w;
      // How far price stayed from the resting order. This is the number that
      // actually tells the engine how much closer to place the next entry.
      const entry = record.entryPrice;
      const away = record.exitPrice;
      if (Number.isFinite(entry) && Number.isFinite(away)) {
        missDistances.push(Math.abs(away - entry) * 10);
      }
    }
  });

  const triggeredCount = records.filter((r) => r.outcome === 'TP' || r.outcome === 'SL').length;
  const rawWinRate = weightedTriggered > 0 ? (weightedWins / weightedTriggered) * 100 : null;

  // Pull toward even odds with two phantom trades, so one lucky win is not
  // reported as a hundred percent strike rate.
  const smoothed =
    weightedTriggered > 0 ? ((weightedWins + 1) / (weightedTriggered + 2)) * 100 : null;

  return {
    sampleSize: records.length,
    effectiveSampleSize: parseFloat(effective.toFixed(2)),
    triggeredCount,
    winRate: rawWinRate === null ? null : parseFloat(rawWinRate.toFixed(1)),
    smoothedWinRate: smoothed === null ? null : parseFloat(smoothed.toFixed(1)),
    missRate: weightedTotal > 0 ? parseFloat(((weightedMissed / weightedTotal) * 100).toFixed(1)) : null,
    medianMissPips: (() => {
      const m = median(missDistances);
      return m === null ? null : parseFloat(m.toFixed(1));
    })(),
    confidence: parseFloat(confidenceFrom(effective).toFixed(3)),
  };
}

/** Moves a value from its prior toward a target, scaled by evidence. */
export function shrinkToward(prior: number, target: number, confidence: number, maxDrift: number): number {
  const desired = (target - prior) * confidence;
  const bounded = Math.max(-maxDrift, Math.min(maxDrift, desired));
  return prior + bounded;
}

/** Rescales the five confluence weights so they remain a proper distribution. */
export function normaliseConfluence(weights: {
  orderBlockWeight: number;
  fairValueGapWeight: number;
  liquiditySweepWeight: number;
  newsImpactWeight: number;
  indicatorConfluenceWeight: number;
}): typeof weights {
  const keys = Object.keys(weights) as (keyof typeof weights)[];
  const total = keys.reduce((acc, k) => acc + Math.max(0.01, weights[k]), 0);
  const out = { ...weights };
  for (const k of keys) out[k] = parseFloat((Math.max(0.01, weights[k]) / total).toFixed(4));
  return out;
}

export interface AdaptiveWeightsWithEvidence extends AdaptiveStrategyEngineWeights {
  /** How many pips closer to price entries should sit, learned from misses. */
  entryBufferPips: number;
  evidence: LearningEvidence;
  /** Plain sentences describing what changed and why. */
  adjustments: string[];
}

/**
 * Derives the engine's current parameters from its trade history.
 *
 * `style` narrows the evidence to trades of that style when enough of them
 * exist, because a swing stop-out says little about a scalp.
 */
export function deriveAdaptiveWeights(
  allRecords: SelfLearningMemoryRecord[],
  style?: TradingStyle
): AdaptiveWeightsWithEvidence {
  // Segment by style only when the segment can carry its own conclusion.
  const segment =
    style === undefined
      ? allRecords
      : (() => {
          const matching = allRecords.filter((r) => inferStyle(r) === style);
          return matching.length >= 5 ? matching : allRecords;
        })();

  const evidence = summariseEvidence(segment);
  const adjustments: string[] = [];

  const confluence: {
    orderBlockWeight: number;
    fairValueGapWeight: number;
    liquiditySweepWeight: number;
    newsImpactWeight: number;
    indicatorConfluenceWeight: number;
  } = {
    orderBlockWeight: PRIOR_WEIGHTS.orderBlockWeight,
    fairValueGapWeight: PRIOR_WEIGHTS.fairValueGapWeight,
    liquiditySweepWeight: PRIOR_WEIGHTS.liquiditySweepWeight,
    newsImpactWeight: PRIOR_WEIGHTS.newsImpactWeight,
    indicatorConfluenceWeight: PRIOR_WEIGHTS.indicatorConfluenceWeight,
  };

  let atrBufferFactor: number = PRIOR_WEIGHTS.atrBufferFactor;
  let entryBufferPips = 0;

  if (evidence.sampleSize > 0) {
    const c = evidence.confidence;

    // Orders that never fill mean entries sit too deep. Shift weight toward the
    // shallower level, and pull entries closer by the distance actually missed.
    if (evidence.missRate !== null && evidence.missRate > 25) {
      confluence.fairValueGapWeight = shrinkToward(
        confluence.fairValueGapWeight,
        confluence.fairValueGapWeight + 0.2,
        c,
        MAX_WEIGHT_DRIFT
      );
      confluence.orderBlockWeight = shrinkToward(
        confluence.orderBlockWeight,
        confluence.orderBlockWeight - 0.15,
        c,
        MAX_WEIGHT_DRIFT
      );
      adjustments.push(
        `${evidence.missRate.toFixed(0)}% of orders never filled, so entries now favour the shallower level.`
      );
    }

    if (evidence.medianMissPips !== null && evidence.medianMissPips > 0) {
      // Close most of the observed gap, scaled by how sure we are of it.
      entryBufferPips = Math.min(MAX_ENTRY_BUFFER_PIPS, evidence.medianMissPips * 0.75 * c);
      if (entryBufferPips >= 1) {
        adjustments.push(
          `Pending orders missed by a median of ${evidence.medianMissPips} pips, so entries move ${entryBufferPips.toFixed(
            0
          )} pips closer to price.`
        );
      }
    }

    // A stop-out rate above chance suggests stops sit inside the noise; a strong
    // strike rate suggests they are wider than they need to be.
    if (evidence.smoothedWinRate !== null && evidence.triggeredCount > 0) {
      const target =
        evidence.smoothedWinRate < 45
          ? PRIOR_WEIGHTS.atrBufferFactor + 0.9
          : evidence.smoothedWinRate > 65
          ? PRIOR_WEIGHTS.atrBufferFactor - 0.35
          : PRIOR_WEIGHTS.atrBufferFactor;

      atrBufferFactor = Math.max(
        ATR_BUFFER_MIN,
        Math.min(ATR_BUFFER_MAX, shrinkToward(PRIOR_WEIGHTS.atrBufferFactor, target, c, 1.25))
      );

      if (Math.abs(atrBufferFactor - PRIOR_WEIGHTS.atrBufferFactor) >= 0.02) {
        adjustments.push(
          atrBufferFactor > PRIOR_WEIGHTS.atrBufferFactor
            ? `Strike rate of ${evidence.smoothedWinRate}% suggests stops sit inside the noise, so the buffer widened to ${atrBufferFactor.toFixed(2)}x ATR.`
            : `Strike rate of ${evidence.smoothedWinRate}% suggests stops are wider than needed, so the buffer tightened to ${atrBufferFactor.toFixed(2)}x ATR.`
        );
      }
    }

    // News weighting rises when losses cluster around scheduled releases.
    const newsLosses = segment.filter(
      (r) => r.outcome === 'SL' && /news|cpi|fomc|nfp|release/i.test(r.rootCauseAnalysis?.primaryFactor ?? '')
    ).length;
    if (newsLosses > 0) {
      const share = newsLosses / Math.max(1, evidence.triggeredCount);
      confluence.newsImpactWeight = shrinkToward(
        confluence.newsImpactWeight,
        confluence.newsImpactWeight + share * 0.3,
        c,
        MAX_WEIGHT_DRIFT
      );
      adjustments.push(`${newsLosses} stop-out(s) traced to scheduled news, so the news shield strengthened.`);
    }
  }

  const normalised = normaliseConfluence(confluence);

  return {
    ...normalised,
    atrBufferFactor: parseFloat(atrBufferFactor.toFixed(2)),
    entryBufferPips: parseFloat(entryBufferPips.toFixed(1)),
    totalAnalysesLearned: allRecords.length,
    // Never report a strike rate the evidence does not support.
    historicalWinRate: evidence.winRate ?? 0,
    evidence,
    adjustments:
      adjustments.length > 0
        ? adjustments
        : evidence.sampleSize === 0
        ? ['No closed trades yet, so the engine is running on its starting parameters.']
        : ['Results so far match expectations, so parameters are unchanged.'],
  };
}

/** Best guess at which style a stored record came from. */
function inferStyle(record: SelfLearningMemoryRecord): TradingStyle | undefined {
  const withStyle = record as SelfLearningMemoryRecord & { tradingStyle?: TradingStyle };
  return withStyle.tradingStyle;
}

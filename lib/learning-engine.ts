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
import { STYLE_PROFILES } from './signal-engine';

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

/**
 * The beliefs a run starts from.
 *
 * Normally this is PRIOR_WEIGHTS, the engine's own defaults. A backtest can
 * hand over the parameters it ended on instead, so live trading starts from
 * what two years of replay actually supported rather than from the defaults,
 * and then keeps learning from real trades on top of that.
 */
export type PriorWeights = {
  orderBlockWeight: number;
  fairValueGapWeight: number;
  liquiditySweepWeight: number;
  newsImpactWeight: number;
  indicatorConfluenceWeight: number;
  atrBufferFactor: number;
  entryBufferPips: number;
};

/**
 * Makes a supplied prior safe to start from: the confluence weights are
 * rescaled into a proper distribution and the rest are clamped into the bounds
 * the engine enforces anyway. Anything unusable falls back to the defaults, so
 * a corrupt stored prior can never distort live analysis.
 */
export function normalisePrior(candidate: Partial<PriorWeights> | null | undefined): PriorWeights {
  if (!candidate || typeof candidate !== 'object') return { ...PRIOR_WEIGHTS };

  const pick = (key: keyof PriorWeights): number | null => {
    const value = candidate[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  };

  const confluence = {
    orderBlockWeight: pick('orderBlockWeight') ?? PRIOR_WEIGHTS.orderBlockWeight,
    fairValueGapWeight: pick('fairValueGapWeight') ?? PRIOR_WEIGHTS.fairValueGapWeight,
    liquiditySweepWeight: pick('liquiditySweepWeight') ?? PRIOR_WEIGHTS.liquiditySweepWeight,
    newsImpactWeight: pick('newsImpactWeight') ?? PRIOR_WEIGHTS.newsImpactWeight,
    indicatorConfluenceWeight:
      pick('indicatorConfluenceWeight') ?? PRIOR_WEIGHTS.indicatorConfluenceWeight,
  };

  const atr = pick('atrBufferFactor');
  const buffer = pick('entryBufferPips');

  return {
    ...normaliseConfluence(confluence),
    atrBufferFactor:
      atr === null ? PRIOR_WEIGHTS.atrBufferFactor : Math.max(ATR_BUFFER_MIN, Math.min(ATR_BUFFER_MAX, atr)),
    entryBufferPips: buffer === null ? 0 : Math.min(MAX_ENTRY_BUFFER_PIPS, buffer),
  };
}

/** Trades older than this many positions back count half as much. */
const RECENCY_HALF_LIFE = 20;
/** Evidence needed before adjustments reach roughly half their full size. */
const CONFIDENCE_MIDPOINT = 8;
/** A single weight may never drift further than this from its prior. */
const MAX_WEIGHT_DRIFT = 0.18;
/** Bounds on the learned stop buffer. */
const ATR_BUFFER_MIN = 0.8;
const ATR_BUFFER_MAX = 2.5;
/** Hard bound on how far entries may be pulled toward price, in pips. */
const MAX_ENTRY_BUFFER_PIPS = 120;

/**
 * Share of the style's own stop ceiling that an entry may be dragged away from
 * the level that justified it.
 *
 * A flat 120 pip allowance let an intraday entry move two thirds of its maximum
 * risk distance, at which point the order no longer sits at the order block or
 * gap it was derived from: it just sits near price. A backtest over two years
 * of real candles showed exactly that, filling a third more orders and earning
 * less than the control while tripling the drawdown.
 */
const MAX_BUFFER_SHARE_OF_STOP = 0.4;

/**
 * The strike rate a style needs just to break even.
 *
 * A target at 1.5R pays out on four wins in ten; at 2R, on one in three. Judging
 * every style against a flat 45% therefore reads a perfectly healthy intraday
 * system as broken. A 24 month replay of real candles did exactly that: a
 * profitable run at 44.2% was diagnosed as "stops sit inside the noise", the
 * buffer widened to 1.96x ATR, and freezing that cost 410.90 cent and took the
 * worst drawdown from 22% to 29.6%.
 */
export function breakEvenWinRate(style?: TradingStyle): number {
  // The app's own default style, for a record set that never said which it was.
  const profile = STYLE_PROFILES[style ?? 'Intraday'];
  return parseFloat((100 / (1 + profile.tpMultiples[0])).toFixed(1));
}

/** Margin above break even that says the stop has more room than it needs. */
const COMFORTABLE_MARGIN_POINTS = 20;

/** The furthest an entry may be pulled toward price for a given style. */
export function entryBufferCeiling(style?: TradingStyle): number {
  const profile = style ? STYLE_PROFILES[style] : undefined;
  if (!profile) return MAX_ENTRY_BUFFER_PIPS;
  return Math.min(MAX_ENTRY_BUFFER_PIPS, profile.maxStopDollars * 10 * MAX_BUFFER_SHARE_OF_STOP);
}

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
  /**
   * Recency weighted money result of an average filled trade.
   *
   * This is the number that decides whether chasing fills is worth anything. An
   * order that never filled cost nothing; a bad fill cost real money. Pulling
   * entries closer to price converts misses into fills, so it only pays when a
   * filled trade is worth having in the first place.
   */
  expectancyDollars: number | null;
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

/**
 * Oldest first, which is the order everything outside this module assumes.
 *
 * Firestore returns the most recent trades first, because that is the cheap
 * query, and the app was storing that order as-is. The ledger then reversed it
 * into oldest-first, and the equity curve replayed a signed-in account's
 * history backwards. Normalising here means no caller has to know which way a
 * particular source happened to hand its rows over.
 */
export function chronological(records: SelfLearningMemoryRecord[]): SelfLearningMemoryRecord[] {
  return [...records].sort((a, b) => {
    const ta = Date.parse(a.timestamp ?? '');
    const tb = Date.parse(b.timestamp ?? '');
    // A record without a usable timestamp keeps its position rather than being
    // thrown to one end of the ledger.
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
    return ta - tb;
  });
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
  let weightedPnl = 0;
  const missDistances: number[] = [];

  ordered.forEach((record, index) => {
    const w = recencyWeight(index);
    effective += w;
    weightedTotal += w;

    if (record.outcome === 'TP') {
      weightedWins += w;
      weightedTriggered += w;
      weightedPnl += w * (Number.isFinite(record.profitOrLossDollars) ? record.profitOrLossDollars : 0);
    } else if (record.outcome === 'SL') {
      weightedTriggered += w;
      weightedPnl += w * (Number.isFinite(record.profitOrLossDollars) ? record.profitOrLossDollars : 0);
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
    expectancyDollars:
      weightedTriggered > 0 ? parseFloat((weightedPnl / weightedTriggered).toFixed(4)) : null,
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
 * True when a set of parameters is the engine's own defaults.
 *
 * A learning run that finds nothing worth changing ends exactly where it
 * started, and offering those back as something to adopt is a button that does
 * nothing. Saying so is more useful than letting the user press it.
 */
export function matchesDefaultPrior(candidate: Partial<PriorWeights> | null | undefined): boolean {
  const prior = normalisePrior(candidate);
  const defaults = normalisePrior(null);

  const weightKeys = [
    'orderBlockWeight',
    'fairValueGapWeight',
    'liquiditySweepWeight',
    'newsImpactWeight',
    'indicatorConfluenceWeight',
  ] as const;

  // Half a percentage point of weight, a hundredth of an ATR multiple and half
  // a pip: below these nothing the engine does with them would differ.
  const sameWeights = weightKeys.every((key) => Math.abs(prior[key] - defaults[key]) < 0.005);
  const sameBuffer = Math.abs(prior.atrBufferFactor - defaults.atrBufferFactor) < 0.01;
  const sameEntry = Math.abs(prior.entryBufferPips - defaults.entryBufferPips) < 0.5;

  return sameWeights && sameBuffer && sameEntry;
}

/**
 * Derives the engine's current parameters from its trade history.
 *
 * `style` narrows the evidence to trades of that style when enough of them
 * exist, because a swing stop-out says little about a scalp.
 */
export function deriveAdaptiveWeights(
  allRecords: SelfLearningMemoryRecord[],
  style?: TradingStyle,
  startingPrior?: Partial<PriorWeights> | null
): AdaptiveWeightsWithEvidence {
  // Everything below shrinks toward this. It is the engine's own defaults
  // unless a backtest has handed over what it ended on.
  const prior = normalisePrior(startingPrior);
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
    orderBlockWeight: prior.orderBlockWeight,
    fairValueGapWeight: prior.fairValueGapWeight,
    liquiditySweepWeight: prior.liquiditySweepWeight,
    newsImpactWeight: prior.newsImpactWeight,
    indicatorConfluenceWeight: prior.indicatorConfluenceWeight,
  };

  let atrBufferFactor: number = prior.atrBufferFactor;
  // A buffer can only arrive from an adopted backtest, and the style caps how
  // far it may move an entry off the level the entry was derived from.
  let entryBufferPips = Math.min(entryBufferCeiling(style), prior.entryBufferPips);

  if (evidence.sampleSize > 0) {
    const c = evidence.confidence;

    // Misses are not a problem to solve.
    //
    // The engine used to read a high miss rate as "entries sit too deep" and
    // answer by shifting weight to the shallower level and pulling entries
    // toward price. A 24 month replay of real XAUUSD candles isolated exactly
    // those two adaptations, because they were the only thing that had moved,
    // froze them and traded the period again: they earned less than the engine
    // defaults and raised the worst drawdown from 22% to 31.6%.
    //
    // The reason is in the arithmetic, not the sample. Pulling an entry closer
    // converts the misses nearest the level into fills, and those are the
    // marginal setups, not the average one. An engine can see the average
    // result of a fill; it cannot see the result of the fills it did not take.
    // A missed order costs nothing, so the safe side of that uncertainty is to
    // leave entries on their levels.
    //
    // A buffer adopted from a backtest is still honoured, unchanged: that is
    // evidence the engine itself cannot gather.

    if (evidence.missRate !== null && evidence.missRate > 25 && evidence.sampleSize >= 5) {
      adjustments.push(
        `${evidence.missRate.toFixed(
          0
        )}% of orders never filled. A missed order costs nothing, so entries stay on their levels; if you want more fills, change the style or the timeframe rather than the entry.`
      );
    }

    // Stops are only wrong when the strike rate cannot pay for the target.
    //
    // The measure is the style's own break even rate, not a flat number: a 1.5R
    // target needs 40%, a 2R target needs 33%. Widening also has to be answering
    // a real problem, so the account must actually be losing money. A profitable
    // run below the old flat threshold used to have its stops widened for no
    // reason, which cost money and deepened the drawdown.
    const breakEven = breakEvenWinRate(style);
    const losingMoney = evidence.expectancyDollars !== null && evidence.expectancyDollars <= 0;

    if (evidence.smoothedWinRate !== null && evidence.triggeredCount > 0) {
      const target =
        evidence.smoothedWinRate < breakEven && losingMoney
          ? prior.atrBufferFactor + 0.9
          : evidence.smoothedWinRate > breakEven + COMFORTABLE_MARGIN_POINTS
          ? prior.atrBufferFactor - 0.35
          : prior.atrBufferFactor;

      atrBufferFactor = Math.max(
        ATR_BUFFER_MIN,
        Math.min(ATR_BUFFER_MAX, shrinkToward(prior.atrBufferFactor, target, c, 1.25))
      );

      if (Math.abs(atrBufferFactor - prior.atrBufferFactor) >= 0.02) {
        adjustments.push(
          atrBufferFactor > prior.atrBufferFactor
            ? `A ${evidence.smoothedWinRate}% strike rate is below the ${breakEven}% this target needs and the account is losing, so stops widened to ${atrBufferFactor.toFixed(
                2
              )}x ATR to clear the noise.`
            : `A ${evidence.smoothedWinRate}% strike rate is comfortably above the ${breakEven}% this target needs, so stops tightened to ${atrBufferFactor.toFixed(
                2
              )}x ATR.`
        );
      } else if (evidence.smoothedWinRate < 50 && evidence.triggeredCount >= 10) {
        adjustments.push(
          `A ${evidence.smoothedWinRate}% strike rate is normal for a ${
            style ?? 'Intraday'
          } target that pays ${(100 / breakEven - 1).toFixed(1)} to 1, which breaks even at ${breakEven}%. Nothing is changed for it.`
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

/**
 * Turns market structure into an executable order.
 *
 * The adaptive weights are load bearing here. They decide which point of
 * interest the entry is anchored to, how wide the stop sits, and how much
 * conviction each confluence contributes. Feeding different weights in must
 * produce a different order, which is what makes the learning loop real.
 */

import { Candle, priceToPips, round2 } from './candles';
import { selectTargets } from './target-engine';
import {
  AdaptiveStrategyEngineWeights,
  ForexFactoryEvent,
  OrderExecutionType,
  QuasimodoPattern,
  SmcStructure,
  TechnicalIndicators,
  TradingCentralInsight,
  TradingStyle,
  WyckoffVolumeAnalysis,
} from './types';

export interface StyleProfile {
  /** Minimum stop distance in dollars, before the ATR buffer is added. */
  minStopDollars: number;
  /**
   * Maximum stop distance in dollars. Without a ceiling a long run of stop outs
   * pushes the learned ATR buffer up until an intraday order carries a swing
   * sized stop, which is not the style the trader selected.
   */
  maxStopDollars: number;
  /** Stop distance as a multiple of ATR. */
  atrStopMultiple: number;
  /** Reward multiples applied to the final risk distance. */
  tpMultiples: [number, number, number];
  /** How far from price an entry may sit before it becomes a market order. */
  instantToleranceDollars: number;
  /**
   * Furthest a pending entry may sit from live price, as a multiple of ATR.
   * A point of interest beyond this is a real level but not a fillable one for
   * this style: an intraday order parked three ATR away simply will not trade
   * before the session ends.
   */
  maxEntryAtrMultiple: number;
  /** Floor for the same limit, so an unusually quiet market stays tradeable. */
  minEntryReachDollars: number;
  label: string;
}

export const STYLE_PROFILES: Record<TradingStyle, StyleProfile> = {
  Scalping: {
    minStopDollars: 1.8,
    maxStopDollars: 7.0,
    atrStopMultiple: 0.6,
    tpMultiples: [1.2, 2.0, 3.2],
    instantToleranceDollars: 0.5,
    maxEntryAtrMultiple: 0.8,
    minEntryReachDollars: 2.0,
    label: 'M15 / M5 precision scalp',
  },
  Intraday: {
    minStopDollars: 4.5,
    maxStopDollars: 18.0,
    atrStopMultiple: 1.0,
    tpMultiples: [1.5, 2.6, 4.0],
    instantToleranceDollars: 1.2,
    maxEntryAtrMultiple: 1.5,
    minEntryReachDollars: 6.0,
    label: 'H1 / M15 session play',
  },
  Swing: {
    minStopDollars: 12.0,
    maxStopDollars: 60.0,
    atrStopMultiple: 2.0,
    tpMultiples: [2.0, 3.6, 6.0],
    instantToleranceDollars: 4.0,
    maxEntryAtrMultiple: 3.0,
    minEntryReachDollars: 20.0,
    label: 'D1 / H4 macro swing',
  },
};

export interface ConfluenceFactor {
  name: string;
  /** Positive votes long, negative votes short, magnitude is raw strength. */
  direction: number;
  weight: number;
  detail: string;
}

export interface SignalDecision {
  orderType: OrderExecutionType;
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  stopLossPips: number;
  riskRewardRatio: string;
  /** Zero to one hundred, how much weighted confluence backed this direction. */
  confidenceScore: number;
  /** True when the learned buffer was trimmed to the style's maximum stop. */
  stopWasCapped: boolean;
  /** How far price must travel to reach the entry. */
  entryDistancePips: number;
  /**
   * True when no point of interest was within the style's reach, so the order
   * may not fill inside the intended holding period.
   */
  entryOutOfReach: boolean;
  anchor: 'Order Block' | 'Fair Value Gap' | 'Market';
  /** Why each target sits where it does, in target order. */
  targetBasis: string[];
  /** Reward to risk on the first target, measured from where it landed. */
  targetRiskReward: number;
  /** True when no level was reachable, so the targets used the typical range. */
  targetsFellBack: boolean;
  factors: ConfluenceFactor[];
  rationale: string;
}

export interface SignalInputs {
  price: number;
  structures: { d1: SmcStructure; h4: SmcStructure; h1: SmcStructure; m15: SmcStructure };
  indicators: TechnicalIndicators;
  weights: AdaptiveStrategyEngineWeights;
  tradingStyle: TradingStyle;
  /** Execution timeframe candles, used for structural invalidation levels. */
  candles: Candle[];
  killZoneActive: boolean;
  upcomingHighImpactEvents: ForexFactoryEvent[];
  /** Minutes until the next high impact release, when one is scheduled. */
  minutesToNextEvent: number | null;
  /**
   * Pivot levels and the directional bias derived from them. Shown on the
   * screen since the first version, but until now the engine never read it.
   */
  pivotBias?: TradingCentralInsight | null;
  /** Accumulation, markup, distribution or markdown, with its volume evidence. */
  wyckoff?: WyckoffVolumeAnalysis | null;
  /** The liquidity sweep and break pattern, when one has formed. */
  quasimodo?: QuasimodoPattern | null;
}

function trendVote(trend: SmcStructure['trend']): number {
  if (trend === 'Bullish') return 1;
  if (trend === 'Bearish') return -1;
  return 0;
}

/**
 * Weighted confluence vote. Each factor is scaled by the weight the learning
 * engine currently assigns to that concept, so the weights steer direction.
 */
export function scoreConfluence(inputs: SignalInputs): {
  score: number;
  factors: ConfluenceFactor[];
} {
  const { structures, indicators, weights, price } = inputs;
  const exec = structures.h1;
  const factors: ConfluenceFactor[] = [];

  // Higher timeframe bias carries the most authority in a top down model.
  const htfVote = trendVote(structures.d1.trend) * 0.5 + trendVote(structures.h4.trend) * 0.3;
  factors.push({
    name: 'Higher timeframe order flow',
    direction: htfVote,
    weight: 1,
    detail: `D1 ${structures.d1.trend}, H4 ${structures.h4.trend}.`,
  });

  const obBullish = exec.orderBlock.type === 'Bullish OB';
  const obVote = (obBullish ? 1 : -1) * (exec.orderBlock.mitigated ? 0.4 : 1);
  factors.push({
    name: 'Order block',
    direction: obVote,
    weight: weights.orderBlockWeight,
    detail: `${exec.orderBlock.type} at ${exec.orderBlock.low.toFixed(2)} to ${exec.orderBlock.high.toFixed(
      2
    )}, ${exec.orderBlock.mitigated ? 'already mitigated' : 'unmitigated'}.`,
  });

  const fvgBullish = exec.fairValueGap.type === 'Bullish FVG';
  const fvgVote = exec.fairValueGap.detected
    ? (fvgBullish ? 1 : -1) * (exec.fairValueGap.status === 'Open' ? 1 : 0.5)
    : 0;
  factors.push({
    name: 'Fair value gap',
    direction: fvgVote,
    weight: weights.fairValueGapWeight,
    detail: exec.fairValueGap.detected
      ? `${exec.fairValueGap.type} ${exec.fairValueGap.bottom.toFixed(2)} to ${exec.fairValueGap.top.toFixed(
          2
        )}, status ${exec.fairValueGap.status}.`
      : 'No unmitigated imbalance on the execution timeframe.',
  });

  // A swept low is a bullish signal: sell side liquidity has been taken.
  const pools = exec.liquidityPools;
  const sweptLow = pools.swept && price > pools.pdl && pools.sweepDetail?.includes('Low');
  const sweptHigh = pools.swept && price < pools.pdh && pools.sweepDetail?.includes('High');
  const sweepVote = sweptLow ? 1 : sweptHigh ? -1 : 0;
  factors.push({
    name: 'Liquidity sweep',
    direction: sweepVote,
    weight: weights.liquiditySweepWeight,
    detail: pools.sweepDetail ?? 'No pool taken.',
  });

  // Moving average structure, read as a stack rather than a single line. EMA 50
  // was computed and then ignored; the relationship between the two averages,
  // and where price sits against each, is the part that carries information.
  const aboveFast = price > indicators.ema50;
  const aboveSlow = price > indicators.ema200;
  const fastAboveSlow = indicators.ema50 > indicators.ema200;

  let emaVote = 0;
  let emaDescription: string;
  if (aboveFast && aboveSlow && fastAboveSlow) {
    emaVote = 1;
    emaDescription = 'Price above both averages with EMA 50 over EMA 200, a fully stacked uptrend.';
  } else if (!aboveFast && !aboveSlow && !fastAboveSlow) {
    emaVote = -1;
    emaDescription = 'Price below both averages with EMA 50 under EMA 200, a fully stacked downtrend.';
  } else if (aboveSlow && !aboveFast) {
    // Pulling back inside the stack: the trend holds but momentum has paused.
    emaVote = 0.4;
    emaDescription = 'Price has pulled back below EMA 50 while holding above EMA 200, a retracement inside an uptrend.';
  } else if (!aboveSlow && aboveFast) {
    emaVote = -0.4;
    emaDescription = 'Price has bounced above EMA 50 while capped below EMA 200, a retracement inside a downtrend.';
  } else {
    emaVote = fastAboveSlow ? 0.2 : -0.2;
    emaDescription = 'The moving averages disagree with price, so trend structure is unresolved.';
  }
  factors.push({
    name: 'EMA structure',
    direction: emaVote,
    weight: weights.indicatorConfluenceWeight,
    detail: `${emaDescription} EMA 50 ${indicators.ema50.toFixed(2)}, EMA 200 ${indicators.ema200.toFixed(2)}.`,
  });

  // RSI, graded rather than a single threshold, and read against the trend.
  // An extreme reading argues against chasing the move, not for it.
  const rsi = indicators.rsi14;
  let rsiVote: number;
  let rsiDescription: string;
  if (rsi >= 70) {
    rsiVote = -0.6;
    rsiDescription = `RSI ${rsi.toFixed(1)} is overbought, which argues against buying an extended move.`;
  } else if (rsi <= 30) {
    rsiVote = 0.6;
    rsiDescription = `RSI ${rsi.toFixed(1)} is oversold, which argues against selling an extended move.`;
  } else {
    // Between the extremes it is a momentum reading, scaled by distance from 50.
    rsiVote = ((rsi - 50) / 20) * 0.6;
    rsiDescription = `RSI ${rsi.toFixed(1)} leans ${rsi > 50 ? 'bullish' : rsi < 50 ? 'bearish' : 'neutral'}.`;
  }
  if (indicators.rsiCondition === 'Bullish Divergence') {
    rsiVote += 0.5;
    rsiDescription += ' A bullish divergence is present.';
  } else if (indicators.rsiCondition === 'Bearish Divergence') {
    rsiVote -= 0.5;
    rsiDescription += ' A bearish divergence is present.';
  }
  factors.push({
    name: 'RSI',
    direction: rsiVote,
    weight: weights.indicatorConfluenceWeight,
    detail: rsiDescription,
  });

  const stochVote =
    indicators.stochasticSignal === 'Oversold Cross' ? 0.5 : indicators.stochasticSignal === 'Overbought Cross' ? -0.5 : 0;
  factors.push({
    name: 'Stochastic',
    direction: stochVote,
    weight: weights.indicatorConfluenceWeight * 0.6,
    detail: `Stochastic ${indicators.stochasticK.toFixed(1)} over ${indicators.stochasticD.toFixed(
      1
    )}, reading ${indicators.stochasticSignal}.`,
  });

  // Discount favours longs, premium favours shorts.
  const zoneVote = exec.pricingZone === 'Discount' ? 0.6 : exec.pricingZone === 'Premium' ? -0.6 : 0;
  factors.push({
    name: 'Premium and discount',
    direction: zoneVote,
    weight: weights.liquiditySweepWeight,
    detail: `Price sits in the ${exec.pricingZone} half of its dealing range.`,
  });

  // Pivot and directional bias. The daily pivot is where the previous session
  // settled, so which side of it price is trading on is a real piece of
  // information, and one the screen has always shown.
  if (inputs.pivotBias) {
    const bias = inputs.pivotBias;
    const abovePivot = price > bias.pivotPoint;
    const biasVote = bias.directionalBias === 'BULLISH' ? 1 : bias.directionalBias === 'BEARISH' ? -1 : 0;
    // Agreement between the stated bias and where price actually sits counts
    // for more than either alone.
    const pivotVote = biasVote === 0 ? (abovePivot ? 0.4 : -0.4) : biasVote * (abovePivot === biasVote > 0 ? 1 : 0.4);

    factors.push({
      name: 'Pivot and directional bias',
      direction: pivotVote,
      // Read as structure rather than as an indicator: it is a level, not an
      // oscillator, so it shares the weight the engine gives to levels.
      weight: weights.liquiditySweepWeight * 0.8,
      detail: `Price ${abovePivot ? 'above' : 'below'} the ${bias.pivotPoint.toFixed(2)} pivot with a ${
        bias.directionalBias
      } read at ${bias.confidenceScore}% confidence.`,
    });
  }

  // Wyckoff phase. Accumulation and markup favour longs, distribution and
  // markdown favour shorts, and absorption at a climax argues the phase is real.
  if (inputs.wyckoff) {
    const phase = inputs.wyckoff.phase;
    const base = phase === 'Accumulation' || phase === 'Markup' ? 1 : -1;
    const conviction = inputs.wyckoff.absorptionPresent || inputs.wyckoff.volumeClimaxDetected ? 0.8 : 0.5;

    factors.push({
      name: 'Wyckoff phase',
      direction: base * conviction,
      weight: weights.orderBlockWeight * 0.5,
      detail: `${phase} phase with the point of control at ${inputs.wyckoff.pointOfControlPOC.toFixed(2)}${
        inputs.wyckoff.absorptionPresent ? ', absorption present' : ''
      }.`,
    });
  }

  // Quasimodo. Only a pattern that actually formed votes; an absent one is
  // silence rather than a vote for the other side.
  if (inputs.quasimodo?.detected) {
    factors.push({
      name: 'Quasimodo',
      direction: inputs.quasimodo.type === 'Bullish QM' ? 0.9 : -0.9,
      weight: weights.liquiditySweepWeight * 0.6,
      detail: `${inputs.quasimodo.type} after the sweep at ${inputs.quasimodo.headLiquiditySweep.toFixed(
        2
      )}, optimal entry near ${inputs.quasimodo.optimalEntryZone.toFixed(2)}.`,
    });
  }

  const score = factors.reduce((acc, f) => acc + f.direction * f.weight, 0);
  return { score, factors };
}

/**
 * Chooses the entry anchor. The learning engine's relative preference between
 * order blocks and imbalances decides which point of interest is used, so a run
 * of missed limit orders can genuinely shift entries toward the gap midpoint.
 */
interface EntryCandidate {
  price: number;
  anchor: 'Order Block' | 'Fair Value Gap';
  /** How much the learning engine currently trusts this kind of level. */
  weight: number;
  detail: string;
}

/** Furthest a pending entry may sit from price for this style and volatility. */
export function maxEntryDistance(profile: StyleProfile, atr: number): number {
  return Math.max(profile.minEntryReachDollars, atr * profile.maxEntryAtrMultiple);
}

/**
 * Chooses where to place the entry.
 *
 * Each point of interest offers two entries: its mean threshold, the textbook
 * level, and its near edge, which fills sooner. Both are offered so a level
 * whose midpoint is out of reach can still be traded at its edge.
 *
 * Candidates beyond the style's reach are discarded, because an order that will
 * not fill inside the intended holding period is not a usable signal. When
 * nothing is in reach the nearest candidate is returned and flagged, so the
 * caller can say plainly that price has run away from its levels.
 */
export function selectEntry(
  inputs: SignalInputs,
  direction: 'long' | 'short'
): { price: number; anchor: SignalDecision['anchor']; detail: string; outOfReach: boolean } {
  const exec = inputs.structures.h1;
  const { weights, price, indicators } = inputs;
  const profile = STYLE_PROFILES[inputs.tradingStyle];
  const reach = maxEntryDistance(profile, indicators.atr14);

  const candidates: EntryCandidate[] = [];
  const isLong = direction === 'long';

  // Orders that kept missing taught the engine how many pips too deep they sat.
  // Every candidate is pulled that much toward price, but never past it.
  const learnedBuffer = Math.max(0, weights.entryBufferPips ?? 0) / 10;
  const pullTowardPrice = (level: number) => {
    const shifted = isLong ? level + learnedBuffer : level - learnedBuffer;
    return isLong ? Math.min(shifted, price) : Math.max(shifted, price);
  };

  // A level is only usable if it sits on the retracement side of price.
  const obNear = isLong ? exec.orderBlock.high : exec.orderBlock.low;
  const obMid = (exec.orderBlock.high + exec.orderBlock.low) / 2;
  if (isLong ? obNear < price : obNear > price) {
    candidates.push({
      price: round2(pullTowardPrice(obMid)),
      anchor: 'Order Block',
      weight: weights.orderBlockWeight,
      detail: `Entry at the mean threshold of the ${exec.orderBlock.type}.${
        learnedBuffer > 0
          ? ` Pulled ${priceToPips(learnedBuffer)} pips toward price, learned from orders that did not fill.`
          : ''
      }`,
    });
    candidates.push({
      price: round2(pullTowardPrice(obNear)),
      anchor: 'Order Block',
      // The edge is a shallower fill, so it carries slightly less conviction.
      weight: weights.orderBlockWeight * 0.9,
      detail: `Entry at the near edge of the ${exec.orderBlock.type}, which fills earlier than its mean threshold.`,
    });
  }

  if (exec.fairValueGap.detected) {
    const fvgNear = isLong ? exec.fairValueGap.top : exec.fairValueGap.bottom;
    const fvgMid = (exec.fairValueGap.top + exec.fairValueGap.bottom) / 2;
    if (isLong ? fvgNear < price : fvgNear > price) {
      candidates.push({
        price: round2(pullTowardPrice(fvgMid)),
        anchor: 'Fair Value Gap',
        weight: weights.fairValueGapWeight,
        detail: `Entry at the 50 percent consequent encroachment of the ${exec.fairValueGap.type}.`,
      });
      candidates.push({
        price: round2(pullTowardPrice(fvgNear)),
        anchor: 'Fair Value Gap',
        weight: weights.fairValueGapWeight * 0.9,
        detail: `Entry at the near edge of the ${exec.fairValueGap.type}, which fills earlier than its 50 percent level.`,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      price: round2(price),
      anchor: 'Market',
      detail: 'No unmitigated point of interest on the retracement side of price, so execution is at market.',
      outOfReach: false,
    };
  }

  const distanceOf = (c: EntryCandidate) => Math.abs(price - c.price);
  const inReach = candidates.filter((c) => distanceOf(c) <= reach);

  // Trust first, then proximity: among levels the engine rates equally, take
  // the one price has to travel least far to reach.
  const rank = (a: EntryCandidate, b: EntryCandidate) =>
    b.weight - a.weight || distanceOf(a) - distanceOf(b);

  if (inReach.length > 0) {
    const best = [...inReach].sort(rank)[0];
    return { price: best.price, anchor: best.anchor, detail: best.detail, outOfReach: false };
  }

  const nearest = [...candidates].sort((a, b) => distanceOf(a) - distanceOf(b))[0];
  return {
    price: nearest.price,
    anchor: nearest.anchor,
    detail: `${nearest.detail} Price is currently ${priceToPips(
      distanceOf(nearest)
    )} pips away, beyond the ${inputs.tradingStyle} reach of ${priceToPips(reach)} pips, so this order may not fill within the intended holding period.`,
    outOfReach: true,
  };
}

/** Resolves the order type from where the entry sits relative to live price. */
export function resolveOrderType(
  direction: 'long' | 'short',
  entry: number,
  price: number,
  tolerance: number
): OrderExecutionType {
  const delta = entry - price;
  if (Math.abs(delta) <= tolerance) return direction === 'long' ? 'BUY INSTANT' : 'SELL INSTANT';
  if (direction === 'long') return delta < 0 ? 'BUY LIMIT' : 'BUY STOP';
  return delta > 0 ? 'SELL LIMIT' : 'SELL STOP';
}

/** Builds the complete order from structure, indicators and adaptive weights. */
export function buildSignal(inputs: SignalInputs): SignalDecision {
  const { price, indicators, weights, tradingStyle, structures } = inputs;
  const profile = STYLE_PROFILES[tradingStyle];

  const { score, factors } = scoreConfluence(inputs);
  const direction: 'long' | 'short' = score >= 0 ? 'long' : 'short';

  const entry = selectEntry(inputs, direction);
  const entryPrice = entry.price;

  // Structural invalidation: beyond the point of interest that defines the idea.
  const exec = structures.h1;
  const structuralStop =
    direction === 'long'
      ? Math.min(exec.orderBlock.low, exec.liquidityPools.asiaLow, entryPrice)
      : Math.max(exec.orderBlock.high, exec.liquidityPools.asiaHigh, entryPrice);

  // The learned ATR buffer widens the stop after stop outs, and the news weight
  // widens it further when a high impact release is close.
  const newsProximityFactor =
    inputs.minutesToNextEvent !== null && inputs.minutesToNextEvent <= 60
      ? 1 + weights.newsImpactWeight * 2
      : 1;
  const atrBuffer = indicators.atr14 * profile.atrStopMultiple * weights.atrBufferFactor * newsProximityFactor;

  let stopLoss =
    direction === 'long' ? structuralStop - atrBuffer : structuralStop + atrBuffer;

  // Clamp the stop into the band the chosen style allows. The floor keeps it
  // clear of spread and noise; the ceiling stops a long losing run from turning
  // a scalp into a swing trade.
  const minStop = profile.minStopDollars * newsProximityFactor;
  // The ceiling is an absolute property of the style. News widens the stop
  // inside the band, never past it: if an event genuinely needs more room than
  // the style allows, the honest answer is that the style does not fit the
  // moment, not that an intraday trade should carry a swing sized stop.
  const maxStop = profile.maxStopDollars;
  const rawDistance = Math.abs(entryPrice - stopLoss);
  const clampedDistance = Math.min(maxStop, Math.max(minStop, rawDistance));
  const stopWasCapped = clampedDistance < rawDistance - 0.005;
  stopLoss = round2(direction === 'long' ? entryPrice - clampedDistance : entryPrice + clampedDistance);

  const riskDistance = Math.abs(entryPrice - stopLoss);

  // Targets sit on levels price has a reason to stop at, inside the distance a
  // move of this style routinely covers, rather than at multiples of the stop.
  // A target at 2.6 times the risk is a description of the trade; it says
  // nothing about whether price goes there.
  const targets = selectTargets({
    entry: entryPrice,
    stop: stopLoss,
    direction,
    tradingStyle,
    atr: indicators.atr14,
    structures,
    candles: inputs.candles,
    pivotBias: inputs.pivotBias,
    quasimodo: inputs.quasimodo,
  });
  const { takeProfit1, takeProfit2, takeProfit3 } = targets;

  const orderType = resolveOrderType(direction, entryPrice, price, profile.instantToleranceDollars);

  // Confidence: weighted agreement normalised against the total weight on the table.
  const totalWeight = factors.reduce((acc, f) => acc + f.weight * Math.max(1, Math.abs(f.direction)), 0);
  const rawConfidence = (Math.abs(score) / Math.max(totalWeight, 0.0001)) * 100;
  // An order that may never fill deserves less conviction than one at a level
  // price is about to revisit.
  const confidenceScore = Math.round(
    Math.min(100, Math.max(0, entry.outOfReach ? rawConfidence * 0.6 : rawConfidence))
  );

  const agreeing = factors.filter((f) => (direction === 'long' ? f.direction > 0 : f.direction < 0));
  const opposing = factors.filter((f) => (direction === 'long' ? f.direction < 0 : f.direction > 0));

  const rationale = [
    `${direction === 'long' ? 'Long' : 'Short'} bias on the ${profile.label}.`,
    entry.detail,
    `Supporting confluence: ${agreeing.map((f) => f.name).join(', ') || 'none'}.`,
    opposing.length ? `Conflicting signals: ${opposing.map((f) => f.name).join(', ')}.` : 'No conflicting signal.',
    `Stop sits beyond structural invalidation with a ${weights.atrBufferFactor.toFixed(
      2
    )}x learned ATR buffer of ${round2(atrBuffer).toFixed(2)} dollars.`,
    inputs.killZoneActive ? 'Execution falls inside an institutional kill zone.' : 'Execution is outside the primary kill zones.',
    inputs.minutesToNextEvent !== null && inputs.minutesToNextEvent <= 60
      ? `A high impact release lands in about ${Math.round(inputs.minutesToNextEvent)} minutes, so risk parameters are widened.`
      : 'No high impact release inside the next hour.',
    stopWasCapped
      ? `The learned buffer asked for a wider stop than the ${tradingStyle} ceiling of ${profile.maxStopDollars.toFixed(
          2
        )} dollars, so it was capped. Consider a longer timeframe style if stop outs keep recurring.`
      : '',
    entry.outOfReach
      ? 'Price has extended beyond every point of interest this style can reach, so treat this as a level to watch rather than an order to leave working.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    orderType,
    direction,
    entryPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    takeProfit3,
    stopLossPips: priceToPips(riskDistance),
    // Measured from where the target actually landed, not from the multiple it
    // was supposed to be.
    riskRewardRatio: targets.riskReward > 0 ? `1:${targets.riskReward.toFixed(2)}` : '1:0',
    targetBasis: targets.basis,
    targetRiskReward: targets.riskReward,
    targetsFellBack: targets.usedFallback,
    confidenceScore,
    stopWasCapped,
    entryDistancePips: priceToPips(price - entryPrice),
    entryOutOfReach: entry.outOfReach,
    anchor: entry.anchor,
    factors,
    rationale,
  };
}

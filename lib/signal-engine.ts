/**
 * Turns market structure into an executable order.
 *
 * The adaptive weights are load bearing here. They decide which point of
 * interest the entry is anchored to, how wide the stop sits, and how much
 * conviction each confluence contributes. Feeding different weights in must
 * produce a different order, which is what makes the learning loop real.
 */

import { Candle, priceToPips, round2 } from './candles';
import {
  AdaptiveStrategyEngineWeights,
  ForexFactoryEvent,
  OrderExecutionType,
  SmcStructure,
  TechnicalIndicators,
  TradingStyle,
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
  label: string;
}

export const STYLE_PROFILES: Record<TradingStyle, StyleProfile> = {
  Scalping: {
    minStopDollars: 1.8,
    maxStopDollars: 7.0,
    atrStopMultiple: 0.6,
    tpMultiples: [1.2, 2.0, 3.2],
    instantToleranceDollars: 0.5,
    label: 'M15 / M5 precision scalp',
  },
  Intraday: {
    minStopDollars: 4.5,
    maxStopDollars: 18.0,
    atrStopMultiple: 1.0,
    tpMultiples: [1.5, 2.6, 4.0],
    instantToleranceDollars: 1.2,
    label: 'H1 / M15 session play',
  },
  Swing: {
    minStopDollars: 12.0,
    maxStopDollars: 60.0,
    atrStopMultiple: 2.0,
    tpMultiples: [2.0, 3.6, 6.0],
    instantToleranceDollars: 4.0,
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
  anchor: 'Order Block' | 'Fair Value Gap' | 'Market';
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

  const emaVote = indicators.trendFromEma === 'Bullish' ? 1 : indicators.trendFromEma === 'Bearish' ? -1 : 0;
  const rsiVote = indicators.rsi14 > 55 ? 0.5 : indicators.rsi14 < 45 ? -0.5 : 0;
  const stochVote =
    indicators.stochasticSignal === 'Oversold Cross' ? 0.5 : indicators.stochasticSignal === 'Overbought Cross' ? -0.5 : 0;
  factors.push({
    name: 'Indicator confluence',
    direction: emaVote + rsiVote + stochVote,
    weight: weights.indicatorConfluenceWeight,
    detail: `Price ${indicators.trendFromEma} against EMA200 ${indicators.ema200.toFixed(
      2
    )}, RSI ${indicators.rsi14.toFixed(1)}, stochastic ${indicators.stochasticSignal}.`,
  });

  // Discount favours longs, premium favours shorts.
  const zoneVote = exec.pricingZone === 'Discount' ? 0.6 : exec.pricingZone === 'Premium' ? -0.6 : 0;
  factors.push({
    name: 'Premium and discount',
    direction: zoneVote,
    weight: weights.liquiditySweepWeight,
    detail: `Price sits in the ${exec.pricingZone} half of its dealing range.`,
  });

  const score = factors.reduce((acc, f) => acc + f.direction * f.weight, 0);
  return { score, factors };
}

/**
 * Chooses the entry anchor. The learning engine's relative preference between
 * order blocks and imbalances decides which point of interest is used, so a run
 * of missed limit orders can genuinely shift entries toward the gap midpoint.
 */
export function selectEntry(
  inputs: SignalInputs,
  direction: 'long' | 'short'
): { price: number; anchor: SignalDecision['anchor']; detail: string } {
  const exec = inputs.structures.h1;
  const { weights, price } = inputs;

  const obUsable =
    (direction === 'long' && exec.orderBlock.high < price) ||
    (direction === 'short' && exec.orderBlock.low > price);
  const fvgUsable =
    exec.fairValueGap.detected &&
    ((direction === 'long' && exec.fairValueGap.top < price) ||
      (direction === 'short' && exec.fairValueGap.bottom > price));

  const preferFvg = weights.fairValueGapWeight >= weights.orderBlockWeight;

  if (fvgUsable && (preferFvg || !obUsable)) {
    // Consequent encroachment: the 50 percent line of the imbalance.
    const mid = (exec.fairValueGap.top + exec.fairValueGap.bottom) / 2;
    return {
      price: round2(mid),
      anchor: 'Fair Value Gap',
      detail: `Entry at the 50 percent consequent encroachment of the ${exec.fairValueGap.type}.`,
    };
  }

  if (obUsable) {
    const mid = (exec.orderBlock.high + exec.orderBlock.low) / 2;
    return {
      price: round2(mid),
      anchor: 'Order Block',
      detail: `Entry at the mean threshold of the ${exec.orderBlock.type}.`,
    };
  }

  return {
    price: round2(price),
    anchor: 'Market',
    detail: 'No unmitigated point of interest below price, so execution is at market.',
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

  const [m1, m2, m3] = profile.tpMultiples;
  const sign = direction === 'long' ? 1 : -1;
  const takeProfit1 = round2(entryPrice + sign * riskDistance * m1);
  const takeProfit2 = round2(entryPrice + sign * riskDistance * m2);
  const takeProfit3 = round2(entryPrice + sign * riskDistance * m3);

  const orderType = resolveOrderType(direction, entryPrice, price, profile.instantToleranceDollars);

  // Confidence: weighted agreement normalised against the total weight on the table.
  const totalWeight = factors.reduce((acc, f) => acc + f.weight * Math.max(1, Math.abs(f.direction)), 0);
  const confidenceScore = Math.round(
    Math.min(100, Math.max(0, (Math.abs(score) / Math.max(totalWeight, 0.0001)) * 100))
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
    riskRewardRatio: riskDistance > 0 ? `1:${m1.toFixed(2)}` : '1:0',
    confidenceScore,
    stopWasCapped,
    anchor: entry.anchor,
    factors,
    rationale,
  };
}

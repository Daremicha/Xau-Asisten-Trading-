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
import { isDeadOnArrival } from './order-validity';
import { factorLabel } from './factor-labels';
import { FACTOR_MULTIPLIER_MAX, FACTOR_MULTIPLIER_MIN } from './factor-learning';
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

// The numbers themselves live apart so the screen can read them without
// pulling this engine into the browser bundle. Re-exported here because every
// caller already reaches for them through the engine.
import { STYLE_PROFILES, type StyleProfile } from './style-profiles';
export { STYLE_PROFILES, type StyleProfile };

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
  /**
   * True when the entry sits so far from price that the order would already
   * satisfy its own ran-away rule the moment it was placed.
   *
   * Such an order is not a weak signal, it is a dead one: the app would record
   * it as a missed entry within seconds of issuing it. The caller offers
   * nothing rather than offering this.
   */
  entryUnfillable: boolean;
  /** Plain sentence saying why, when the entry is unfillable. */
  unfillableReason: string;
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
  //
  // When the daily read had to be resampled from the execution feed it is the
  // same candles the H4 read used, so counting both at full strength would be
  // one opinion voting twice with the heaviest weight on the table. In that
  // case the daily half of the vote stands down and the read says so.
  const dailyIsBorrowed = Boolean(structures.d1.derivedFrom);
  const htfVote = dailyIsBorrowed
    ? trendVote(structures.h4.trend) * 0.8
    : trendVote(structures.d1.trend) * 0.5 + trendVote(structures.h4.trend) * 0.3;
  factors.push({
    name: 'Higher timeframe order flow',
    direction: htfVote,
    weight: 1,
    detail: dailyIsBorrowed
      ? `H4 ${structures.h4.trend}. Data harian tidak tersedia, jadi bacaan harian memakai candle ${structures.d1.derivedFrom} yang sama dan tidak dihitung dua kali.`
      : `D1 ${structures.d1.trend}, H4 ${structures.h4.trend}.`,
  });

  const obBullish = exec.orderBlock.type === 'Bullish OB';
  const obVote = (obBullish ? 1 : -1) * (exec.orderBlock.mitigated ? 0.4 : 1);
  factors.push({
    name: 'Order block',
    direction: obVote,
    weight: weights.orderBlockWeight,
    detail: `${exec.orderBlock.type} di ${exec.orderBlock.low.toFixed(2)} sampai ${exec.orderBlock.high.toFixed(
      2
    )}, ${exec.orderBlock.mitigated ? 'sudah termitigasi' : 'belum termitigasi'}.`,
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
      ? `${exec.fairValueGap.type} ${exec.fairValueGap.bottom.toFixed(2)} sampai ${exec.fairValueGap.top.toFixed(
          2
        )}, status ${exec.fairValueGap.status}.`
      : 'Tidak ada imbalance yang belum termitigasi di timeframe eksekusi.',
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
    detail: pools.sweepDetail ?? 'Belum ada likuiditas yang diambil.',
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
    emaDescription = `Harga di atas kedua rata-rata dengan EMA ${indicators.emaFastPeriod} di atas EMA ${indicators.emaSlowPeriod}, uptrend tersusun penuh.`;
  } else if (!aboveFast && !aboveSlow && !fastAboveSlow) {
    emaVote = -1;
    emaDescription = `Harga di bawah kedua rata-rata dengan EMA ${indicators.emaFastPeriod} di bawah EMA ${indicators.emaSlowPeriod}, downtrend tersusun penuh.`;
  } else if (aboveSlow && !aboveFast) {
    // Pulling back inside the stack: the trend holds but momentum has paused.
    emaVote = 0.4;
    emaDescription = `Harga turun ke bawah EMA ${indicators.emaFastPeriod} tapi masih bertahan di atas EMA ${indicators.emaSlowPeriod}, koreksi di dalam uptrend.`;
  } else if (!aboveSlow && aboveFast) {
    emaVote = -0.4;
    emaDescription = `Harga memantul ke atas EMA ${indicators.emaFastPeriod} tapi masih tertahan di bawah EMA ${indicators.emaSlowPeriod}, koreksi di dalam downtrend.`;
  } else {
    emaVote = fastAboveSlow ? 0.2 : -0.2;
    emaDescription = 'Moving average tidak searah dengan harga, jadi struktur tren belum jelas.';
  }
  factors.push({
    name: 'EMA structure',
    direction: emaVote,
    weight: weights.indicatorConfluenceWeight,
    detail: `${emaDescription} EMA ${indicators.emaFastPeriod} ${indicators.ema50.toFixed(
      2
    )}, EMA ${indicators.emaSlowPeriod} ${indicators.ema200.toFixed(2)}.`,
  });

  // RSI, graded rather than a single threshold, and read against the trend.
  // An extreme reading argues against chasing the move, not for it.
  //
  // Setups whose RSI agreed with them returned less per trade than setups it
  // argued against, in both halves of a 24 month Intraday replay, so this
  // vote was tested switched off, inverted and at half strength. None did
  // better than as it stands (profit factor 1.29 to 1.30 against 1.31), and
  // declining setups the RSI agreed with cost more profit than it saved.
  const rsi = indicators.rsi14;
  let rsiVote: number;
  let rsiDescription: string;
  if (rsi >= 70) {
    rsiVote = -0.6;
    rsiDescription = `RSI ${rsi.toFixed(1)} overbought, ini melawan pembelian di pergerakan yang sudah jauh.`;
  } else if (rsi <= 30) {
    rsiVote = 0.6;
    rsiDescription = `RSI ${rsi.toFixed(1)} oversold, ini melawan penjualan di pergerakan yang sudah jauh.`;
  } else {
    // Between the extremes it is a momentum reading, scaled by distance from 50.
    rsiVote = ((rsi - 50) / 20) * 0.6;
    rsiDescription = `RSI ${rsi.toFixed(1)} condong ${rsi > 50 ? 'bullish' : rsi < 50 ? 'bearish' : 'netral'}.`;
  }
  if (indicators.rsiCondition === 'Bullish Divergence') {
    rsiVote += 0.5;
    rsiDescription += ' Ada divergence bullish.';
  } else if (indicators.rsiCondition === 'Bearish Divergence') {
    rsiVote -= 0.5;
    rsiDescription += ' Ada divergence bearish.';
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
    detail: `Stochastic ${indicators.stochasticK.toFixed(1)} di atas ${indicators.stochasticD.toFixed(
      1
    )}, sinyal ${indicators.stochasticSignal}.`,
  });

  // Discount favours longs, premium favours shorts. On its own this vote looks
  // backwards: weak setups it argued for did worse than those it argued
  // against. But in the engine it also steers direction and conviction, and a
  // 24 month replay did worse with it removed (profit factor 1.31 to 1.29),
  // halved (1.30) or inverted (1.20). It stays as it is.
  const zoneVote = exec.pricingZone === 'Discount' ? 0.6 : exec.pricingZone === 'Premium' ? -0.6 : 0;
  factors.push({
    name: 'Premium and discount',
    direction: zoneVote,
    weight: weights.liquiditySweepWeight,
    detail: `Harga ada di bagian ${exec.pricingZone} dari range-nya.`,
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
      detail: `Harga ${abovePivot ? 'di atas' : 'di bawah'} pivot ${bias.pivotPoint.toFixed(2)} dengan bacaan ${
        bias.directionalBias
      } dan keyakinan ${bias.confidenceScore}%.`,
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
      detail: `Fase ${phase} dengan point of control di ${inputs.wyckoff.pointOfControlPOC.toFixed(2)}${
        inputs.wyckoff.absorptionPresent ? ', ada penyerapan' : ''
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
      detail: `${inputs.quasimodo.type} setelah sweep di ${inputs.quasimodo.headLiquiditySweep.toFixed(
        2
      )}, entry optimal dekat ${inputs.quasimodo.optimalEntryZone.toFixed(2)}.`,
    });
  }

  // What each factor has been worth on this account's own trades. A factor
  // that kept arguing for the losing side speaks more quietly; one that kept
  // being right speaks up. Bounded again here, because weights can arrive from
  // storage and a value outside the learned range was not learned.
  const learned = weights.factorMultipliers ?? {};
  for (const factor of factors) {
    const multiplier = learned[factor.name];
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier === 1) continue;
    const bounded = Math.max(FACTOR_MULTIPLIER_MIN, Math.min(FACTOR_MULTIPLIER_MAX, multiplier));
    factor.weight *= bounded;
    factor.detail += ` Dihitung ${bounded}x berdasarkan rekam jejaknya.`;
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
  const volatilityReach = Math.max(profile.minEntryReachDollars, atr * profile.maxEntryAtrMultiple);
  // A pending order dies the moment price is a full stop distance past its
  // entry, and no stop in this style may be wider than maxStopDollars. So an
  // entry further from price than that ceiling cannot survive being placed,
  // however volatile the market is. Reach stops there.
  return Math.min(volatilityReach, profile.maxStopDollars);
}

/**
 * Moves a limit entry that sits just beyond a round price to just in front of it.
 *
 * Resting orders cluster on round numbers, and price often turns a few pips
 * short of one. A sell limit at 4300.06 missed by 4.6 pips when the high was
 * 4299.60; at 4299.50 it would have filled. The entry only ever moves toward
 * price, never past it, and only when it sits within the zone beyond the level.
 */
export function frontRunRoundLevel(
  entry: number,
  direction: 'long' | 'short',
  price: number,
  rule: StyleProfile['roundLevelFrontRun']
): { price: number; level: number } | null {
  if (!rule) return null;
  const level = Math.round(entry / rule.stepDollars) * rule.stepDollars;
  const beyond = direction === 'short' ? entry - level : level - entry;
  if (beyond < 0 || beyond > rule.zoneDollars) return null;
  const moved = round2(direction === 'short' ? level - rule.offsetDollars : level + rule.offsetDollars);
  // Still a resting order on the retracement side of price, or no change.
  if (direction === 'short' ? moved <= price : moved >= price) return null;
  return { price: moved, level };
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
      detail: `Entry di tengah (mean threshold) ${exec.orderBlock.type}.${
        learnedBuffer > 0
          ? ` Digeser ${priceToPips(learnedBuffer)} pips ke arah harga, dipelajari dari order yang tidak terisi.`
          : ''
      }`,
    });
    candidates.push({
      price: round2(pullTowardPrice(obNear)),
      anchor: 'Order Block',
      // The edge is a shallower fill, so it carries slightly less conviction.
      weight: weights.orderBlockWeight * 0.9,
      detail: `Entry di tepi dekat ${exec.orderBlock.type}, yang terisi lebih awal daripada bagian tengahnya.`,
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
        detail: `Entry di 50% (consequent encroachment) ${exec.fairValueGap.type}.`,
      });
      candidates.push({
        price: round2(pullTowardPrice(fvgNear)),
        anchor: 'Fair Value Gap',
        weight: weights.fairValueGapWeight * 0.9,
        detail: `Entry di tepi dekat ${exec.fairValueGap.type}, yang terisi lebih awal daripada level 50%-nya.`,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      price: round2(price),
      anchor: 'Market',
      detail: 'Tidak ada area menarik yang belum termitigasi di sisi koreksi harga, jadi eksekusi di harga market.',
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
    const shifted = frontRunRoundLevel(best.price, direction, price, profile.roundLevelFrontRun);
    if (shifted) {
      return {
        price: shifted.price,
        anchor: best.anchor,
        detail: `${best.detail} Digeser dari ${best.price.toFixed(2)} to ${shifted.price.toFixed(2)}, di depan level bulat ${shifted.level.toFixed(
          0
        )}, karena harga sering berbalik beberapa pip sebelum level bulat.`,
        outOfReach: false,
      };
    }
    return { price: best.price, anchor: best.anchor, detail: best.detail, outOfReach: false };
  }

  const nearest = [...candidates].sort((a, b) => distanceOf(a) - distanceOf(b))[0];
  return {
    price: nearest.price,
    anchor: nearest.anchor,
    detail: `${nearest.detail} Harga sekarang ${priceToPips(
      distanceOf(nearest)
    )} pips jauhnya, di luar jangkauan ${inputs.tradingStyle} sejauh ${priceToPips(reach)} pips, jadi order ini mungkin tidak terisi dalam waktu yang direncanakan.`,
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

  // The reward multiple sets how far each target sits; structure only decides
  // where inside a window around that distance the order actually rests. Both
  // halves matter: a target that ignores structure sits in empty space, and a
  // target that ignores the multiple stops paying for the stop it carries.
  const targets = selectTargets({
    entry: entryPrice,
    stop: stopLoss,
    direction,
    tradingStyle,
    atr: indicators.atr14,
    rewardMultiples: profile.tpMultiples,
    structures,
    candles: inputs.candles,
    pivotBias: inputs.pivotBias,
    quasimodo: inputs.quasimodo,
  });
  const { takeProfit1, takeProfit2, takeProfit3 } = targets;

  const orderType = resolveOrderType(direction, entryPrice, price, profile.instantToleranceDollars);

  // A pending order is dead on arrival when price already sits a full stop
  // distance past its entry, because that is exactly the rule the app uses to
  // declare a resting order missed. The engine used to issue these anyway: the
  // entry reach is derived from volatility and the stop is clamped to the
  // style's ceiling, so on a fast day the reach could be wider than the stop
  // and the order was recorded as a missed entry seconds after being offered.
  // Refusing is the honest answer — the level is worth watching, but there is
  // no order to leave working at it.
  const entryDistance = Math.abs(price - entryPrice);
  const entryUnfillable = isDeadOnArrival({ orderType, entryPrice, stopLoss }, price);
  const unfillableReason = entryUnfillable
    ? `Harga berjarak ${priceToPips(entryDistance)} pips ${direction === 'long' ? 'di atas' : 'di bawah'} ${entry.anchor} yang dipakai bacaan ini di ${entryPrice.toFixed(
        2
      )}, lebih jauh dari stop ${priceToPips(
        riskDistance
      )} pip yang dipakai trade ini. Order di sana akan langsung terhitung missed begitu dipasang, jadi tidak ditawarkan.`
    : '';

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
    `Bias ${direction === 'long' ? 'Long (Buy)' : 'Short (Sell)'} di ${profile.label}.`,
    entry.detail,
    `Konfluensi pendukung: ${agreeing.map((f) => factorLabel(f.name)).join(', ') || 'tidak ada'}.`,
    opposing.length ? `Sinyal yang bertentangan: ${opposing.map((f) => factorLabel(f.name)).join(', ')}.` : 'Tidak ada sinyal yang bertentangan.',
    `Stop ada di luar titik invalidasi struktur, dengan jarak aman ATR ${weights.atrBufferFactor.toFixed(
      2
    )}x hasil belajar sebesar ${round2(atrBuffer).toFixed(2)} dollars.`,
    inputs.killZoneActive ? 'Eksekusi ada di dalam kill zone institusional.' : 'Eksekusi ada di luar kill zone utama.',
    inputs.minutesToNextEvent !== null && inputs.minutesToNextEvent <= 60
      ? `Rilis berdampak tinggi akan keluar sekitar ${Math.round(inputs.minutesToNextEvent)} menit lagi, jadi parameter risiko diperlebar.`
      : 'Tidak ada rilis berdampak tinggi dalam satu jam ke depan.',
    stopWasCapped
      ? `Jarak aman hasil belajar meminta stop lebih lebar dari batas ${tradingStyle} sebesar ${profile.maxStopDollars.toFixed(
          2
        )} dolar, jadi dibatasi. Pertimbangkan gaya trading dengan timeframe lebih besar kalau stop terus tersentuh.`
      : '',
    entry.outOfReach
      ? 'Harga sudah melewati semua area menarik yang bisa dijangkau gaya ini, jadi anggap ini level untuk dipantau, bukan order untuk dipasang.'
      : '',
    entryUnfillable ? unfillableReason : '',
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
    entryUnfillable,
    unfillableReason,
    anchor: entry.anchor,
    factors,
    rationale,
  };
}

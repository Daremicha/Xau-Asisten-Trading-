/**
 * Smart Money Concepts analysis computed from real candle data.
 *
 * Everything here is derived from the candles passed in. There are no hardcoded
 * price levels, so the output tracks the market wherever it happens to trade.
 */

import {
  Candle,
  SwingPoint,
  atr,
  ema,
  findSwingPoints,
  highestHigh,
  lowestLow,
  pointOfControl,
  round2,
  rsi,
  stochastic,
} from './candles';
import {
  QuasimodoPattern,
  SmcStructure,
  TechnicalIndicators,
  TimeframeType,
  WyckoffVolumeAnalysis,
} from './types';

const DAY_MS = 86_400_000;

export interface StructureBreak {
  index: number;
  level: number;
  direction: 'bullish' | 'bearish';
}

/**
 * Detects every break of structure in order: a close beyond the most recent
 * swing high (bullish) or swing low (bearish) that formed before it.
 */
export function detectStructureBreaks(candles: Candle[], swings: SwingPoint[]): StructureBreak[] {
  const breaks: StructureBreak[] = [];
  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');

  let highCursor = 0;
  let lowCursor = 0;
  let lastBrokenHigh = -Infinity;
  let lastBrokenLow = Infinity;

  for (let i = 0; i < candles.length; i++) {
    // Only swings confirmed before this candle can be broken by it.
    while (highCursor < highs.length && highs[highCursor].index < i) highCursor++;
    while (lowCursor < lows.length && lows[lowCursor].index < i) lowCursor++;

    const priorHighs = highs.slice(0, highCursor);
    const priorLows = lows.slice(0, lowCursor);

    const refHigh = priorHighs.length ? priorHighs[priorHighs.length - 1] : null;
    const refLow = priorLows.length ? priorLows[priorLows.length - 1] : null;

    if (refHigh && candles[i].close > refHigh.price && refHigh.price !== lastBrokenHigh) {
      breaks.push({ index: i, level: refHigh.price, direction: 'bullish' });
      lastBrokenHigh = refHigh.price;
    } else if (refLow && candles[i].close < refLow.price && refLow.price !== lastBrokenLow) {
      breaks.push({ index: i, level: refLow.price, direction: 'bearish' });
      lastBrokenLow = refLow.price;
    }
  }

  return breaks;
}

/**
 * Final trend read, in three tiers.
 *
 * 1. Swing structure, the textbook definition.
 * 2. Consensus of the recent breaks of structure, for a market that trends too
 *    cleanly to print comparable pivots.
 * 3. Net displacement measured in ATR, for a near vertical move that prints no
 *    pivots and therefore no breaks at all.
 *
 * Without the last two tiers a relentless trend would be reported as ranging,
 * which is the opposite of what is happening.
 */
export function resolveTrend(
  swings: SwingPoint[],
  breaks: StructureBreak[],
  candles: Candle[] = []
): 'Bullish' | 'Bearish' | 'Ranging' {
  const fromSwings = classifyTrend(swings);
  if (fromSwings !== 'Ranging') return fromSwings;

  const recent = breaks.slice(-3);
  if (recent.length > 0) {
    if (recent.every((b) => b.direction === 'bullish')) return 'Bullish';
    if (recent.every((b) => b.direction === 'bearish')) return 'Bearish';
  }

  if (candles.length >= 20) {
    const net = candles[candles.length - 1].close - candles[0].close;
    const volatility = atr(candles, 14);
    if (volatility !== null && volatility > 0 && Math.abs(net) > volatility * 1.5) {
      return net > 0 ? 'Bullish' : 'Bearish';
    }
  }

  return 'Ranging';
}

/** Market structure read from the sequence of swing highs and lows. */
export function classifyTrend(swings: SwingPoint[]): 'Bullish' | 'Bearish' | 'Ranging' {
  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');
  if (highs.length < 2 || lows.length < 2) return 'Ranging';

  const higherHigh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const higherLow = lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lowerHigh = highs[highs.length - 1].price < highs[highs.length - 2].price;
  const lowerLow = lows[lows.length - 1].price < lows[lows.length - 2].price;

  if (higherHigh && higherLow) return 'Bullish';
  if (lowerHigh && lowerLow) return 'Bearish';
  return 'Ranging';
}

export interface OrderBlockResult {
  type: 'Bullish OB' | 'Bearish OB';
  high: number;
  low: number;
  mitigated: boolean;
  volumeConfirmation: boolean;
}

/**
 * The order block behind a structure break: the last opposing candle before the
 * displacement leg. Mitigation means price has since traded back into the zone.
 */
export function findOrderBlock(candles: Candle[], brk: StructureBreak | null): OrderBlockResult | null {
  if (!brk || candles.length === 0) return null;

  const wantDown = brk.direction === 'bullish';
  let originIndex = -1;
  for (let i = brk.index; i >= 0; i--) {
    const isDown = candles[i].close < candles[i].open;
    if (wantDown ? isDown : !isDown) {
      originIndex = i;
      break;
    }
  }
  if (originIndex === -1) return null;

  const origin = candles[originIndex];
  const avgVolume =
    candles.reduce((acc, c) => acc + (c.volume > 0 ? c.volume : 0), 0) / Math.max(1, candles.length);

  let mitigated = false;
  for (let i = brk.index + 1; i < candles.length; i++) {
    if (candles[i].low <= origin.high && candles[i].high >= origin.low) {
      mitigated = true;
      break;
    }
  }

  return {
    type: wantDown ? 'Bullish OB' : 'Bearish OB',
    high: round2(origin.high),
    low: round2(origin.low),
    mitigated,
    volumeConfirmation: avgVolume > 0 ? origin.volume >= avgVolume : false,
  };
}

export interface FvgResult {
  detected: boolean;
  type: 'Bullish FVG' | 'Bearish FVG';
  top: number;
  bottom: number;
  status: 'Open' | 'Partially Filled' | 'Mitigated';
}

/**
 * Most recent three candle imbalance, with how much of it later price filled.
 * A bullish gap sits between candle one's high and candle three's low.
 */
export function findFairValueGap(candles: Candle[]): FvgResult | null {
  for (let i = candles.length - 1; i >= 2; i--) {
    const first = candles[i - 2];
    const third = candles[i];

    let type: 'Bullish FVG' | 'Bearish FVG' | null = null;
    let top = 0;
    let bottom = 0;

    if (third.low > first.high) {
      type = 'Bullish FVG';
      top = third.low;
      bottom = first.high;
    } else if (third.high < first.low) {
      type = 'Bearish FVG';
      top = first.low;
      bottom = third.high;
    }
    if (!type) continue;

    const span = top - bottom;
    let deepest = type === 'Bullish FVG' ? top : bottom;
    for (let j = i + 1; j < candles.length; j++) {
      if (type === 'Bullish FVG') deepest = Math.min(deepest, candles[j].low);
      else deepest = Math.max(deepest, candles[j].high);
    }

    const filled =
      span <= 0
        ? 1
        : type === 'Bullish FVG'
        ? Math.min(1, Math.max(0, (top - deepest) / span))
        : Math.min(1, Math.max(0, (deepest - bottom) / span));

    return {
      detected: true,
      type,
      top: round2(top),
      bottom: round2(bottom),
      status: filled >= 0.99 ? 'Mitigated' : filled > 0.01 ? 'Partially Filled' : 'Open',
    };
  }
  return null;
}

export interface LiquidityPools {
  pdh: number;
  pdl: number;
  asiaHigh: number;
  asiaLow: number;
  swept: boolean;
  sweepDetail?: string;
}

/**
 * Previous day high and low plus the Asian session range, taken from M15 candles.
 * The Asian session is 00:00 to 06:00 UTC of the most recent day in the data.
 */
export function findLiquidityPools(m15: Candle[]): LiquidityPools | null {
  if (m15.length === 0) return null;

  const lastTime = m15[m15.length - 1].time;
  const todayStart = Math.floor(lastTime / DAY_MS) * DAY_MS;
  const prevStart = todayStart - DAY_MS;

  const previousDay = m15.filter((c) => c.time >= prevStart && c.time < todayStart);
  const today = m15.filter((c) => c.time >= todayStart);
  const asia = today.filter((c) => {
    const hour = ((c.time - todayStart) / 3_600_000) % 24;
    return hour >= 0 && hour < 6;
  });

  // Fall back to the trailing day of data when the feed has no full previous day.
  const pdhSource = previousDay.length ? previousDay : m15.slice(-96);
  const asiaSource = asia.length ? asia : pdhSource;

  const pdh = highestHigh(pdhSource);
  const pdl = lowestLow(pdhSource);
  const asiaHigh = highestHigh(asiaSource);
  const asiaLow = lowestLow(asiaSource);
  if (pdh === null || pdl === null || asiaHigh === null || asiaLow === null) return null;

  const sweptHigh = today.some((c) => c.high > pdh);
  const sweptLow = today.some((c) => c.low < pdl);
  const sweptAsiaHigh = today.some((c) => c.time >= todayStart + 6 * 3_600_000 && c.high > asiaHigh);
  const sweptAsiaLow = today.some((c) => c.time >= todayStart + 6 * 3_600_000 && c.low < asiaLow);

  const details: string[] = [];
  if (sweptHigh) details.push('Previous Day High taken');
  if (sweptLow) details.push('Previous Day Low taken');
  if (sweptAsiaHigh) details.push('Asian session high swept post London open');
  if (sweptAsiaLow) details.push('Asian session low swept post London open');

  return {
    pdh: round2(pdh),
    pdl: round2(pdl),
    asiaHigh: round2(asiaHigh),
    asiaLow: round2(asiaLow),
    swept: details.length > 0,
    sweepDetail: details.length ? details.join('. ') + '.' : 'No major pool taken so far this session.',
  };
}

/** Where price sits inside its dealing range: discount below half, premium above. */
export function classifyPricingZone(
  price: number,
  rangeHigh: number,
  rangeLow: number
): 'Discount' | 'Equilibrium' | 'Premium' {
  const span = rangeHigh - rangeLow;
  if (span <= 0) return 'Equilibrium';
  const position = (price - rangeLow) / span;
  if (position < 0.45) return 'Discount';
  if (position > 0.55) return 'Premium';
  return 'Equilibrium';
}

/** Swing strength scaled to the timeframe: faster charts need a tighter fractal. */
function swingStrengthFor(timeframe: TimeframeType): number {
  switch (timeframe) {
    case 'D1':
      return 2;
    case 'H4':
      return 2;
    case 'H1':
      return 3;
    default:
      return 3;
  }
}

/**
 * Full structural read of one timeframe. `m15` supplies the session liquidity
 * pools, which are a daily concept regardless of the chart being analysed.
 */
export function analyzeTimeframe(
  candles: Candle[],
  timeframe: TimeframeType,
  m15: Candle[]
): SmcStructure | null {
  if (candles.length < 10) return null;

  const swings = findSwingPoints(candles, swingStrengthFor(timeframe));
  const breaks = detectStructureBreaks(candles, swings);
  const lastBreak = breaks.length ? breaks[breaks.length - 1] : null;
  const prevBreak = breaks.length > 1 ? breaks[breaks.length - 2] : null;

  const trend = resolveTrend(swings, breaks, candles);
  const orderBlock = findOrderBlock(candles, lastBreak);
  const fvg = findFairValueGap(candles);
  const pools = findLiquidityPools(m15.length ? m15 : candles);

  const price = candles[candles.length - 1].close;
  const lookback = candles.slice(-60);
  const rangeHigh = highestHigh(lookback) ?? price;
  const rangeLow = lowestLow(lookback) ?? price;

  // A change of character is a break against the direction of the previous break.
  const chochDetected = Boolean(lastBreak && prevBreak && lastBreak.direction !== prevBreak.direction);

  return {
    timeframe,
    trend,
    bosLevel: lastBreak ? round2(lastBreak.level) : undefined,
    bosType: lastBreak ? (lastBreak.direction === 'bullish' ? 'Bullish BOS' : 'Bearish BOS') : undefined,
    chochDetected,
    chochLevel: chochDetected && lastBreak ? round2(lastBreak.level) : undefined,
    orderBlock: orderBlock ?? {
      type: trend === 'Bearish' ? 'Bearish OB' : 'Bullish OB',
      high: round2(rangeHigh),
      low: round2(rangeLow),
      mitigated: false,
      volumeConfirmation: false,
    },
    fairValueGap: fvg ?? {
      detected: false,
      type: trend === 'Bearish' ? 'Bearish FVG' : 'Bullish FVG',
      top: round2(price),
      bottom: round2(price),
      status: 'Mitigated',
    },
    liquidityPools: pools ?? {
      pdh: round2(rangeHigh),
      pdl: round2(rangeLow),
      asiaHigh: round2(rangeHigh),
      asiaLow: round2(rangeLow),
      swept: false,
      sweepDetail: 'Insufficient session data.',
    },
    pricingZone: classifyPricingZone(price, rangeHigh, rangeLow),
  };
}

/** Indicators computed from the supplied candles. Returns null when data is short. */
export function computeIndicators(candles: Candle[]): TechnicalIndicators | null {
  if (candles.length < 30) return null;

  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];

  // Fall back to the longest average the data supports so short feeds still
  // work, and report which lengths those were rather than letting a 125 period
  // average go on calling itself EMA 200.
  const emaFastPeriod = Math.min(50, closes.length);
  const emaSlowPeriod = Math.min(200, closes.length);
  const ema50 = ema(closes, emaFastPeriod);
  const ema200 = ema(closes, emaSlowPeriod);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const stoch = stochastic(candles, 14, 3);
  if (ema50 === null || ema200 === null || rsi14 === null || atr14 === null || !stoch) return null;

  const emaGap = Math.abs(price - ema200);
  const trendFromEma: 'Bullish' | 'Bearish' | 'Neutral' =
    emaGap < atr14 * 0.25 ? 'Neutral' : price > ema200 ? 'Bullish' : 'Bearish';

  let rsiCondition: TechnicalIndicators['rsiCondition'] = 'Neutral';
  if (rsi14 >= 70) rsiCondition = 'Overbought';
  else if (rsi14 <= 30) rsiCondition = 'Oversold';
  else {
    // Divergence: price makes a new extreme over the window while RSI does not.
    const half = Math.floor(candles.length / 2);
    const recentRsi = rsi(closes.slice(0, half), 14);
    if (recentRsi !== null) {
      const priorLow = lowestLow(candles.slice(0, half));
      const laterLow = lowestLow(candles.slice(half));
      const priorHigh = highestHigh(candles.slice(0, half));
      const laterHigh = highestHigh(candles.slice(half));
      if (priorLow !== null && laterLow !== null && laterLow < priorLow && rsi14 > recentRsi) {
        rsiCondition = 'Bullish Divergence';
      } else if (priorHigh !== null && laterHigh !== null && laterHigh > priorHigh && rsi14 < recentRsi) {
        rsiCondition = 'Bearish Divergence';
      }
    }
  }

  let stochasticSignal: TechnicalIndicators['stochasticSignal'] = 'Neutral';
  if (stoch.k < 20 && stoch.k > stoch.d) stochasticSignal = 'Oversold Cross';
  else if (stoch.k > 80 && stoch.k < stoch.d) stochasticSignal = 'Overbought Cross';

  return {
    ema50: round2(ema50),
    ema200: round2(ema200),
    emaFastPeriod,
    emaSlowPeriod,
    trendFromEma,
    rsi14: round2(rsi14),
    rsiCondition,
    stochasticK: round2(stoch.k),
    stochasticD: round2(stoch.d),
    stochasticSignal,
    atr14: round2(atr14),
  };
}

/** Wyckoff read from trend, position in range, and volume behaviour. */
export function computeWyckoff(
  candles: Candle[],
  trend: 'Bullish' | 'Bearish' | 'Ranging'
): WyckoffVolumeAnalysis | null {
  if (candles.length < 20) return null;

  const window = candles.slice(-60);
  const poc = pointOfControl(window);
  const high = highestHigh(window);
  const low = lowestLow(window);
  if (poc === null || high === null || low === null) return null;

  const price = window[window.length - 1].close;
  const span = high - low;
  const position = span > 0 ? (price - low) / span : 0.5;

  const volumes = window.map((c) => (c.volume > 0 ? c.volume : 0));
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / Math.max(1, volumes.length);
  const last = window[window.length - 1];
  const volumeClimaxDetected = avgVolume > 0 && last.volume > avgVolume * 2;

  const bodySize = Math.abs(last.close - last.open);
  const wholeRange = last.high - last.low;
  const absorptionPresent =
    avgVolume > 0 && last.volume > avgVolume * 1.4 && wholeRange > 0 && bodySize / wholeRange < 0.4;

  let phase: WyckoffVolumeAnalysis['phase'];
  if (trend === 'Bullish') phase = 'Markup';
  else if (trend === 'Bearish') phase = 'Markdown';
  else phase = position < 0.5 ? 'Accumulation' : 'Distribution';

  const descriptions: Record<WyckoffVolumeAnalysis['phase'], string> = {
    Markup: 'Structure is advancing on higher highs and higher lows, consistent with a Wyckoff markup leg.',
    Markdown: 'Structure is declining on lower highs and lower lows, consistent with a Wyckoff markdown leg.',
    Accumulation: 'Price is ranging in the lower half of its dealing range, the signature of Wyckoff accumulation.',
    Distribution: 'Price is ranging in the upper half of its dealing range, the signature of Wyckoff distribution.',
  };

  let description = descriptions[phase];
  if (volumeClimaxDetected) description += ' A volume climax has just printed, so expect a reaction.';
  else if (absorptionPresent) description += ' Heavy volume on a small body suggests absorption.';

  return {
    phase,
    pointOfControlPOC: round2(poc),
    volumeClimaxDetected,
    absorptionPresent,
    description,
  };
}

/**
 * Quasimodo: a failed continuation where the head sweeps liquidity beyond the
 * prior extreme and price then breaks back through the opposing shoulder.
 */
export function computeQuasimodo(candles: Candle[], swings: SwingPoint[]): QuasimodoPattern | null {
  if (candles.length < 10) return null;

  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');
  if (highs.length < 2 || lows.length < 2) return null;

  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];

  // Bearish QM: the head prints a higher high, then price loses the prior low.
  const bearish = lastHigh.price > prevHigh.price && lastLow.price < prevLow.price && lastHigh.index > prevLow.index;
  // Bullish QM: the head prints a lower low, then price reclaims the prior high.
  const bullish = lastLow.price < prevLow.price && lastHigh.price > prevHigh.price && lastLow.index > prevHigh.index;

  const type: 'Bullish QM' | 'Bearish QM' = bearish && !bullish ? 'Bearish QM' : 'Bullish QM';
  const detected = bearish || bullish;

  const leftShoulder = type === 'Bullish QM' ? prevLow.price : prevHigh.price;
  const head = type === 'Bullish QM' ? lastLow.price : lastHigh.price;
  const breakLevel = type === 'Bullish QM' ? lastHigh.price : lastLow.price;

  return {
    detected,
    type,
    leftShoulder: round2(leftShoulder),
    headLiquiditySweep: round2(head),
    breakLevel: round2(breakLevel),
    // The optimal entry sits at the midpoint between the sweep and the break.
    optimalEntryZone: round2((head + breakLevel) / 2),
  };
}

export { findSwingPoints };
export type { Candle, SwingPoint };

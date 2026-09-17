/**
 * Assembles a full institutional read from a market snapshot: multi timeframe
 * structure, indicators, Wyckoff, Quasimodo and classic pivot levels, all
 * derived from the candles the feed actually returned.
 */

import { Candle, findSwingPoints, highestHigh, lowestLow, resample, round2 } from './candles';
import {
  analyzeTimeframe,
  computeIndicators,
  computeQuasimodo,
  computeWyckoff,
} from './smc-analysis';
import { MarketSnapshot } from './price-feed';
import {
  QuasimodoPattern,
  SmcStructure,
  TechnicalIndicators,
  TimeframeType,
  TradingCentralInsight,
  WyckoffVolumeAnalysis,
} from './types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface InstitutionalRead {
  multiTimeframe: { d1: SmcStructure; h4: SmcStructure; h1: SmcStructure; m15: SmcStructure };
  indicators: TechnicalIndicators;
  wyckoff: WyckoffVolumeAnalysis;
  quasimodo: QuasimodoPattern;
  tradingCentral: TradingCentralInsight;
  /** Candles actually used, useful for charting and for debugging a signal. */
  executionCandles: Candle[];
}

/** Classic floor trader pivots from the previous session's range. */
export function computePivotLevels(high: number, low: number, close: number) {
  const pivot = (high + low + close) / 3;
  const range = high - low;
  return {
    pivot: round2(pivot),
    r1: round2(2 * pivot - low),
    r2: round2(pivot + range),
    r3: round2(high + 2 * (pivot - low)),
    s1: round2(2 * pivot - high),
    s2: round2(pivot - range),
    s3: round2(low - 2 * (high - pivot)),
  };
}

/** Previous UTC day's high, low and close from M15 candles. */
export function previousSessionRange(
  m15: Candle[]
): { high: number; low: number; close: number } | null {
  if (m15.length === 0) return null;
  const lastTime = m15[m15.length - 1].time;
  const todayStart = Math.floor(lastTime / DAY_MS) * DAY_MS;
  const prev = m15.filter((c) => c.time >= todayStart - DAY_MS && c.time < todayStart);

  // Fall back to the trailing 96 M15 candles, one day's worth, when the feed is short.
  const source = prev.length >= 4 ? prev : m15.slice(-96);
  const high = highestHigh(source);
  const low = lowestLow(source);
  if (high === null || low === null || source.length === 0) return null;
  return { high, low, close: source[source.length - 1].close };
}

/**
 * Directional bias in the Trading Central house style, anchored to the real
 * pivot rather than a rounding of the current price.
 */
export function buildTradingCentralInsight(
  price: number,
  m15: Candle[],
  htfTrend: SmcStructure['trend']
): TradingCentralInsight | null {
  const range = previousSessionRange(m15);
  if (!range) return null;

  const levels = computePivotLevels(range.high, range.low, range.close);
  const above = price >= levels.pivot;

  // Bias needs pivot position and higher timeframe structure to agree.
  const directionalBias: TradingCentralInsight['directionalBias'] =
    above && htfTrend === 'Bullish' ? 'BULLISH' : !above && htfTrend === 'Bearish' ? 'BEARISH' : 'NEUTRAL';

  const distance = Math.abs(price - levels.pivot);
  const span = Math.max(range.high - range.low, 0.01);
  // Conviction grows with distance from the pivot and with structural agreement.
  const confidenceScore = Math.round(
    Math.min(95, 40 + (distance / span) * 80 + (directionalBias === 'NEUTRAL' ? 0 : 15))
  );

  return {
    directionalBias,
    pivotPoint: levels.pivot,
    preferredScenario: above
      ? `Preferred scenario: long while price holds above the pivot at ${levels.pivot.toFixed(
          2
        )}, targeting ${levels.r1.toFixed(2)} then ${levels.r2.toFixed(2)}.`
      : `Preferred scenario: short while price caps below the pivot at ${levels.pivot.toFixed(
          2
        )}, targeting ${levels.s1.toFixed(2)} then ${levels.s2.toFixed(2)}.`,
    alternativeScenario: above
      ? `Alternative scenario: a reclaim below ${levels.pivot.toFixed(
          2
        )} opens ${levels.s1.toFixed(2)} and ${levels.s2.toFixed(2)}.`
      : `Alternative scenario: a reclaim above ${levels.pivot.toFixed(
          2
        )} opens ${levels.r1.toFixed(2)} and ${levels.r2.toFixed(2)}.`,
    keySupportLevels: [levels.s1, levels.s2, levels.s3],
    keyResistanceLevels: [levels.r1, levels.r2, levels.r3],
    confidenceScore,
  };
}

/**
 * Builds the complete read. Returns null when the feed did not supply enough
 * candles, so callers report missing data instead of inventing structure.
 */
export function buildInstitutionalRead(snapshot: MarketSnapshot): InstitutionalRead | null {
  const m15 = snapshot.candlesM15;
  if (m15.length < 40) return null;

  const h1 = resample(m15, HOUR_MS);
  const h4 = resample(m15, 4 * HOUR_MS);

  // The daily read prefers real daily candles. Resampling the execution feed
  // cannot produce them: ten days of fifteen minute candles make ten daily
  // bars, which is not a daily picture, and the fallback below then quietly
  // handed back a four hour read wearing a D1 label — the heaviest single
  // input in the whole score, counted twice as D1 and again as H4.
  const provided = snapshot.candlesD1 ?? [];
  const d1 = provided.length >= 10 ? provided : resample(m15, DAY_MS);
  const d1Source = d1.length >= 10 ? d1 : h4.length >= 10 ? h4 : h1;
  const h4Source = h4.length >= 10 ? h4 : h1;

  // What the read was really built from, so nothing on screen claims to have
  // seen a daily chart that was never fetched.
  const d1DerivedFrom: TimeframeType | undefined =
    d1Source === provided ? undefined : d1Source === d1 ? 'D1' : d1Source === h4 ? 'H4' : 'H1';

  const structureD1 = analyzeTimeframe(d1Source, 'D1', m15);
  const structureH4 = analyzeTimeframe(h4Source, 'H4', m15);
  const structureH1 = analyzeTimeframe(h1.length >= 10 ? h1 : m15, 'H1', m15);
  const structureM15 = analyzeTimeframe(m15, 'M15', m15);
  if (!structureD1 || !structureH4 || !structureH1 || !structureM15) return null;
  if (d1DerivedFrom) structureD1.derivedFrom = d1DerivedFrom;
  if (h4Source !== h4) structureH4.derivedFrom = 'H1';

  const executionCandles = h1.length >= 30 ? h1 : m15;
  const indicators = computeIndicators(executionCandles) ?? computeIndicators(m15);
  if (!indicators) return null;

  const wyckoff = computeWyckoff(executionCandles, structureH1.trend);
  const quasimodo = computeQuasimodo(executionCandles, findSwingPoints(executionCandles, 2));
  if (!wyckoff || !quasimodo) return null;

  const price = snapshot.price ?? m15[m15.length - 1].close;
  const tradingCentral = buildTradingCentralInsight(price, m15, structureD1.trend);
  if (!tradingCentral) return null;

  return {
    multiTimeframe: { d1: structureD1, h4: structureH4, h1: structureH1, m15: structureM15 },
    indicators,
    wyckoff,
    quasimodo,
    tradingCentral,
    executionCandles,
  };
}

/**
 * Pure candle mathematics. No network, no randomness, no clock reads.
 * Every function here is deterministic so it can be unit tested.
 */

export interface Candle {
  /** Epoch milliseconds of the candle open. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SwingPoint {
  index: number;
  price: number;
  time: number;
  kind: 'high' | 'low';
}

/** Simple moving average of the last `period` values. Returns null when data is short. */
export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/**
 * Exponential moving average seeded with the SMA of the first `period` values.
 * Returns null when there is not enough data to seed the average.
 */
export function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const k = 2 / (period + 1);
  let acc = 0;
  for (let i = 0; i < period; i++) acc += values[i];
  let current = acc / period;
  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
  }
  return current;
}

/**
 * Wilder's Relative Strength Index. Returns null when data is short.
 * A market with no down moves yields 100, no up moves yields 0.
 */
export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;

  let gainAcc = 0;
  let lossAcc = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainAcc += diff;
    else lossAcc -= diff;
  }
  let avgGain = gainAcc / period;
  let avgLoss = lossAcc / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** True range of a candle relative to the previous close. */
export function trueRange(candle: Candle, previousClose: number): number {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose)
  );
}

/** Wilder's Average True Range in price units. Returns null when data is short. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  let acc = 0;
  for (let i = 1; i <= period; i++) acc += trueRange(candles[i], candles[i - 1].close);
  let current = acc / period;

  for (let i = period + 1; i < candles.length; i++) {
    const tr = trueRange(candles[i], candles[i - 1].close);
    current = (current * (period - 1) + tr) / period;
  }
  return current;
}

export interface StochasticResult {
  k: number;
  d: number;
}

/**
 * Stochastic oscillator. %K over `kPeriod`, %D as the SMA of the last `dPeriod` %K values.
 * A flat range where high equals low yields a neutral 50.
 */
export function stochastic(candles: Candle[], kPeriod = 14, dPeriod = 3): StochasticResult | null {
  if (candles.length < kPeriod + dPeriod - 1) return null;

  const kSeries: number[] = [];
  for (let end = kPeriod; end <= candles.length; end++) {
    const window = candles.slice(end - kPeriod, end);
    let highest = -Infinity;
    let lowest = Infinity;
    for (const c of window) {
      if (c.high > highest) highest = c.high;
      if (c.low < lowest) lowest = c.low;
    }
    const span = highest - lowest;
    const close = window[window.length - 1].close;
    kSeries.push(span === 0 ? 50 : ((close - lowest) / span) * 100);
  }

  const k = kSeries[kSeries.length - 1];
  const d = sma(kSeries, dPeriod);
  if (d === null) return null;
  return { k, d };
}

/**
 * Fractal swing points: a high is a swing when `strength` candles on each side are lower.
 * Returned in chronological order.
 */
export function findSwingPoints(candles: Candle[], strength = 2): SwingPoint[] {
  const points: SwingPoint[] = [];
  if (candles.length < strength * 2 + 1) return points;

  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= strength; offset++) {
      if (candles[i].high <= candles[i - offset].high || candles[i].high <= candles[i + offset].high) {
        isHigh = false;
      }
      if (candles[i].low >= candles[i - offset].low || candles[i].low >= candles[i + offset].low) {
        isLow = false;
      }
      if (!isHigh && !isLow) break;
    }
    if (isHigh) points.push({ index: i, price: candles[i].high, time: candles[i].time, kind: 'high' });
    if (isLow) points.push({ index: i, price: candles[i].low, time: candles[i].time, kind: 'low' });
  }

  return points;
}

/** Highest high across the candles, or null when empty. */
export function highestHigh(candles: Candle[]): number | null {
  if (candles.length === 0) return null;
  return candles.reduce((acc, c) => (c.high > acc ? c.high : acc), -Infinity);
}

/** Lowest low across the candles, or null when empty. */
export function lowestLow(candles: Candle[]): number | null {
  if (candles.length === 0) return null;
  return candles.reduce((acc, c) => (c.low < acc ? c.low : acc), Infinity);
}

/**
 * Volume weighted Point of Control: the price bucket that traded the most volume.
 * Falls back to the midpoint of the range when every candle reports zero volume.
 */
export function pointOfControl(candles: Candle[], buckets = 24): number | null {
  if (candles.length === 0) return null;
  const top = highestHigh(candles);
  const bottom = lowestLow(candles);
  if (top === null || bottom === null) return null;

  const span = top - bottom;
  if (span <= 0) return top;

  const totals = new Array<number>(buckets).fill(0);
  for (const c of candles) {
    const mid = (c.high + c.low) / 2;
    const slot = Math.min(buckets - 1, Math.max(0, Math.floor(((mid - bottom) / span) * buckets)));
    totals[slot] += c.volume > 0 ? c.volume : 1;
  }

  let best = 0;
  for (let i = 1; i < buckets; i++) if (totals[i] > totals[best]) best = i;
  return bottom + (span * (best + 0.5)) / buckets;
}

/**
 * Aggregates candles into a larger timeframe, e.g. M15 into H1 or H4.
 * `bucketMs` is the target candle duration in milliseconds.
 */
export function resample(candles: Candle[], bucketMs: number): Candle[] {
  if (candles.length === 0 || bucketMs <= 0) return [];
  const byBucket = new Map<number, Candle>();

  for (const c of candles) {
    const key = Math.floor(c.time / bucketMs) * bucketMs;
    const existing = byBucket.get(key);
    if (!existing) {
      byBucket.set(key, { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume;
    }
  }

  return Array.from(byBucket.values()).sort((a, b) => a.time - b.time);
}

/** Rounds to 2 decimals, the pricing precision used for gold quotes. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Gold moves in 0.10 increments per pip, so a 1.00 dollar move is 10 pips. */
export function priceToPips(priceDistance: number): number {
  return Math.round(Math.abs(priceDistance) * 10 * 10) / 10;
}

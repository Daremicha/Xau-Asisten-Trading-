/**
 * The London breakout of the Asian range, traded with the trend.
 *
 * Between 07:00 and 10:00 London time, a stop order rests just beyond the
 * side of the Asian range (00:00 to 06:00 UTC) that the trend points to: a buy
 * stop above the range high when price is over its 200 period M15 average, a
 * sell stop under the low when it is below. The stop loss sits at the far side
 * of the range and the target at twice the risk.
 *
 * Twelve intraday playbooks were replayed over 24 months of M15 gold with
 * spread, slippage and the break-even move. This was the only one that paid
 * in both halves with every neighbouring setting also paying: profit factor
 * 1.52 on its own, and alongside the structural engine it raised the total
 * from 104R to about 119R with both halves better. Asian range fades, Judas
 * swings, New York sweeps, opening range breakouts, previous-day sweeps, EMA
 * pullbacks and RSI fades all lost money after costs.
 *
 * Its stop is the whole Asian range, usually around 300 pips, so the minimum
 * lot on a small account risks far more than the user's percentage. The setup
 * is therefore only offered when the account can carry it at the risk the user
 * set; until then the structural engine runs alone, exactly as tested.
 */

import type { Candle } from './candles';
import type { OrderExecutionType } from './types';

export const LONDON_BREAKOUT = {
  /** London clock hours the order may be placed and may fill in. */
  fromHour: 7,
  untilHour: 10,
  /** Dollars beyond the range edge, so a touch of the edge is not a breakout. */
  buffer: 0.3,
  targetR: 2,
  emaPeriod: 200,
  /** The range must be between these multiples of the M15 ATR. */
  minRangeAtr: 1,
  maxRangeAtr: 8,
  /** Fewer Asian candles than this means a holiday or a gap in the data. */
  minAsianCandles: 16,
} as const;

/** A label for the setup, recorded with the trade. */
export const BREAKOUT_ANCHOR = 'Asian Range Breakout' as const;

export interface BreakoutPlan {
  direction: 'long' | 'short';
  orderType: Extract<OrderExecutionType, 'BUY STOP' | 'SELL STOP'>;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  asiaHigh: number;
  asiaLow: number;
  trendAverage: number;
  /** When the order stops being valid: 10:00 London. */
  expiresAt: number;
  rationale: string;
}

function lastSunday(year: number, month: number): number {
  const d = new Date(Date.UTC(year, month + 1, 0));
  return d.getUTCDate() - d.getUTCDay();
}

/** London's offset from UTC in hours: one during British Summer Time. */
export function londonOffsetHours(t: number): number {
  const y = new Date(t).getUTCFullYear();
  const start = Date.UTC(y, 2, lastSunday(y, 2), 1);
  const end = Date.UTC(y, 9, lastSunday(y, 9), 1);
  return t >= start && t < end ? 1 : 0;
}

/** Hours since London midnight, fractional. */
export function londonHour(t: number): number {
  const d = new Date(t + londonOffsetHours(t) * 3_600_000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function averageTrueRange(candles: Candle[], period = 14): number {
  let atr = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}

function exponentialAverage(values: number[], period: number): number {
  const k = 2 / (period + 1);
  let e = values[0];
  for (const v of values) e = v * k + e * (1 - k);
  return e;
}

/**
 * The order to place now, or null when there is none: outside the London
 * window, a range that is missing, too narrow or too wide, or price already
 * outside it.
 *
 * `candles` are closed M15 candles, oldest first; `price` is the latest price.
 */
export function londonBreakoutPlan(candles: Candle[], price: number, now: number): BreakoutPlan | null {
  const cfg = LONDON_BREAKOUT;
  const hour = londonHour(now);
  if (hour < cfg.fromHour || hour >= cfg.untilHour) return null;
  if (candles.length < cfg.emaPeriod + 20) return null;

  const day = new Date(now).toISOString().slice(0, 10);
  const asian = candles.filter(
    (c) => new Date(c.time).toISOString().slice(0, 10) === day && new Date(c.time).getUTCHours() < 6
  );
  if (asian.length < cfg.minAsianCandles) return null;
  const high = Math.max(...asian.map((c) => c.high));
  const low = Math.min(...asian.map((c) => c.low));
  const width = high - low;
  const atr = averageTrueRange(candles.slice(-200));
  if (!(atr > 0) || width < cfg.minRangeAtr * atr || width > cfg.maxRangeAtr * atr) return null;

  // Already through a side: the breakout has happened without the order.
  if (price > high + cfg.buffer || price < low - cfg.buffer) return null;

  const average = exponentialAverage(
    candles.map((c) => c.close),
    cfg.emaPeriod
  );
  const long = price > average;

  // 10:00 London today, the end of the window.
  const londonMidnight = Date.UTC(
    new Date(now + londonOffsetHours(now) * 3_600_000).getUTCFullYear(),
    new Date(now + londonOffsetHours(now) * 3_600_000).getUTCMonth(),
    new Date(now + londonOffsetHours(now) * 3_600_000).getUTCDate()
  );
  const expiresAt = londonMidnight + (cfg.untilHour - londonOffsetHours(now)) * 3_600_000;

  const entry = round2(long ? high + cfg.buffer : low - cfg.buffer);
  const stop = round2(long ? low : high);
  const risk = Math.abs(entry - stop);
  const target = (r: number) => round2(long ? entry + r * risk : entry - r * risk);

  return {
    direction: long ? 'long' : 'short',
    orderType: long ? 'BUY STOP' : 'SELL STOP',
    entryPrice: entry,
    stopLoss: stop,
    takeProfit1: target(cfg.targetR),
    takeProfit2: target(cfg.targetR + 0.5),
    takeProfit3: target(cfg.targetR + 1),
    asiaHigh: round2(high),
    asiaLow: round2(low),
    trendAverage: round2(average),
    expiresAt,
    rationale:
      `London breakout of the Asian range, with the trend. Asian session range ${low.toFixed(2)} to ${high.toFixed(
        2
      )} (${Math.round(width * 10)} pips). Price ${price.toFixed(2)} is ${long ? 'above' : 'below'} its 200 period M15 average ` +
      `(${average.toFixed(2)}), so only the ${long ? 'upside' : 'downside'} break is traded: a ${
        long ? 'buy' : 'sell'
      } stop at ${entry.toFixed(2)}, stop loss at the far side of the range ${stop.toFixed(2)}, first target at ${cfg.targetR}R. ` +
      `The order is only valid until 10:00 London; delete it if it has not filled by then. ` +
      `Replayed over 24 months of M15 gold with costs, this setup paid in both halves (profit factor about 1.5).`,
  };
}

/**
 * When spot gold is shut, so candles stamped then can be left out.
 *
 * Twelve Data keeps printing XAU/USD bars through the weekend. They are flat
 * (a median range of 27 cents against $4.80 on a weekday) and by 2026 they
 * filled nearly every weekend: 17% of a two year M15 download. Left in, they
 * shrink the ATR, drag swing points and averages toward a price nobody could
 * trade, and let the backtest fill orders while the market was closed.
 *
 * The cut is deliberately inside the real closure, which moves an hour with
 * daylight saving: Friday from 22:00 UTC, all of Saturday, and Sunday before
 * 21:00 UTC are shut in every season. The hour either side can be a trading
 * hour, so it is kept.
 */

import type { Candle } from './candles';

export function isGoldMarketClosed(ms: number): boolean {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  return (day === 5 && hour >= 22) || day === 6 || (day === 0 && hour < 21);
}

/** Only the candles printed while the market was open. */
export function tradingCandles(candles: Candle[]): Candle[] {
  return candles.filter((c) => !isGoldMarketClosed(c.time));
}

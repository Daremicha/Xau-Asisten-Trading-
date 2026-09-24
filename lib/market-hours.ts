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

/** True while New York is on daylight saving: second Sunday of March 07:00 UTC to first Sunday of November 06:00 UTC. */
export function isUsDaylightSaving(at: number): boolean {
  const y = new Date(at).getUTCFullYear();
  const nthSunday = (month: number, n: number) => {
    const firstDay = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return 1 + ((7 - firstDay) % 7) + (n - 1) * 7;
  };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7);
  const end = Date.UTC(y, 10, nthSunday(10, 1), 6);
  return at >= start && at < end;
}

/** A New York wall-clock time on a date (YYYY-MM-DD), as a UTC timestamp. */
export function newYorkTime(date: string, hour: number, minute: number): number {
  const [y, m, d] = date.split('-').map(Number);
  const asIfUtc = Date.UTC(y, m - 1, d, hour, minute);
  // Eastern is UTC-4 in daylight saving and UTC-5 otherwise. Checking the
  // candidate instant is exact for release times, which are never near 2am.
  const summer = asIfUtc + 4 * 3_600_000;
  return isUsDaylightSaving(summer) ? summer : asIfUtc + 5 * 3_600_000;
}

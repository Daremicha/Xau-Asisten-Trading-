/**
 * The trading style and conviction floor that held up on real history.
 *
 * A 24 month replay of XAUUSD M15 (September 2024 to September 2026) tried
 * Intraday and Scalping, each taking every setup and with a floor of 70. Only
 * Scalping with the floor made money in both halves of the period: profit
 * factor 1.29, worst drawdown 13%. Scalping taking everything broke even, and
 * Intraday taking everything lost money in the second half. These are the
 * defaults for a new user, and the app says so when an account strays.
 *
 * One period is evidence, not a law. Re-test in the Backtest Lab as the market
 * moves on.
 */

import type { TradingStyle } from './types';

export const TESTED_STYLE: TradingStyle = 'Scalping';
export const TESTED_FLOOR = 70;

export function followsTestedConfiguration(style: TradingStyle, floor: number): boolean {
  return style === TESTED_STYLE && floor >= TESTED_FLOOR;
}

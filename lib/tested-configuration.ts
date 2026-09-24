/**
 * The trading style, conviction floor and stop management that held up on
 * real history.
 *
 * A 24 month replay of XAUUSD M15 (September 2024 to September 2026), with the
 * weekend bars the feed prints while the market is shut removed, tried
 * Intraday and Scalping at each floor. Intraday made money in both halves at
 * every floor from 40 up, which makes it a plateau rather than one lucky
 * setting. Once weak Asian-session setups were declined (see session-rules),
 * a floor of 40 gave the most trades that still paid: profit factor 1.27, and
 * 1.34 with the stop moved to entry at 1R, which also cut the worst drawdown
 * to 20% and the worst losing streak to 10. About six trades a week.
 *
 * An earlier replay on the unfiltered bars favoured Scalping at 70. The weekend
 * prints had been shrinking the ATR and skewing structure, and Intraday most.
 *
 * One period is evidence, not a law. Re-test in the Backtest Lab as the market
 * moves on.
 */

import type { TradingStyle } from './types';

export const TESTED_STYLE: TradingStyle = 'Intraday';
export const TESTED_FLOOR = 40;
/** Multiple of risk at which the stop moves to entry. */
export const TESTED_PROTECT_AT_R = 1;

export function followsTestedConfiguration(style: TradingStyle, floor: number): boolean {
  return style === TESTED_STYLE && floor >= TESTED_FLOOR;
}

/** What the same replay said about a setting that is not the tested one. */
export function untestedSettingNote(style: TradingStyle, floor: number): string | null {
  if (followsTestedConfiguration(style, floor)) return null;
  if (style === 'Intraday') {
    return 'Intraday taking every setup lost money in the second half and fell 57% from its high.';
  }
  if (style === 'Scalping') {
    return floor >= 70
      ? 'Scalping at a floor of 70 made money in both halves, but earned less than a tenth as much.'
      : 'Scalping below a floor of 70 fell more than 30% from its high for little return.';
  }
  return `${style} was not part of that test.`;
}

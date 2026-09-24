/**
 * What each trading style means in numbers.
 *
 * Kept apart from the engine that uses them so the screen can read the same
 * figures without dragging the whole signal engine into the browser bundle for
 * the sake of a caption. That separation is the point: the selector used to
 * carry its own hand written bands — "15-30p", "45-80p", "120-250p" — and all
 * three had drifted from the numbers the engine actually enforces. A trader
 * choosing Intraday was told to expect a stop of at most eighty pips and could
 * be handed one of a hundred and eighty.
 *
 * Nothing in the app should ever write these numbers down a second time.
 */

import type { TradingStyle } from './types';

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
  /**
   * Furthest a pending entry may sit from live price, as a multiple of ATR.
   * A point of interest beyond this is a real level but not a fillable one for
   * this style: an intraday order parked three ATR away simply will not trade
   * before the session ends.
   */
  maxEntryAtrMultiple: number;
  /** Floor for the same limit, so an unusually quiet market stays tradeable. */
  minEntryReachDollars: number;
  /**
   * Moves a limit entry that sits just beyond a round price to just in front
   * of it, because price so often turns a few pips short of a round number.
   * Null leaves entries where structure put them. See `frontRunRoundLevel`.
   */
  roundLevelFrontRun: { stepDollars: number; zoneDollars: number; offsetDollars: number } | null;
  label: string;
}

export const STYLE_PROFILES: Record<TradingStyle, StyleProfile> = {
  Scalping: {
    minStopDollars: 1.8,
    maxStopDollars: 7.0,
    atrStopMultiple: 0.6,
    tpMultiples: [1.2, 2.0, 3.2],
    instantToleranceDollars: 0.5,
    maxEntryAtrMultiple: 0.8,
    minEntryReachDollars: 2.0,
    // Tested on 24 months of M15 history at a floor of 70, weekend bars
    // removed: shifting entries within ten pips beyond a $10 level to five
    // pips in front of it took profit factor from 1.25 to 1.27 and net from
    // +108 to +117 Cent. A small gain, and it catches the round-number near
    // misses that are most frustrating to watch.
    roundLevelFrontRun: { stepDollars: 10, zoneDollars: 1, offsetDollars: 0.5 },
    label: 'M15 / M5 precision scalp',
  },
  Intraday: {
    minStopDollars: 4.5,
    maxStopDollars: 18.0,
    atrStopMultiple: 1.0,
    tpMultiples: [1.5, 2.6, 4.0],
    instantToleranceDollars: 1.2,
    maxEntryAtrMultiple: 1.5,
    minEntryReachDollars: 6.0,
    // On Intraday the same rule moved profit factor between 1.36 and 1.39
    // around a baseline of 1.38 depending on the setting: noise, not an edge,
    // so its entries stay on structure.
    roundLevelFrontRun: null,
    label: 'H1 / M15 session play',
  },
  Swing: {
    minStopDollars: 12.0,
    maxStopDollars: 60.0,
    atrStopMultiple: 2.0,
    tpMultiples: [2.0, 3.6, 6.0],
    instantToleranceDollars: 4.0,
    maxEntryAtrMultiple: 3.0,
    minEntryReachDollars: 20.0,
    roundLevelFrontRun: null,
    label: 'D1 / H4 macro swing',
  },
};

/**
 * The stop range a style allows, in pips, as the screen should say it.
 *
 * Gold is quoted to two decimals and a pip is ten cents, so a dollar of stop is
 * ten pips. Derived rather than written down, because a caption that disagrees
 * with the engine is worse than no caption: it is a promise the software does
 * not keep.
 */
export function stopBandPips(style: TradingStyle): { min: number; max: number } {
  const profile = STYLE_PROFILES[style];
  return {
    min: Math.round(profile.minStopDollars * 10),
    max: Math.round(profile.maxStopDollars * 10),
  };
}

/** The same range as a short caption, e.g. "45-180p". */
export function stopBandLabel(style: TradingStyle): string {
  const { min, max } = stopBandPips(style);
  return `${min}-${max}p`;
}

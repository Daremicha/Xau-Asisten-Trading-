/**
 * What actually happened to an order while nobody was watching.
 *
 * The app decided the fate of a trade from a single number: the price at the
 * moment it happened to look. That works only while the tab is open. Close it
 * at ten at night, and an order that filled at two, ran to its target at four
 * and drifted back by morning looks — to a screen that can see only the last
 * tick — exactly like an order that never filled and whose move ran away
 * without it. The ledger recorded a miss, and the learning engine was taught
 * that a winning setup had failed.
 *
 * A point cannot describe a path. This module reads the path instead: the
 * fifteen minute candles the quote already carries, walked forward from the
 * moment the order was issued, under the same rules the live screen applies
 * tick by tick.
 *
 * Where the candles do not reach back far enough it says so rather than
 * guessing. An honest `unknown` costs the user one question; a guess costs them
 * a false record they cannot see is false.
 */

import type { Candle } from './candles';
import type { InstitutionalTradingSetup } from './types';
import type { CloseTrigger } from './position-tracker';
import type { PendingVerdict } from './order-validity';

/** Which target a close corresponds to, for the level the ledger stores. */
export type TargetLevel = 1 | 2 | 3;

export type ReplayVerdict =
  /** The history does not cover the order, so nothing may be concluded. */
  | { kind: 'unknown'; reason: string }
  /** Never filled, and none of the ways an order dies has happened yet. */
  | { kind: 'pending'; reason: string }
  /** Never filled, and it is now too late for it to. */
  | { kind: 'missed'; cause: PendingVerdict['state']; reason: string; at: string }
  /** Filled, and still open at the end of the history. */
  | { kind: 'running'; fillPrice: number; filledAt: string; reason: string }
  /** Filled, and reached a target or the stop. */
  | {
      kind: 'closed';
      trigger: CloseTrigger;
      level: TargetLevel;
      fillPrice: number;
      filledAt: string;
      exitPrice: number;
      at: string;
      reason: string;
    };

type ReplaySetup = Pick<
  InstitutionalTradingSetup,
  'orderType' | 'entryPrice' | 'stopLoss' | 'takeProfit1' | 'takeProfit2' | 'takeProfit3' | 'timestamp'
> & { validUntil?: string; filledAt?: string };

/**
 * A candle's own span, needed because a candle is stamped at its open. The
 * fifteen minute series is the only one the quote carries, so the last candle
 * covers up to fifteen minutes that have not closed yet.
 */
const CANDLE_MS = 15 * 60_000;

/**
 * How far before the first usable candle an order may sit and still be read.
 *
 * A setup issued a few seconds before the candle it belongs to is the ordinary
 * case, not a gap in the history. Anything older than one candle genuinely
 * predates what the feed can show.
 */
const START_TOLERANCE_MS = CANDLE_MS;

/**
 * Clock skew allowed before a candle counts as stamped in the future.
 *
 * A candle is stamped at its open, so the newest one always opened at or
 * before now. Two minutes covers the difference between a provider's clock and
 * this one; anything further ahead is a timezone fault, not a clock.
 */
const FUTURE_TOLERANCE_MS = 2 * 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Furthest target reached inside one candle, stop already ruled out. */
function targetHit(setup: ReplaySetup, candle: Candle, isLong: boolean): TargetLevel | null {
  if (isLong) {
    if (candle.high >= setup.takeProfit3) return 3;
    if (candle.high >= setup.takeProfit2) return 2;
    if (candle.high >= setup.takeProfit1) return 1;
  } else {
    if (candle.low <= setup.takeProfit3) return 3;
    if (candle.low <= setup.takeProfit2) return 2;
    if (candle.low <= setup.takeProfit1) return 1;
  }
  return null;
}

/**
 * Walks an order through the candles that followed it.
 *
 * The rules are the live screen's own, applied to a bar instead of a tick:
 *
 * - a resting order fills when a bar's range contains its entry;
 * - before it fills, it dies three ways — price through the invalidation, price
 *   a full stop distance past the entry, or the validity window closing;
 * - once filled, the stop is checked before the targets, because the order of
 *   events inside a bar cannot be recovered and the losing side is not one to
 *   guess in your own favour.
 *
 * `candles` must be in ascending time order, which is how the feed supplies it.
 */
export function replayOrder(
  setup: ReplaySetup,
  allCandles: Candle[],
  now: number = Date.now()
): ReplayVerdict {
  const issuedAt = Date.parse(setup.timestamp ?? '');
  if (!Number.isFinite(issuedAt)) {
    return { kind: 'unknown', reason: 'The order carries no readable timestamp, so its history cannot be found.' };
  }

  // A bar cannot describe what has not happened. This is not a hypothetical
  // tidiness check: the feed's default is the exchange's own timezone, the
  // parser assumed UTC, and the whole series arrived stamped four hours ahead.
  // Every stale bar then looked like it came after the order, and a setup was
  // closed the moment it was offered by price action from its own past.
  //
  // The requests now ask for UTC outright, which fixes the cause. This refuses
  // the consequence, so a timezone that drifts again cannot reach the ledger.
  const candles = allCandles.filter((c) => c.time <= now + FUTURE_TOLERANCE_MS);

  if (candles.length === 0) {
    return { kind: 'unknown', reason: 'No price history is loaded, so what happened cannot be established.' };
  }

  const first = candles[0];
  // The order predates the history. Reading from the middle of a path would
  // miss the fill, or the stop, that happened before the candles begin.
  if (issuedAt + START_TOLERANCE_MS < first.time) {
    return {
      kind: 'unknown',
      reason:
        'The order is older than the price history the app can see, so what happened to it cannot be established from the chart.',
    };
  }

  const isLong = setup.orderType.includes('BUY');
  const instant = setup.orderType.includes('INSTANT');
  const risk = Math.abs(setup.entryPrice - setup.stopLoss);
  const expiresAt = setup.validUntil ? Date.parse(setup.validUntil) : NaN;

  // Candles from the order onward. A candle is stamped at its open, so the one
  // the order was issued inside is the last whose open is at or before it.
  let start = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time <= issuedAt) start = i;
    else break;
  }

  /**
   * The first candle that belongs wholly to this order.
   *
   * The bar already forming when an order is issued is not evidence about it.
   * Its high and low are the fifteen minutes *before* the order existed, and
   * reading an outcome from them is how a setup came to be closed the second
   * it was offered: an order one minute old, reported as filled and stopped
   * out, against a range price had traded through before anyone asked for it.
   *
   * What that bar may still do is establish a fill, below. A fill is not an
   * outcome — it writes nothing and moves no money. All it does is stop the
   * order being called a miss, which is the safer way to be wrong. An outcome
   * needs a bar that is actually about this trade.
   */
  let firstPostIssue = candles.length;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time >= issuedAt) {
      firstPostIssue = i;
      break;
    }
  }

  let fillIndex = -1;
  let fillPrice = setup.entryPrice;

  if (instant) {
    // A market order is open from the moment it is issued. Its own candle's
    // range is already partly history, so the walk starts at the next one.
    fillIndex = start;
    fillPrice = setup.entryPrice;
  } else {
    for (let i = start; i < candles.length; i++) {
      const c = candles[i];
      // A candle before the order was issued cannot fill it.
      if (c.time + CANDLE_MS <= issuedAt) continue;

      if (c.low <= setup.entryPrice && setup.entryPrice <= c.high) {
        fillIndex = i;
        fillPrice = setup.entryPrice;
        break;
      }

      // Past here the bar is being read for a reason to end the order, and
      // the bar that was forming when it was issued cannot supply one.
      if (i < firstPostIssue) continue;

      if (isLong ? c.low <= setup.stopLoss : c.high >= setup.stopLoss) {
        return {
          kind: 'missed',
          cause: 'invalidated',
          at: iso(c.time),
          reason: `Price reached the ${setup.stopLoss.toFixed(
            2
          )} invalidation without the order ever filling. The idea was void before it could open.`,
        };
      }

      const ranPast = isLong ? c.high - setup.entryPrice : setup.entryPrice - c.low;
      if (risk > 0 && ranPast >= risk) {
        return {
          kind: 'missed',
          cause: 'ran-away',
          at: iso(c.time),
          reason: `Price ran a full stop distance past the ${setup.entryPrice.toFixed(
            2
          )} entry without ever filling it. The move happened without the entry.`,
        };
      }

      if (Number.isFinite(expiresAt) && c.time > expiresAt) {
        return {
          kind: 'missed',
          cause: 'expired',
          at: iso(expiresAt),
          reason: 'The validity window closed with price never reaching the entry.',
        };
      }
    }

    if (fillIndex === -1) {
      // Nothing ended it, and it never filled. The window may still have run
      // out in the gap after the last candle.
      if (Number.isFinite(expiresAt) && now > expiresAt) {
        return {
          kind: 'missed',
          cause: 'expired',
          at: iso(expiresAt),
          reason: 'The validity window closed with price never reaching the entry.',
        };
      }
      return { kind: 'pending', reason: `Still waiting for price to reach ${setup.entryPrice.toFixed(2)}.` };
    }
  }

  const filledAt = iso(candles[fillIndex].time);
  // A resting order fills inside its bar, so that bar can also take it out. A
  // market order opens at a price the bar has already traded through. Either
  // way the scan cannot begin before the first bar that belongs to this order:
  // a fill may be read from the bar that was already forming, an exit may not.
  const scanFrom = Math.max(instant ? fillIndex + 1 : fillIndex, firstPostIssue);

  for (let i = scanFrom; i < candles.length; i++) {
    const c = candles[i];

    if (isLong ? c.low <= setup.stopLoss : c.high >= setup.stopLoss) {
      return {
        kind: 'closed',
        trigger: 'SL',
        level: 1,
        fillPrice,
        filledAt,
        exitPrice: setup.stopLoss,
        at: iso(c.time),
        reason: `The position filled at ${fillPrice.toFixed(2)} and price traded through the stop at ${setup.stopLoss.toFixed(
          2
        )}.`,
      };
    }

    const level = targetHit(setup, c, isLong);
    if (level !== null) {
      const exitPrice =
        level === 3 ? setup.takeProfit3 : level === 2 ? setup.takeProfit2 : setup.takeProfit1;
      return {
        kind: 'closed',
        trigger: (`TP${level}` as CloseTrigger),
        level,
        fillPrice,
        filledAt,
        exitPrice,
        at: iso(c.time),
        reason: `The position filled at ${fillPrice.toFixed(2)} and price reached TP${level} at ${exitPrice.toFixed(
          2
        )}.`,
      };
    }
  }

  return {
    kind: 'running',
    fillPrice,
    filledAt,
    reason: `The position filled at ${fillPrice.toFixed(2)} and is still open.`,
  };
}

/**
 * Which of the two witnesses closes a trade.
 *
 * They see different things, so neither is simply better. The candles cover the
 * hours nobody was watching, but only up to the last bar that closed; the live
 * tick is ahead of them inside the bar still forming. Either may see a level
 * reached, and the candles are preferred when both do, because they know which
 * side of a bar came first and a tick only knows where price is now.
 *
 * `replay` is null when there is nothing to replay against — no candles yet, or
 * a quote from the wrong instrument.
 */
export function resolveClose(
  replay: ReplayVerdict | null,
  tickClosedBy: CloseTrigger | null
): { trigger: CloseTrigger; level: TargetLevel; at: string | null } | null {
  if (replay?.kind === 'closed') {
    return { trigger: replay.trigger, level: replay.level, at: replay.at };
  }
  if (!tickClosedBy) return null;
  const level: TargetLevel = tickClosedBy === 'TP3' ? 3 : tickClosedBy === 'TP2' ? 2 : 1;
  return { trigger: tickClosedBy, level, at: null };
}

/**
 * Whether an order may be recorded as a missed entry, and why.
 *
 * Asymmetric with `resolveClose` on purpose. A miss is the costlier claim to
 * get wrong: it writes a loss of opportunity into the ledger and teaches the
 * engine that a setup failed. So here the candles have the final word. Once
 * they show the order opened, no reading of a single price may call it missed —
 * and that reading, price a full stop distance beyond an entry it had already
 * filled, is precisely what recorded a trade that reached its target as a miss.
 *
 * Where the candles cannot reach the order, nothing is recorded at all.
 */
export function resolveMiss(
  replay: ReplayVerdict | null,
  tickVerdict: PendingVerdict | null
): { cause: PendingVerdict['state']; reason: string } | null {
  // The order opened. Whatever the last price looks like, it was not missed.
  if (replay?.kind === 'running' || replay?.kind === 'closed') return null;
  // The path is not on record, so there is nothing to conclude from.
  if (replay?.kind === 'unknown') return null;
  if (replay?.kind === 'missed') return { cause: replay.cause, reason: replay.reason };
  // Either no candles to consult, or they agree it never filled and the tick
  // has seen the bar still forming end it.
  if (tickVerdict && tickVerdict.state !== 'waiting') {
    return { cause: tickVerdict.state, reason: tickVerdict.reason };
  }
  return null;
}

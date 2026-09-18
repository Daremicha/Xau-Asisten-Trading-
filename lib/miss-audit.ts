/**
 * Re-examines a recorded miss against the price history that followed it.
 *
 * A missed entry is a real lesson, and three different ones: an order that ran
 * away says the entry sat deeper than the market retraced, an invalidated one
 * says the directional read was wrong, an expired one says the level never came
 * back inside the window. The engine uses them. `medianMissPips` is computed
 * from them, and it is the number that decides how much closer the next entry
 * is placed.
 *
 * Which is exactly why a miss that never happened is not a harmless stray row.
 * It pushes entries toward market on the evidence of a trade that filled at the
 * depth it was given and won there, and it removes that win from the strike
 * rate at the same time. It does not merely fail to teach; it teaches the
 * opposite of what happened.
 *
 * So the rows are not deleted. They are put back to the market and asked again.
 *
 * What a stored record can answer, and what it cannot
 * ---------------------------------------------------
 * A record keeps the entry, the order type, the moment it was issued and the
 * stop distance in pips. It does not keep the targets. That bounds this audit
 * precisely, and it is worth being plain about the bound rather than papering
 * over it:
 *
 * - Whether the order ever filled: answerable, and it is the whole question for
 *   a miss. It needs the entry and the candles, nothing else.
 * - Whether a filled order then hit its stop: answerable from the stop, which
 *   is stored as a distance.
 * - Which target a profitable one reached: NOT answerable. The audit reports
 *   how far it ran, in multiples of its own risk, and the level is the user's
 *   to supply from the terminal that actually holds it.
 */

import type { Candle } from './candles';
import type { SelfLearningMemoryRecord, TradingStyle } from './types';
import { computeValidity } from './order-validity';

export type MissAuditVerdict =
  /** Price never reached the entry inside the window. The miss was real. */
  | { kind: 'genuine'; closestApproachPips: number; reason: string }
  /** The order filled and price then traded through the invalidation. */
  | { kind: 'filled-stopped'; filledAt: string; stoppedAt: string; reason: string }
  /**
   * The order filled and ran in favour without ever touching the stop. Which
   * target it reached cannot be known from the record, so the run is reported
   * and the level is asked for.
   */
  | {
      kind: 'filled-profitable';
      filledAt: string;
      bestPrice: number;
      runPips: number;
      rMultiple: number;
      reason: string;
    }
  /** Filled, neither stopped nor meaningfully in profit before the history ends. */
  | { kind: 'filled-open'; filledAt: string; lastPrice: number; reason: string }
  /** The history does not cover this record, so nothing may be concluded. */
  | { kind: 'unknown'; reason: string };

/** A candle is stamped at its open; the fifteen minute series spans this much. */
const CANDLE_MS = 15 * 60_000;

/** One candle of slack, for a setup stamped just before its own bar opened. */
const START_TOLERANCE_MS = CANDLE_MS;

/**
 * How far a run must carry to be called profitable rather than merely open.
 *
 * A fifth of the risk is past the spread and past noise, and well short of any
 * plausible first target, so nothing that reached a target is missed by it.
 */
const MEANINGFUL_RUN_R = 0.2;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The stop price the order carried.
 *
 * Kept as a distance in pips rather than a price, so the side has to come from
 * the order type: a buy is protected below its entry, a sell above.
 */
export function reconstructStop(
  record: Pick<SelfLearningMemoryRecord, 'orderType' | 'entryPrice' | 'context'>
): number | null {
  const pips = record.context?.stopLossPips;
  if (typeof pips !== 'number' || !Number.isFinite(pips) || pips <= 0) return null;
  const distance = pips / 10;
  return record.orderType.includes('BUY') ? record.entryPrice - distance : record.entryPrice + distance;
}

/**
 * How long the order was live.
 *
 * Rebuilt from the style and the kill zone flag the record kept, so the window
 * is the one the order actually had rather than a guess. A touch of the entry
 * after the window closed is not a fill; the order was already gone.
 */
function fillDeadline(record: SelfLearningMemoryRecord, issuedAt: number): number {
  const style: TradingStyle = record.tradingStyle ?? 'Intraday';
  const killZone = Boolean(record.context?.killZoneActive);
  const window = computeValidity(style, killZone, new Date(issuedAt));
  const until = Date.parse(window.validUntil);
  return Number.isFinite(until) ? until : issuedAt + 8 * 3_600_000;
}

/**
 * Puts one recorded miss back to the market.
 *
 * `candles` must be in ascending time order and should begin at or before the
 * record's own timestamp; where they do not, the verdict is `unknown` rather
 * than a reading taken from the middle of a path.
 */
export function auditMiss(
  record: SelfLearningMemoryRecord,
  candles: Candle[]
): MissAuditVerdict {
  const issuedAt = Date.parse(record.timestamp ?? '');
  if (!Number.isFinite(issuedAt)) {
    return { kind: 'unknown', reason: 'The record carries no readable timestamp.' };
  }
  if (candles.length === 0) {
    return { kind: 'unknown', reason: 'No price history was returned for this period.' };
  }
  if (issuedAt + START_TOLERANCE_MS < candles[0].time) {
    return {
      kind: 'unknown',
      reason: 'The price history does not reach back to when this order was placed.',
    };
  }

  const stop = reconstructStop(record);
  if (stop === null) {
    return { kind: 'unknown', reason: 'The record kept no stop distance, so it cannot be replayed.' };
  }

  const isLong = record.orderType.includes('BUY');
  const instant = record.orderType.includes('INSTANT');
  const entry = record.entryPrice;
  const risk = Math.abs(entry - stop);
  const deadline = fillDeadline(record, issuedAt);

  let start = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time <= issuedAt) start = i;
    else break;
  }

  let fillIndex = -1;
  // How near price came, for a miss that turns out to be genuine: it is the
  // number the engine learns the next entry's depth from.
  let closestApproach = Infinity;

  if (instant) {
    // A market order was open the moment it was issued, so a miss recorded
    // against one was never possible in the first place.
    fillIndex = start;
  } else {
    for (let i = start; i < candles.length; i++) {
      const c = candles[i];
      if (c.time + CANDLE_MS <= issuedAt) continue;
      // Past the window the order no longer existed, so a later touch of the
      // entry is not a fill.
      if (c.time > deadline) break;

      // How far this bar stayed from the entry, whichever side it was on. A
      // limit waits below the market and a stop above it, so the side is not
      // the direction of the trade and reading it from the trade would have
      // measured a buy stop backwards.
      const gap = c.low > entry ? c.low - entry : c.high < entry ? entry - c.high : 0;
      if (gap < closestApproach) closestApproach = gap;

      if (c.low <= entry && entry <= c.high) {
        fillIndex = i;
        break;
      }
    }
  }

  if (fillIndex === -1) {
    const pips = Number.isFinite(closestApproach) ? Math.max(0, closestApproach) * 10 : 0;
    return {
      kind: 'genuine',
      closestApproachPips: parseFloat(pips.toFixed(1)),
      reason: `Price never reached ${entry.toFixed(2)} while the order was live. It came within ${pips.toFixed(
        1
      )} pips. The miss was real, and its lesson stands.`,
    };
  }

  const filledAt = iso(candles[fillIndex].time);
  // A resting order fills inside its bar, so that bar can also take it out. A
  // market order opens at a price its own bar has already traded through.
  const scanFrom = instant ? fillIndex + 1 : fillIndex;
  let best = entry;

  for (let i = scanFrom; i < candles.length; i++) {
    const c = candles[i];
    // The stop comes first: the order of events inside a bar cannot be
    // recovered, and it is not one to guess in your own favour.
    if (isLong ? c.low <= stop : c.high >= stop) {
      return {
        kind: 'filled-stopped',
        filledAt,
        stoppedAt: iso(c.time),
        reason: `The order filled at ${entry.toFixed(2)} and price then traded through the stop at ${stop.toFixed(
          2
        )}. This was a stop loss, not a missed entry.`,
      };
    }
    const reach = isLong ? c.high : c.low;
    if (isLong ? reach > best : reach < best) best = reach;
  }

  const run = Math.abs(best - entry);
  const rMultiple = risk > 0 ? run / risk : 0;

  if (rMultiple >= MEANINGFUL_RUN_R) {
    return {
      kind: 'filled-profitable',
      filledAt,
      bestPrice: parseFloat(best.toFixed(2)),
      runPips: parseFloat((run * 10).toFixed(1)),
      rMultiple: parseFloat(rMultiple.toFixed(2)),
      reason: `The order filled at ${entry.toFixed(2)} and ran to ${best.toFixed(2)} — ${(run * 10).toFixed(
        1
      )} pips, ${rMultiple.toFixed(2)} times its risk — without ever touching the stop. This was not a missed entry.`,
    };
  }

  const last = candles[candles.length - 1].close;
  return {
    kind: 'filled-open',
    filledAt,
    lastPrice: parseFloat(last.toFixed(2)),
    reason: `The order filled at ${entry.toFixed(
      2
    )} but neither reached its stop nor ran meaningfully in favour within the history available.`,
  };
}

/** True when the verdict contradicts the stored outcome and needs the user. */
export function contradictsRecord(verdict: MissAuditVerdict): boolean {
  return (
    verdict.kind === 'filled-stopped' ||
    verdict.kind === 'filled-profitable' ||
    verdict.kind === 'filled-open'
  );
}

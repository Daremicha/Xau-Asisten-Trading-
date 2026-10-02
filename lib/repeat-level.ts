/**
 * Whether the level on offer already missed recently.
 *
 * The engine reads structure, and an order block or gap that an order missed
 * is often still standing on the chart, so the next analysis can offer the
 * same level again. Skipping such a level for a while was replayed over 24
 * months: from 4 hours to a month, it raised the profit factor a little but
 * left the second half of the period behind in all but one setting, so the
 * engine keeps offering it. The card says so instead, and the user decides.
 */

import type { InstitutionalTradingSetup, SelfLearningMemoryRecord } from './types';

/** How far back a miss at the same level is mentioned. */
export const REPEAT_LOOKBACK_MS = 7 * 86_400_000;
/** Entries within this many dollars count as the same level. */
export const SAME_LEVEL_DOLLARS = 1;

export interface RepeatedMiss {
  count: number;
  /** When the most recent of them was recorded, ISO. */
  lastAt: string;
}

const side = (orderType: string) => (orderType.startsWith('BUY') ? 'BUY' : 'SELL');

export function previousMisses(
  setup: Pick<InstitutionalTradingSetup, 'id' | 'orderType' | 'entryPrice'>,
  records: SelfLearningMemoryRecord[],
  now: number = Date.now()
): RepeatedMiss | null {
  const matches = records.filter((r) => {
    if (r.outcome !== 'MISSED' || r.analysisId === setup.id || r.id.startsWith('bt_')) return false;
    if (side(r.orderType) !== side(setup.orderType)) return false;
    if (Math.abs(r.entryPrice - setup.entryPrice) > SAME_LEVEL_DOLLARS) return false;
    const at = Date.parse(r.timestamp);
    return Number.isFinite(at) && now - at <= REPEAT_LOOKBACK_MS && at <= now;
  });
  if (matches.length === 0) return null;
  const lastAt = matches.reduce((a, r) => (Date.parse(r.timestamp) > Date.parse(a) ? r.timestamp : a), matches[0].timestamp);
  return { count: matches.length, lastAt };
}

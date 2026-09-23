/**
 * How much a single closed trade should count as evidence.
 *
 * Kept apart from the learning engine so other modules that read the ledger —
 * the per factor reliability measure among them — weigh a trade exactly the
 * way the engine does without importing the engine back into themselves.
 */

import type { SelfLearningMemoryRecord } from './types';

/** Trades older than this many positions back count half as much. */
const RECENCY_HALF_LIFE = 20;

/** Recency weight for a record, newest first. */
export function recencyWeight(positionFromNewest: number): number {
  return Math.pow(0.5, positionFromNewest / RECENCY_HALF_LIFE);
}

/**
 * How far an unverified machine reading counts against a checked one.
 *
 * Not zero, because most auto-resolutions are right and a row that taught
 * nothing would waste a real trade. Not one, because some were not right at
 * all: this engine has recorded a market order as filled and stopped out
 * seconds after it was offered, against a price range the market traded
 * before the order existed. Three of those went into a ledger in four
 * minutes, each one a loss the account never took and a failure against a
 * setup that never lost.
 *
 * At six tenths an unverified row still teaches, and a checked one outweighs
 * it. That is the honest ordering: a reading the market has confirmed, or the
 * trader has confirmed from their own terminal, is worth more than a reading
 * nobody has looked at.
 */
const UNVERIFIED_WEIGHT = 0.6;

/**
 * How much a single record should count.
 *
 * Recency, and then whether anyone has checked it. A result the user entered
 * is their own testimony about their own terminal. A row the audit has been
 * over has been held against the candles of its own lifetime. A row the engine
 * closed by itself and nobody has examined is an inference, and is weighed as
 * one.
 */
export function evidenceWeight(
  record: Pick<SelfLearningMemoryRecord, 'autoResolved' | 'audit'>,
  positionFromNewest: number
): number {
  return recencyWeight(positionFromNewest) * verificationWeight(record);
}

/** One for a result someone has checked, less for one nobody has. */
export function verificationWeight(record: Pick<SelfLearningMemoryRecord, 'autoResolved' | 'audit'>): number {
  const verified = !record.autoResolved || Boolean(record.audit);
  return verified ? 1 : UNVERIFIED_WEIGHT;
}


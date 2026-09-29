/**
 * A nearer first target, for a user who would rather win more often.
 *
 * The structural engine's own targets sit at 1.2 to 1.6R and win about 43% of
 * filled trades. A single target at 0.5R wins about 72% of them, each for less.
 * On the 24 month replay (Intraday, take-all, stop to entry at 1R, 3% daily
 * limit) it earned 68R against the engine's 104R, and its first half was
 * nearly flat.
 *
 * Replayed from 337 Cent at eight different starting months, it was neither
 * reliably safer nor faster: the engine's targets reached 1 000 Cent in seven
 * of the eight and usually sooner; the quick target in six. Its deepest drop was
 * smaller in four starts and far larger in three (51% and 57% against 27% and
 * 26%). So it is the user's choice, off by default, and the setting says so.
 * The entry, the stop and the lot are the engine's either way.
 */

/** Multiple of risk the single target sits at. */
export const QUICK_TARGET_R = 0.5;

/** All three targets at 0.5R: the replay closes the whole trade at the first one. */
export function quickTargets(
  entryPrice: number,
  stopLoss: number,
  direction: 'long' | 'short'
): { takeProfit1: number; takeProfit2: number; takeProfit3: number } {
  const risk = Math.abs(entryPrice - stopLoss);
  const tp =
    Math.round((direction === 'long' ? entryPrice + QUICK_TARGET_R * risk : entryPrice - QUICK_TARGET_R * risk) * 100) /
    100;
  return { takeProfit1: tp, takeProfit2: tp, takeProfit3: tp };
}

/**
 * Re-examines a recorded trade against the price history it claims to describe.
 *
 * Every row the engine closed by itself is a claim about the market: that an
 * order filled, or never did, and that price reached a particular level. Those
 * claims were made from a single number — whatever the screen was showing when
 * it happened to look — and a single number cannot describe a path. When the
 * number was wrong, the claim went into the ledger anyway, the balance moved,
 * and the engine learned from it.
 *
 * Each kind of wrong row teaches its own wrong lesson:
 *
 * - A miss that never happened inflates `missRate` and drags `medianMissPips`,
 *   the number that decides how much closer the next entry is placed. It pushes
 *   entries toward market on the evidence of a trade that filled where it was
 *   put and won there.
 * - A stop loss that never happened is worse still: it is a loss in the ledger
 *   and a failure in the engine's record of a setup that never lost.
 *
 * So nothing here is deleted. Each row is walked through the candles of its own
 * lifetime — from when the order was placed to when the row was written — and
 * either stands or is handed back with what the market actually did.
 *
 * What a stored row can answer, and what it cannot
 * ------------------------------------------------
 * A row keeps the entry, the order type, the claimed exit and the stop distance
 * in pips. It keeps no lot size, so a corrected result in money cannot be
 * recomputed and is asked for. And until recently it kept no placement time
 * either — only the moment it was written, which for a miss can be hours after
 * the order was placed. That is recovered from the analysis id, which encodes
 * it, and stored outright on new rows.
 */

import type { Candle } from './candles';
import type { SelfLearningMemoryRecord } from './types';

export type AuditKind = 'confirmed' | 'contradicted' | 'unknown';

export interface RecordAuditVerdict {
  kind: AuditKind;
  /** What the candles show actually happened, when they show anything. */
  actual: 'never-filled' | 'stopped' | 'reached-level' | 'open' | null;
  reason: string;
  /** Present when the path is readable: the best price the trade ever saw. */
  bestPrice?: number;
  filledAt?: string;
}

/** A candle is stamped at its open; the execution series spans this much. */
const CANDLE_MS = 15 * 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * When the order was actually placed.
 *
 * `timestamp` on a row is when the row was written, which is when the trade
 * *ended*. Auditing from there would search the wrong window entirely — for a
 * miss, hours after the order was already gone.
 *
 * New rows carry `placedAt`. Older ones do not, but the analysis id they were
 * built from is `setup_<base36 milliseconds><four random characters>`, so the
 * placement time is recoverable from rows written before the field existed.
 */
export function placementTime(
  record: Pick<SelfLearningMemoryRecord, 'analysisId' | 'timestamp'> & { placedAt?: string }
): number | null {
  const explicit = Date.parse(record.placedAt ?? '');
  if (Number.isFinite(explicit)) return explicit;

  const id = record.analysisId ?? '';
  const match = /^[a-z]+_([0-9a-z]+)$/i.exec(id);
  if (match) {
    // The last four characters are random padding, not part of the number.
    const body = match[1].slice(0, -4);
    const decoded = parseInt(body, 36);
    // Sanity: a plausible millisecond timestamp, not a coincidence of letters.
    if (Number.isFinite(decoded) && decoded > Date.UTC(2020, 0, 1) && decoded < Date.UTC(2100, 0, 1)) {
      return decoded;
    }
  }
  return null;
}

/**
 * The stop price the order carried.
 *
 * Kept as a distance in pips rather than a price, so the side comes from the
 * order type: a buy is protected below its entry, a sell above.
 */
export function reconstructStop(
  record: Pick<SelfLearningMemoryRecord, 'orderType' | 'entryPrice' | 'context'>
): number | null {
  const pips = record.context?.stopLossPips;
  if (typeof pips !== 'number' || !Number.isFinite(pips) || pips <= 0) return null;
  const distance = pips / 10;
  return record.orderType.includes('BUY') ? record.entryPrice - distance : record.entryPrice + distance;
}

/** Whether the most favourable price reached a level, on the trade's own side. */
function reached(best: number, level: number, isLong: boolean): boolean {
  return isLong ? best >= level : best <= level;
}

/**
 * Puts one recorded trade back to the market.
 *
 * The walk is bounded to the trade's own lifetime: from when the order was
 * placed to when the row was written. Price action outside that window belongs
 * to no part of this trade, and letting it in is how a level the market reached
 * an hour later came to be read as the level this order closed at.
 *
 * `candles` must be in ascending time order.
 */
export function auditRecord(
  record: SelfLearningMemoryRecord & { placedAt?: string },
  candles: Candle[]
): RecordAuditVerdict {
  const placed = placementTime(record);
  const closed = Date.parse(record.timestamp ?? '');

  if (placed === null || !Number.isFinite(closed)) {
    return { kind: 'unknown', actual: null, reason: 'Baris ini tidak mencatat kapan ordernya dipasang, jadi tidak bisa diuji ulang.' };
  }
  if (candles.length === 0) {
    return { kind: 'unknown', actual: null, reason: 'Tidak ada riwayat harga untuk periode ini.' };
  }

  const stop = reconstructStop(record);
  if (stop === null) {
    return { kind: 'unknown', actual: null, reason: 'Baris ini tidak menyimpan jarak stop, jadi tidak bisa diuji ulang.' };
  }

  // Candles overlapping the trade's lifetime. A trade that opened and closed
  // inside one candle still gets that candle, and its range is enough to say
  // whether a level was touched.
  const window = candles.filter((c) => c.time + CANDLE_MS > placed && c.time <= Math.max(closed, placed));
  if (window.length === 0) {
    return {
      kind: 'unknown',
      actual: null,
      reason: 'Riwayat harga tidak mencakup menit-menit saat trade ini terbuka.',
    };
  }

  const isLong = record.orderType.includes('BUY');
  const instant = record.orderType.includes('INSTANT');
  const entry = record.entryPrice;

  let fillIndex = instant ? 0 : -1;
  let closest = Infinity;

  if (!instant) {
    for (let i = 0; i < window.length; i++) {
      const c = window[i];
      const gap = c.low > entry ? c.low - entry : c.high < entry ? entry - c.high : 0;
      if (gap < closest) closest = gap;
      if (c.low <= entry && entry <= c.high) {
        fillIndex = i;
        break;
      }
    }
  }

  if (fillIndex === -1) {
    const pips = Number.isFinite(closest) ? Math.max(0, closest) * 10 : 0;
    const never = `Harga tidak pernah mencapai ${entry.toFixed(2)} selama order ini aktif; paling dekat ${pips.toFixed(
      1
    )} pips.`;
    if (record.outcome === 'MISSED') {
      return {
        kind: 'confirmed',
        actual: 'never-filled',
        reason: `${never} Missed-nya nyata, dan pelajarannya tetap berlaku.`,
      };
    }
    return {
      kind: 'contradicted',
      actual: 'never-filled',
      reason: `${never} Tercatat sebagai ${record.outcome === 'TP' ? 'take profit' : 'stop loss'}, tapi order tidak pernah terbuka.`,
    };
  }

  const filledAt = iso(window[fillIndex].time);
  // A resting order fills inside its bar, so that bar can also take it out. A
  // market order opens at a price its own bar has already traded through.
  const scanFrom = instant ? fillIndex + 1 : fillIndex;

  /**
   * The first bar that opened after the order was placed.
   *
   * The bar already forming at placement straddles the moment: most of it is
   * from before the trade existed, a sliver of it from after. That makes it
   * two different kinds of evidence depending on the question.
   *
   * It can REFUTE. If even that bar never reached a level, price did not
   * reach it, whichever minute you look at.
   *
   * It cannot CONFIRM. Its high may have been set an hour before anyone asked
   * for the trade — and confirming from it is exactly what this audit exists
   * to prevent. Left alone it certified a fabricated take profit as "the win
   * is real", which is worse than not checking at all.
   *
   * So a level reached only inside that bar is neither, and says so.
   */
  let firstPostPlacement = window.length;
  for (let i = 0; i < window.length; i++) {
    if (window[i].time >= placed) {
      firstPostPlacement = i;
      break;
    }
  }

  let stoppedAt: string | null = null;
  /** Set only when the stop was reached by a bar wholly after placement. */
  let stoppedAfterPlacement = false;
  let best = entry;
  /** The best price reached by bars wholly after placement. */
  let bestAfterPlacement = entry;

  for (let i = scanFrom; i < window.length; i++) {
    const c = window[i];
    // The stop is read first: the order of events inside a bar cannot be
    // recovered, and it is not one to guess in your own favour.
    if (isLong ? c.low <= stop : c.high >= stop) {
      stoppedAt = iso(c.time);
      stoppedAfterPlacement = i >= firstPostPlacement;
      break;
    }
    if (i >= firstPostPlacement) {
      const reachPost = isLong ? c.high : c.low;
      if (reached(reachPost, bestAfterPlacement, isLong) && reachPost !== bestAfterPlacement) {
        bestAfterPlacement = reachPost;
      }
    }
    const reach = isLong ? c.high : c.low;
    if (reached(reach, best, isLong) && reach !== best) best = reach;
  }

  const bestPrice = parseFloat(best.toFixed(2));

  if (record.outcome === 'MISSED') {
    return {
      kind: 'contradicted',
      actual: stoppedAt ? 'stopped' : 'open',
      filledAt,
      bestPrice,
      reason: stoppedAt
        ? `Order terisi di ${entry.toFixed(2)} lalu harga menembus stop di ${stop.toFixed(
            2
          )}. Ini stop loss, bukan entry missed.`
        : `Order terisi di ${entry.toFixed(2)} dan bergerak sampai ${bestPrice.toFixed(
            2
          )} tanpa menyentuh stop. Ini bukan entry missed.`,
    };
  }

  if (record.outcome === 'SL') {
    if (stoppedAfterPlacement) {
      return {
        kind: 'confirmed',
        actual: 'stopped',
        filledAt,
        bestPrice,
        reason: `Harga memang menembus stop di ${stop.toFixed(2)}. Kerugiannya nyata.`,
      };
    }
    if (stoppedAt) {
      // Only the bar straddling placement reached it. That bar is mostly from
      // before the trade existed, so this neither stands nor falls here.
      return {
        kind: 'unknown',
        actual: null,
        filledAt,
        bestPrice,
        reason: `Stop di ${stop.toFixed(
          2
        )} hanya tersentuh di dalam candle saat order dipasang, yang sebagian besar terjadi sebelum order itu ada. Grafik tidak bisa memastikan yang ini.`,
      };
    }
    return {
      kind: 'contradicted',
      actual: 'open',
      filledAt,
      bestPrice,
      reason: `Harga tidak pernah mencapai stop di ${stop.toFixed(
        2
      )} selama trade ini terbuka — paling jauh sampai ${bestPrice.toFixed(
        2
      )}. Kerugian ini dicatat di level yang tidak pernah disentuh pasar.`,
    };
  }

  // A take profit: the level it claims to have closed at is its own exit price.
  const claimed = record.exitPrice;
  if (stoppedAfterPlacement) {
    return {
      kind: 'contradicted',
      actual: 'stopped',
      filledAt,
      bestPrice,
      reason: `Harga menembus stop di ${stop.toFixed(2)} sebelum mencapai ${claimed.toFixed(
        2
      )}. Ini rugi, bukan take profit.`,
    };
  }
  // Confirmed only from bars that are wholly this trade's. A high set before
  // the order was placed is not a win it earned.
  if (Number.isFinite(claimed) && reached(bestAfterPlacement, claimed, isLong)) {
    return {
      kind: 'confirmed',
      actual: 'reached-level',
      filledAt,
      bestPrice,
      reason: `Harga memang mencapai ${claimed.toFixed(2)}. Kemenangannya nyata.`,
    };
  }
  // The whole window did reach it, but only inside the candle the order was
  // placed in. That is not evidence either way.
  if (Number.isFinite(claimed) && (reached(best, claimed, isLong) || stoppedAt)) {
    return {
      kind: 'unknown',
      actual: null,
      filledAt,
      bestPrice,
      reason: `${claimed.toFixed(
        2
      )} hanya tersentuh di dalam candle saat order dipasang, yang sebagian besar terjadi sebelum order itu ada. Grafik tidak bisa memastikan yang ini.`,
    };
  }
  return {
    kind: 'contradicted',
    actual: 'open',
    filledAt,
    bestPrice,
    reason: `Harga tidak pernah mencapai ${claimed.toFixed(
      2
    )} selama trade ini terbuka — paling jauh sampai ${bestPrice.toFixed(
      2
    )}. Kemenangan ini dicatat di level yang tidak pernah disentuh pasar.`,
  };
}

/** True when the verdict disagrees with what the row says, and needs the user. */
export function contradictsRecord(verdict: RecordAuditVerdict): boolean {
  return verdict.kind === 'contradicted';
}

/**
 * Rows worth putting back to the market.
 *
 * Only the ones the engine closed by itself. A result the user entered is their
 * own testimony about their own terminal, and this has no standing to dispute
 * it. Rows already settled by a previous audit are left alone.
 */
export function auditableRecords(
  records: Array<SelfLearningMemoryRecord & { placedAt?: string }>
): Array<SelfLearningMemoryRecord & { placedAt?: string }> {
  return records.filter((r) => r.autoResolved && !r.audit);
}

/**
 * Puts corrected results typed in cents back into dollars.
 *
 * The correction form asked for the result in the account's unit ("Result
 * (Cent)") and stored the number as dollars, so an 18 cent stop typed as 18
 * was recorded as an 18 dollar one, 1 800 cents. Every correction made before
 * the unit was recorded on the row is converted once, on a cent account only:
 * on a dollar account the label and the storage already agreed.
 */
export function repairCorrectionUnits(
  records: SelfLearningMemoryRecord[],
  accountType: string | null | undefined
): { records: SelfLearningMemoryRecord[]; repaired: SelfLearningMemoryRecord[] } {
  if (accountType !== 'Cent') return { records, repaired: [] };
  const repaired: SelfLearningMemoryRecord[] = [];
  const next = records.map((r) => {
    if (r.audit?.verdict !== 'corrected' || r.audit.moneyUnit === 'USD') return r;
    const fixed: SelfLearningMemoryRecord = {
      ...r,
      profitOrLossDollars: parseFloat(((r.profitOrLossDollars || 0) / 100).toFixed(4)),
      audit: { ...r.audit, moneyUnit: 'USD' },
    };
    repaired.push(fixed);
    return fixed;
  });
  return { records: repaired.length ? next : records, repaired };
}

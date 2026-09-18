/**
 * Puts recorded misses back to the market and reports what it finds.
 *
 * Read only. Nothing here rewrites a record: the endpoint returns a verdict per
 * row and the user decides what to do with it. A ledger corrected on the
 * strength of an automatic re-reading, with no one asked, would be the same
 * mistake that produced the false rows in the first place — a machine deciding
 * what happened to someone else's money from evidence it had not checked.
 */

import { NextResponse } from 'next/server';
import { fetchHistoricalCandles } from '@/lib/price-feed';
import { auditMiss, contradictsRecord, type MissAuditVerdict } from '@/lib/miss-audit';
import { publicErrorMessage } from '@/lib/safe-error';
import type { SelfLearningMemoryRecord } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Records older than this are past what the provider will serve in one call. */
const MAX_LOOKBACK_MS = 60 * 24 * 3_600_000;

/** A ledger far larger than this is not audited in one request. */
const MAX_RECORDS = 200;

function looksLikeRecord(value: unknown): value is SelfLearningMemoryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.timestamp === 'string' &&
    typeof r.orderType === 'string' &&
    typeof r.entryPrice === 'number' &&
    r.outcome === 'MISSED'
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Request body is not valid JSON.' }, { status: 400 });
  }

  const raw = (body as { records?: unknown })?.records;
  if (!Array.isArray(raw)) {
    return NextResponse.json(
      { success: false, error: 'Send a records array of missed-entry rows to examine.' },
      { status: 400 }
    );
  }

  const records = raw.filter(looksLikeRecord).slice(0, MAX_RECORDS);
  if (records.length === 0) {
    return NextResponse.json({
      success: true,
      audited: 0,
      contradicted: 0,
      results: [],
      message: 'There are no missed entries to examine.',
    });
  }

  try {
    const now = Date.now();
    const times = records
      .map((r) => Date.parse(r.timestamp))
      .filter((t) => Number.isFinite(t));
    if (times.length === 0) {
      return NextResponse.json(
        { success: false, error: 'None of these records carry a readable timestamp.' },
        { status: 400 }
      );
    }

    // One window covering every record, so the whole audit costs one request.
    // Started a little before the earliest so the first order's own candle is
    // included, and run to now so a recent record's path is complete.
    const earliest = Math.max(Math.min(...times) - 2 * 3_600_000, now - MAX_LOOKBACK_MS);
    const { candles, message } = await fetchHistoricalCandles(earliest, now);

    if (candles.length === 0) {
      return NextResponse.json({
        success: false,
        audited: 0,
        contradicted: 0,
        results: [],
        // Not a verdict. The rows stay exactly as they are.
        message: message || 'Past prices could not be fetched, so nothing was examined.',
      });
    }

    const results = records.map((record) => {
      const verdict: MissAuditVerdict = auditMiss(record, candles);
      return {
        id: record.id,
        timestamp: record.timestamp,
        orderType: record.orderType,
        entryPrice: record.entryPrice,
        verdict,
        contradicted: contradictsRecord(verdict),
      };
    });

    const contradicted = results.filter((r) => r.contradicted).length;
    const genuine = results.filter((r) => r.verdict.kind === 'genuine').length;
    const unknown = results.filter((r) => r.verdict.kind === 'unknown').length;

    return NextResponse.json({
      success: true,
      audited: results.length,
      contradicted,
      genuine,
      unknown,
      candleCount: candles.length,
      examinedFrom: new Date(candles[0].time).toISOString(),
      results,
      message:
        contradicted === 0
          ? `All ${results.length} missed entries stand up to the price history.`
          : `${contradicted} of ${results.length} were not missed entries at all.`,
    });
  } catch (err: unknown) {
    console.error('Audit error:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err, 'The audit could not be completed.') },
      { status: 500 }
    );
  }
}

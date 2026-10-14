/**
 * Puts recorded trades back to the market and reports what it finds.
 *
 * Read only. Nothing here rewrites a record: the endpoint returns a verdict per
 * row and the user decides what to do with it. A ledger corrected on the
 * strength of an automatic re-reading, with no one asked, would be the same
 * mistake that produced the false rows in the first place — a machine deciding
 * what happened to someone else's money from evidence it had not checked.
 */

import { NextResponse } from 'next/server';
import { fetchHistoricalCandles } from '@/lib/price-feed';
import {
  auditRecord,
  contradictsRecord,
  placementTime,
  type RecordAuditVerdict,
} from '@/lib/record-audit';
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
    typeof r.exitPrice === 'number' &&
    (r.outcome === 'MISSED' || r.outcome === 'TP' || r.outcome === 'SL')
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Isi permintaan bukan JSON yang valid.' }, { status: 400 });
  }

  const raw = (body as { records?: unknown })?.records;
  if (!Array.isArray(raw)) {
    return NextResponse.json(
      { success: false, error: 'Kirim array records berisi baris yang sudah selesai untuk diperiksa.' },
      { status: 400 }
    );
  }

  const records = raw.filter(looksLikeRecord).slice(0, MAX_RECORDS);
  if (records.length === 0) {
    return NextResponse.json({
      success: true,
      audited: 0,
      contradicted: 0,
      genuine: 0,
      unknown: 0,
      results: [],
      message: 'Tidak ada baris lagi yang perlu diperiksa.',
    });
  }

  try {
    const now = Date.now();
    // Placement, not the moment the row was written: a miss is recorded long
    // after its order went on the book, and the window has to reach the start.
    const times = records
      .map((r) => placementTime(r))
      .filter((t): t is number => t !== null);
    if (times.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Tidak ada baris yang mencatat kapan ordernya dipasang.' },
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
        genuine: 0,
        unknown: 0,
        results: [],
        // Not a verdict. The rows stay exactly as they are.
        message: message || 'Harga lama tidak bisa diambil, jadi tidak ada yang diperiksa.',
      });
    }

    const results = records.map((record) => {
      const verdict: RecordAuditVerdict = auditRecord(record, candles);
      return {
        id: record.id,
        timestamp: record.timestamp,
        orderType: record.orderType,
        entryPrice: record.entryPrice,
        outcome: record.outcome,
        recordedExit: record.exitPrice,
        recordedResult: record.profitOrLossDollars,
        verdict,
        contradicted: contradictsRecord(verdict),
      };
    });

    const contradicted = results.filter((r) => r.contradicted).length;
    const genuine = results.filter((r) => r.verdict.kind === 'confirmed').length;
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
          ? `Semua ${results.length} baris sesuai dengan riwayat harga.`
          : `${contradicted} dari ${results.length} baris menggambarkan sesuatu yang tidak pernah dilakukan pasar.`,
    });
  } catch (err: unknown) {
    console.error('Audit error:', err);
    return NextResponse.json(
      { success: false, error: publicErrorMessage(err, 'Pemeriksaan tidak bisa diselesaikan.') },
      { status: 500 }
    );
  }
}

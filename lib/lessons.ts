/**
 * What the user's own trades say, in plain sentences.
 *
 * The self-learning engine adjusts numbers; this explains, from the recorded
 * trades, which kinds of setup have been paying and which have been losing,
 * so the learning can be seen rather than taken on trust. Each lesson says how
 * many trades it rests on: a pattern in five trades is an early sign, not a
 * finding, and is labelled as one.
 */

import type { SelfLearningMemoryRecord } from './types';
import { expectancyInterval, MIN_INTERVAL_TRADES } from './robustness';
import { TESTED_EXPECTANCY_R } from './tested-configuration';

export interface Lesson {
  tone: 'good' | 'bad' | 'info';
  title: string;
  detail: string;
}

/** Filled trades a group needs before it is mentioned at all. */
export const LESSON_MIN_TRADES = 3;
/** Filled trades from which a pattern is called more than an early sign. */
export const LESSON_SOLID_TRADES = 8;
/** Average result, in R, a group must beat (either way) to be worth a lesson. */
const LESSON_MIN_EDGE_R = 0.25;

interface Group {
  label: string;
  trades: number;
  wins: number;
  averageR: number;
}

const wib = (iso: string | undefined): number | null => {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 7 * 3_600_000).getUTCHours();
};

/** The session a trade was placed in, by the WIB clock. */
export function sessionOfTrade(record: SelfLearningMemoryRecord): string | null {
  const h = wib(record.placedAt ?? record.timestamp);
  if (h === null) return null;
  if (h >= 7 && h < 14) return 'sesi Asia (07:00–14:00 WIB)';
  if (h >= 14 && h < 19) return 'sesi London (14:00–19:00 WIB)';
  if (h >= 19) return 'sesi New York (19:00–24:00 WIB)';
  return 'jam larut (00:00–07:00 WIB)';
}

function rOf(record: SelfLearningMemoryRecord): number {
  const r = record.context?.rMultiple;
  if (typeof r === 'number' && Number.isFinite(r)) return r;
  return record.outcome === 'TP' ? 1 : -1;
}

function groupBy(
  filled: SelfLearningMemoryRecord[],
  key: (r: SelfLearningMemoryRecord) => string | null
): Group[] {
  const map = new Map<string, SelfLearningMemoryRecord[]>();
  for (const r of filled) {
    const k = key(r);
    if (k === null) continue;
    (map.get(k) ?? map.set(k, []).get(k)!).push(r);
  }
  return [...map.entries()].map(([label, rows]) => ({
    label,
    trades: rows.length,
    wins: rows.filter((r) => r.outcome === 'TP' && rOf(r) > 0.05).length,
    averageR: rows.reduce((a, r) => a + rOf(r), 0) / rows.length,
  }));
}

const signedR = (r: number) => `${r > 0 ? '+' : ''}${r.toFixed(2)}R`;
const weight = (trades: number) =>
  trades >= LESSON_SOLID_TRADES ? `${trades} trade` : `baru ${trades} trade, tanda awal`;

/** One dimension: name its best and worst group when they stand apart. */
function lessonsFor(
  groups: Group[],
  describe: (label: string) => string
): Lesson[] {
  const usable = groups.filter((g) => g.trades >= LESSON_MIN_TRADES);
  if (usable.length < 2) return [];
  const sorted = [...usable].sort((a, b) => b.averageR - a.averageR);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const out: Lesson[] = [];
  if (worst.averageR <= -LESSON_MIN_EDGE_R) {
    out.push({
      tone: 'bad',
      title: `${describe(worst.label)} sedang rugi`,
      detail: `${worst.wins} dari ${worst.trades} menang, ${signedR(worst.averageR)} per trade (${weight(worst.trades)}).`,
    });
  }
  if (best.averageR >= LESSON_MIN_EDGE_R && best !== worst) {
    out.push({
      tone: 'good',
      title: `${describe(best.label)} sedang untung`,
      detail: `${best.wins} dari ${best.trades} menang, ${signedR(best.averageR)} per trade (${weight(best.trades)}).`,
    });
  }
  return out;
}

/**
 * Whether the user's live trades are behaving like the replay the settings
 * rest on. A backtest is a claim; live fills are the check on it. With few
 * trades the honest answer is that the two cannot be told apart yet.
 */
export function liveVersusReplay(records: SelfLearningMemoryRecord[]): Lesson {
  const filled = records.filter((r) => !r.id.startsWith('bt_') && (r.outcome === 'TP' || r.outcome === 'SL'));
  const replay = signedR(TESTED_EXPECTANCY_R);
  const range = expectancyInterval(filled.map(rOf));
  if (!range) {
    return {
      tone: 'info',
      title: `Live dibanding backtest: ${filled.length} trade tertutup`,
      detail: `Backtest menghasilkan ${replay} per trade. Perbandingan yang adil butuh minimal ${MIN_INTERVAL_TRADES} trade live tertutup.`,
    };
  }
  const span = `${signedR(range.low)} sampai ${signedR(range.high)}`;
  if (range.high < TESTED_EXPECTANCY_R) {
    return {
      tone: 'bad',
      title: `Trade live lebih buruk daripada backtest`,
      detail: `${range.trades} trade rata-rata ${signedR(range.mean)}, dan bahkan batas atas rentang 95% (${span}) masih di bawah backtest ${replay}. Fill, biaya, atau pasar yang nyata tidak sama dengan yang diuji: kurangi risiko, atau trading di akun demo, sampai ini berubah.`,
    };
  }
  if (range.low > TESTED_EXPECTANCY_R) {
    return {
      tone: 'good',
      title: `Trade live lebih baik daripada backtest`,
      detail: `${range.trades} trade rata-rata ${signedR(range.mean)}, dengan seluruh rentang 95% (${span}) di atas backtest ${replay}. Keberuntungan juga ikut berperan; jangan menaikkan risiko karenanya.`,
    };
  }
  return {
    tone: 'info',
    title: `Trade live sejauh ini sejalan dengan backtest`,
    detail: `${range.trades} trade rata-rata ${signedR(range.mean)}. Rentang 95% (${span}) mencakup backtest ${replay}, jadi selisihnya masih dalam batas kebetulan. Makin banyak trade, rentangnya makin sempit.`,
  };
}

/**
 * The lessons in the user's own trades. Replayed (backtest) rows are left out:
 * these are about what happened when real orders were placed.
 */
export function tradeLessons(records: SelfLearningMemoryRecord[]): Lesson[] {
  const live = records.filter((r) => !r.id.startsWith('bt_'));
  const filled = live.filter((r) => r.outcome === 'TP' || r.outcome === 'SL');
  const missed = live.filter((r) => r.outcome === 'MISSED');

  if (filled.length < 5) {
    return [
      {
        tone: 'info',
        title: 'Trade tertutup belum cukup',
        detail: `${filled.length} tertutup sejauh ini. Pelajaran muncul mulai lima trade, dan lebih berarti mulai dua puluh.`,
      },
    ];
  }

  const lessons: Lesson[] = [];

  // The recent run, so a bad patch is named as one.
  const recent = filled.slice(-10);
  const recentR = recent.reduce((a, r) => a + rOf(r), 0);
  const recentWins = recent.filter((r) => rOf(r) > 0.05).length;
  lessons.push({
    tone: recentR >= 0 ? 'good' : 'bad',
    title: `${recent.length} trade terakhir: ${recentWins} menang, total ${signedR(recentR)}`,
    detail:
      recentR >= 0
        ? 'Engine sedang dalam periode untung.'
        : 'Periode rugi. Di backtest dua tahun, satu dari tiga rangkaian sepuluh trade rugi, dan totalnya tetap tumbuh.',
  });

  lessons.push(
    ...lessonsFor(
      groupBy(filled, (r) => (r.orderType.startsWith('BUY') ? 'BUY' : 'SELL')),
      (label) => `Setup ${label}`
    ),
    ...lessonsFor(
      groupBy(filled, (r) => (r.orderType.includes('INSTANT') ? 'market' : 'resting')),
      (label) => (label === 'market' ? 'Order yang terisi di harga market (instant)' : 'Order pending (limit dan stop)')
    ),
    ...lessonsFor(groupBy(filled, sessionOfTrade), (label) => `Trade yang dipasang di ${label}`),
    ...lessonsFor(
      groupBy(filled, (r) => r.context?.anchor ?? null),
      (label) => (label === 'Market' ? 'Entry di harga market' : `Entry ${label}`)
    ),
    ...lessonsFor(
      groupBy(filled, (r) =>
        r.context ? (r.context.timeframesAligned ? 'aligned' : 'split') : null
      ),
      (label) => (label === 'aligned' ? 'Setup dengan D1, H4, dan H1 searah' : 'Setup dengan timeframe yang tidak searah')
    ),
    ...lessonsFor(
      groupBy(filled, (r) => {
        const c = r.context?.convictionScore;
        if (typeof c !== 'number') return null;
        return c >= 55 ? 'high' : c >= 40 ? 'mid' : 'low';
      }),
      (label) =>
        label === 'high' ? 'Setup dengan skor 55 ke atas' : label === 'mid' ? 'Setup dengan skor 40 sampai 54' : 'Setup dengan skor di bawah 40'
    )
  );

  if (live.length > 0 && missed.length / live.length >= 0.4) {
    lessons.push({
      tone: 'info',
      title: `${missed.length} dari ${live.length} order tidak pernah terisi`,
      detail:
        'Order missed tidak ada ruginya: harganya saja yang tidak sampai. Diuji dua tahun, mengejar pergerakan itu atau memindah entry lebih dekat hasilnya lebih kecil, jadi engine tetap menunggu levelnya.',
    });
  }

  return lessons;
}

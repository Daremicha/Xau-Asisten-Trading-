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
  if (h >= 7 && h < 14) return 'the Asian session (07:00–14:00 WIB)';
  if (h >= 14 && h < 19) return 'the London session (14:00–19:00 WIB)';
  if (h >= 19) return 'the New York session (19:00–24:00 WIB)';
  return 'late hours (00:00–07:00 WIB)';
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
  trades >= LESSON_SOLID_TRADES ? `${trades} trades` : `only ${trades} trades, an early sign`;

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
      title: `${describe(worst.label)} have been losing`,
      detail: `${worst.wins} of ${worst.trades} won, ${signedR(worst.averageR)} per trade (${weight(worst.trades)}).`,
    });
  }
  if (best.averageR >= LESSON_MIN_EDGE_R && best !== worst) {
    out.push({
      tone: 'good',
      title: `${describe(best.label)} have been paying`,
      detail: `${best.wins} of ${best.trades} won, ${signedR(best.averageR)} per trade (${weight(best.trades)}).`,
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
      title: `Live against the replay: ${filled.length} closed trades`,
      detail: `The replay earned ${replay} a trade. A fair comparison needs at least ${MIN_INTERVAL_TRADES} closed live trades.`,
    };
  }
  const span = `${signedR(range.low)} to ${signedR(range.high)}`;
  if (range.high < TESTED_EXPECTANCY_R) {
    return {
      tone: 'bad',
      title: `Live trades are doing worse than the replay`,
      detail: `${range.trades} trades averaged ${signedR(range.mean)}, and even the top of the 95% range (${span}) is under the replay's ${replay}. Real fills, costs or the market are not what was tested: cut the risk, or trade on paper, until this changes.`,
    };
  }
  if (range.low > TESTED_EXPECTANCY_R) {
    return {
      tone: 'good',
      title: `Live trades are doing better than the replay`,
      detail: `${range.trades} trades averaged ${signedR(range.mean)}, with the whole 95% range (${span}) above the replay's ${replay}. Good luck counts too; do not raise the risk on it.`,
    };
  }
  return {
    tone: 'info',
    title: `Live trades are in line with the replay so far`,
    detail: `${range.trades} trades averaged ${signedR(range.mean)}. The 95% range (${span}) includes the replay's ${replay}, so the difference is still within chance. More trades narrow the range.`,
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
        title: 'Not enough closed trades yet',
        detail: `${filled.length} closed so far. Lessons appear from five, and mean more from twenty.`,
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
    title: `Last ${recent.length} closed trades: ${recentWins} won, ${signedR(recentR)} in total`,
    detail:
      recentR >= 0
        ? 'The engine is in a paying stretch.'
        : 'A losing stretch. In the two year replay, one run of ten trades in three lost money, and the totals still grew.',
  });

  lessons.push(
    ...lessonsFor(
      groupBy(filled, (r) => (r.orderType.startsWith('BUY') ? 'BUY' : 'SELL')),
      (label) => `${label} setups`
    ),
    ...lessonsFor(
      groupBy(filled, (r) => (r.orderType.includes('INSTANT') ? 'market' : 'resting')),
      (label) => (label === 'market' ? 'Orders filled at market (instant)' : 'Resting orders (limit and stop)')
    ),
    ...lessonsFor(groupBy(filled, sessionOfTrade), (label) => `Trades placed in ${label}`),
    ...lessonsFor(
      groupBy(filled, (r) => r.context?.anchor ?? null),
      (label) => (label === 'Market' ? 'Entries at market price' : `${label} entries`)
    ),
    ...lessonsFor(
      groupBy(filled, (r) =>
        r.context ? (r.context.timeframesAligned ? 'aligned' : 'split') : null
      ),
      (label) => (label === 'aligned' ? 'Setups with D1, H4 and H1 agreeing' : 'Setups with the timeframes split')
    ),
    ...lessonsFor(
      groupBy(filled, (r) => {
        const c = r.context?.convictionScore;
        if (typeof c !== 'number') return null;
        return c >= 55 ? 'high' : c >= 40 ? 'mid' : 'low';
      }),
      (label) =>
        label === 'high' ? 'Setups scoring 55 or more' : label === 'mid' ? 'Setups scoring 40 to 54' : 'Setups scoring under 40'
    )
  );

  if (live.length > 0 && missed.length / live.length >= 0.4) {
    lessons.push({
      tone: 'info',
      title: `${missed.length} of ${live.length} orders never filled`,
      detail:
        'A miss costs nothing: the order simply was not reached. Tested on two years, chasing those moves or moving entries closer earned less, so the engine keeps waiting for its level.',
    });
  }

  return lessons;
}

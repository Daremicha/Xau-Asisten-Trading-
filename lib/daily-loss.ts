/**
 * The daily loss limit: once the day's closed trades have lost a set share of
 * the balance the day started with, no new setup is offered until the next
 * trading day.
 *
 * The trading day starts at 17:00 New York time, the daily open of gold
 * (04:00 WIB in the US summer, 05:00 WIB in winter), so a day holds one whole
 * session cycle rather than being cut in the middle of Asia.
 *
 * Tested on 24 months of M15, Intraday, take-all, break-even at 1R, on a
 * 378 Cent account where the minimum lot makes one stop out cost about 2.7%:
 * with no limit the worst day lost 8.4% and 15 days lost 5% or more. A 3%
 * limit cut the worst day to 5.9% and those days to 10, with profit factor
 * 1.27 to 1.31 and the worst losing streak 12 to 10; the deepest drawdown
 * went 25.8% to 26.9%, because a slide spread over several days is not
 * stopped by a daily rule. 2% stopped more good days than bad (net lower,
 * drawdown 30%), and 5% and 4% triggered at the wrong moments and did worse
 * than no limit. It is a brake on bad days, not a source of profit.
 */

import { newYorkTime } from './market-hours';
import type { SelfLearningMemoryRecord } from './types';

const DAY_MS = 86_400_000;

/** The limits the app offers, as a share of the day's starting balance. Zero is off. */
export const DAILY_LOSS_LIMIT_CHOICES = [0, 2, 3, 5] as const;
/** The limit that held up in the replay above, used until the user picks one. */
export const DEFAULT_DAILY_LOSS_LIMIT = 3;

/** When the trading day containing `at` began. */
export function tradingDayStart(at: number): number {
  // New York is four or five hours behind UTC. Taking five can put the date an
  // hour late around midnight, which is far from the 17:00 open and so never
  // changes which open came last.
  const nyDate = new Date(at - 5 * 3_600_000).toISOString().slice(0, 10);
  const open = newYorkTime(nyDate, 17, 0);
  if (open <= at) return open;
  return newYorkTime(new Date(Date.parse(nyDate) - DAY_MS).toISOString().slice(0, 10), 17, 0);
}

/** True for the 17:00 opens on Friday and Saturday in New York, which start no session. */
function opensWeekend(open: number): boolean {
  const day = new Date(open - 5 * 3_600_000).getUTCDay();
  return day === 5 || day === 6;
}

/** When the trading day containing `at` ends, which is when the next one starts. */
export function nextTradingDayStart(at: number): number {
  // A day is 23 to 25 hours across a daylight saving change; 30 is past any of
  // them. Friday's close opens nothing, so the weekend is stepped over.
  let next = tradingDayStart(tradingDayStart(at) + 30 * 3_600_000);
  while (opensWeekend(next)) next = tradingDayStart(next + 30 * 3_600_000);
  return next;
}

/** Closed trades from the learning log, in the shape the limit reads. Misses cost nothing. */
export function closedResults(records: SelfLearningMemoryRecord[]): Array<{ closedAt: number; net: number }> {
  return records
    .filter((r) => r.outcome !== 'MISSED' && Number.isFinite(r.profitOrLossDollars))
    .map((r) => ({ closedAt: Date.parse(r.timestamp), net: r.profitOrLossDollars }))
    .filter((r) => Number.isFinite(r.closedAt));
}

/** Net result of the trades closed so far in the trading day containing `at`. */
export function netToday(closed: Array<{ closedAt: number; net: number }>, at: number): number {
  const start = tradingDayStart(at);
  return closed.reduce((sum, t) => (t.closedAt >= start && t.closedAt <= at ? sum + t.net : sum), 0);
}

/**
 * True when today's losses have reached the limit.
 *
 * `equityNow` already includes today's result, so the day's starting balance
 * is recovered from it. A null or zero limit means the rule is off.
 */
export function dailyLossLimitReached(net: number, equityNow: number, limitPercent: number | null): boolean {
  if (!limitPercent || limitPercent <= 0 || net >= 0) return false;
  const dayStartEquity = equityNow - net;
  if (dayStartEquity <= 0) return true;
  return -net >= (dayStartEquity * limitPercent) / 100 - 1e-9;
}

/** What the screen says when the limit stops a setup. */
export function dailyLossNote(net: number, equityNow: number, limitPercent: number, resumesAt: number): string {
  const lostPercent = (-net / (equityNow - net)) * 100;
  const resumes = new Date(resumesAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Jakarta',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `Today's closed trades have lost ${lostPercent.toFixed(1)}% of the balance the day started with, which reaches your daily limit of ${limitPercent}%. No new setup until the next trading day starts, ${resumes} WIB.`;
}

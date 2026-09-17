/**
 * When it is worth looking again.
 *
 * Being told "nothing right now" is only half an answer. The other half is
 * when the chart will have changed enough for the answer to be different, and
 * that is not a guess: a setup is read from closed candles and from the
 * sessions that move price, so the next honest moment to look is the next
 * candle close of the timeframe the style trades, or the next session opening,
 * whichever comes first.
 *
 * Nothing here predicts a setup. It says when new information exists.
 */

import { TradingStyle } from './types';

/** Minutes per candle of the timeframe each style actually decides on. */
const DECISION_MINUTES: Record<TradingStyle, number> = {
  Scalping: 15,
  Intraday: 60,
  Swing: 240,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Session openings, in UTC hours, with the name the rest of the app uses. */
const SESSION_OPENINGS: Array<{ hour: number; name: string }> = [
  { hour: 0, name: 'Asian session' },
  { hour: 7, name: 'London open' },
  { hour: 12, name: 'New York open' },
  { hour: 15, name: 'London close' },
];

export interface NextCheck {
  /** ISO time worth looking again. */
  at: string;
  /** Plain sentence saying what changes at that moment. */
  reason: string;
  /** True when the market itself is shut, so `at` is the reopening. */
  marketClosed: boolean;
  /** The next session opening, when one is coming. */
  session: { name: string; at: string } | null;
}

/**
 * True during the weekend recess, matching the session reader exactly: from
 * Friday 21:00 UTC until Sunday 22:00 UTC there is no market to read.
 */
export function isMarketClosed(now: Date): boolean {
  const day = now.getUTCDay();
  const hours = now.getUTCHours() + now.getUTCMinutes() / 60;
  return (day === 5 && hours >= 21) || day === 6 || (day === 0 && hours < 22);
}

/** The moment the market reopens, from any point inside the recess. */
export function nextMarketOpen(now: Date): Date {
  const open = new Date(now.getTime());
  open.setUTCHours(22, 0, 0, 0);
  // Walk forward to the next Sunday 22:00 UTC that is still ahead of us.
  while (open.getTime() <= now.getTime() || open.getUTCDay() !== 0) {
    open.setUTCDate(open.getUTCDate() + 1);
    open.setUTCHours(22, 0, 0, 0);
  }
  return open;
}

/** The close of the candle currently forming on the style's timeframe. */
export function nextCandleClose(style: TradingStyle, now: Date): Date {
  const stepMs = DECISION_MINUTES[style] * MINUTE_MS;
  // Candles are aligned to the UTC day, which is where every provider in this
  // app starts them, so the boundary is measured from midnight rather than
  // from the epoch.
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMidnight = now.getTime() - midnight;
  const closed = Math.floor(sinceMidnight / stepMs) + 1;
  return new Date(midnight + closed * stepMs);
}

/** The next session opening after this moment. */
export function nextSessionOpen(now: Date): { name: string; at: Date } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const opening of SESSION_OPENINGS) {
    const at = new Date(midnight + opening.hour * HOUR_MS);
    if (at.getTime() > now.getTime()) return { name: opening.name, at };
  }
  // Past the last opening of the day, so the first of tomorrow.
  const first = SESSION_OPENINGS[0];
  return { name: first.name, at: new Date(midnight + DAY_MS + first.hour * HOUR_MS) };
}

/**
 * When to look again, and why.
 *
 * The candle close is the earlier of the two on any normal day, and it is the
 * honest one: until a candle closes, the structure the engine reads has not
 * changed. The session opening is reported alongside because that is when the
 * market usually does something worth reading.
 */
export function nextCheck(style: TradingStyle, now: Date = new Date()): NextCheck {
  if (isMarketClosed(now)) {
    const open = nextMarketOpen(now);
    return {
      at: open.toISOString(),
      reason: 'The market is closed for the weekend. Nothing on the chart changes until it reopens.',
      marketClosed: true,
      session: { name: 'Asian session', at: open.toISOString() },
    };
  }

  const candle = nextCandleClose(style, now);
  const session = nextSessionOpen(now);
  const minutes = Math.max(1, Math.round((candle.getTime() - now.getTime()) / MINUTE_MS));
  const timeframe = style === 'Scalping' ? 'M15' : style === 'Intraday' ? 'H1' : 'H4';

  return {
    at: candle.toISOString(),
    reason: `The current ${timeframe} candle closes in about ${minutes} ${
      minutes === 1 ? 'minute' : 'minutes'
    }. Until it does, the structure this read is built on has not changed.`,
    marketClosed: false,
    session: { name: session.name, at: session.at.toISOString() },
  };
}

/**
 * Whether a single live price is trustworthy enough to end a trade on.
 *
 * Closing a trade is not a display decision. It writes money into the ledger
 * and a lesson into the engine, and neither is easy to take back. The screen
 * had one guard on it — never close on a futures quote — and that guard was
 * about which instrument the number described. It said nothing about whether
 * the number was current, or plausible, or whether the order had existed long
 * enough to have reached anything.
 *
 * So a market order could be opened and closed in the same breath: issued at
 * one price, then matched against a quote from a different moment that sat
 * beyond its stop. The trade never happened. The loss was recorded anyway, the
 * balance moved, and the engine was taught that the setup failed.
 *
 * These rules apply only to the live tick. The candle replay is a separate
 * witness with its own timestamps, and it is not second-guessed here: it knows
 * when each thing happened, which is the very thing a bare price cannot say.
 */

import type { Candle } from './candles';

/**
 * How the screen describes the feed.
 *
 * Deliberately wider than the states this module names: any status that is not
 * exactly `live` — loading, stale, unavailable, or one added later — refuses.
 * A new state should have to argue its way into closing trades, not inherit the
 * right by being unrecognised.
 */
export type FeedStatus = 'live' | (string & {});

/**
 * How old a quote may be and still end a trade.
 *
 * The feed already marks a quote stale once it is too old to trade on, and that
 * mark alone would catch most of this. Two minutes is the second line: a price
 * older than that has had time to be overtaken by a move it cannot describe.
 */
const MAX_QUOTE_AGE_SECONDS = 120;

/**
 * How long an order must have existed before a price may close it.
 *
 * An intraday stop sits up to a hundred and eighty pips away. Price does not
 * travel that in the seconds after an order is placed, so a close that arrives
 * that fast is not a fast market — it is a quote from another moment being read
 * as though it were now.
 *
 * Where a move genuinely is that violent, nothing is lost but one poll: the
 * close lands on the next quote, or the candles pick it up with a timestamp
 * attached. A delayed true close costs nothing. A false one costs the ledger.
 */
const MIN_ORDER_AGE_SECONDS = 45;

/** Candles used to judge whether a price is plausible: two hours of them. */
const PLAUSIBILITY_BARS = 8;

/**
 * How far outside the recent range a quote may sit before it is disbelieved.
 *
 * Measured in multiples of the range those bars actually covered, so it adapts
 * to the day instead of hard coding a number of dollars. Two full ranges beyond
 * what the last two hours managed is a violent but real market; a quote further
 * out than that is reporting a different moment, and acting on it writes a
 * trade that did not happen.
 */
const PLAUSIBLE_RANGE_MULTIPLE = 2;

export interface TickTrustInputs {
  /** What the feed said about this quote. */
  feedStatus: FeedStatus;
  /** Age of the quote in seconds, or null when it cannot be established. */
  quoteAgeSeconds: number | null;
  /** When the order was issued, as the setup records it. */
  issuedAt: string | undefined;
  /** The price about to end the trade. */
  price: number;
  /** Recent execution candles, newest last. */
  candles: Candle[];
  now?: number;
}

export type TickTrust = { ok: true } | { ok: false; reason: string };

/**
 * Decides whether this tick may resolve a trade.
 *
 * Refusing is always safe: the next quote, or the candles, will resolve it with
 * better evidence a moment later. So every uncertain case refuses.
 */
export function tickMayResolve(inputs: TickTrustInputs): TickTrust {
  const now = inputs.now ?? Date.now();

  if (inputs.feedStatus !== 'live') {
    return {
      ok: false,
      reason: 'Harga tidak live, dan harga yang terlalu lama untuk trading juga terlalu lama untuk menutup trade.',
    };
  }

  if (inputs.quoteAgeSeconds !== null && inputs.quoteAgeSeconds > MAX_QUOTE_AGE_SECONDS) {
    return {
      ok: false,
      reason: `Harga ini berumur ${Math.round(inputs.quoteAgeSeconds)} detik, melewati batas ${MAX_QUOTE_AGE_SECONDS} detik untuk menutup trade.`,
    };
  }

  const issued = Date.parse(inputs.issuedAt ?? '');
  if (!Number.isFinite(issued)) {
    return { ok: false, reason: 'Order tidak punya waktu yang terbaca, jadi tidak ada yang bisa dicocokkan waktunya.' };
  }
  const ageSeconds = (now - issued) / 1000;
  if (ageSeconds < MIN_ORDER_AGE_SECONDS) {
    return {
      ok: false,
      reason: `Order ini baru berumur ${Math.max(0, Math.round(ageSeconds))} detik. Harga tidak mencapai stop secepat itu, jadi ini harga dari waktu lain, bukan penutupan.`,
    };
  }

  const recent = inputs.candles.slice(-PLAUSIBILITY_BARS);
  if (recent.length >= 2) {
    const high = Math.max(...recent.map((c) => c.high));
    const low = Math.min(...recent.map((c) => c.low));
    const span = high - low;
    if (span > 0) {
      const allowance = span * PLAUSIBLE_RANGE_MULTIPLE;
      if (inputs.price > high + allowance || inputs.price < low - allowance) {
        return {
          ok: false,
          reason: `Harga ${inputs.price.toFixed(2)} berada di luar ${low.toFixed(2)}–${high.toFixed(
            2
          )} yang benar-benar terjadi dalam dua jam terakhir, lebih dari dua kali range itu. Ini menggambarkan waktu lain, bukan sekarang.`,
        };
      }
    }
  }

  return { ok: true };
}

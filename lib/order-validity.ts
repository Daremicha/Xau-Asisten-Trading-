/**
 * How long a pending order stays worth leaving on the book, and what kills it
 * early.
 *
 * Until now nothing expired. A limit order sat marked ACTIVE for as long as the
 * user left it there, and only a manual click recorded a miss. A setup read
 * from an H1 imbalance is not still valid two days later, and the learning
 * engine was being fed miss timings that meant nothing.
 */

import { InstitutionalTradingSetup, TradingStyle } from './types';

export interface ValidityWindow {
  /** ISO timestamp after which the idea is stale. */
  validUntil: string;
  validForMinutes: number;
  /** Plain sentence explaining the window. */
  basis: string;
}

export type PendingVerdict =
  | { state: 'waiting'; minutesLeft: number; reason: string }
  | { state: 'expired'; reason: string }
  | { state: 'invalidated'; reason: string }
  | { state: 'ran-away'; reason: string };

/**
 * Validity windows, chosen to match how long the structure a setup reads from
 * stays meaningful. A scalp reads the last few M15 candles, so it decays in
 * hours; a swing reads the daily chart and survives days.
 */
const WINDOW_MINUTES: Record<TradingStyle, number> = {
  Scalping: 90,
  Intraday: 8 * 60,
  Swing: 3 * 24 * 60,
};

/**
 * How far past its entry, in multiples of its own risk, price may run before an
 * unfilled order is called missed.
 *
 * One stop distance for the engine's own targets. With the quick target on it
 * is one and a half: a 0.5R target needs only a small pullback to pay, and
 * cancelling at one stop distance threw away orders that filled later and won.
 * Replayed over 24 months of M15 with quick TP, 1.5 beat 1 in both halves at
 * floors 40 (64 to 71R), 55 (36 to 62R) and 70 (23 to 32R); at take-all it
 * made 82R against 74R. With the engine's own targets the wider rule did worse,
 * so it applies only to the quick target.
 */
export const MISS_AT_R = 1;
export const QUICK_TARGET_MISS_AT_R = 1.5;

/** The miss distance for an order, by whether it carries the quick target. */
export function missAtR(quickTarget: boolean): number {
  return quickTarget ? QUICK_TARGET_MISS_AT_R : MISS_AT_R;
}

/** A kill zone shortens a scalp's window: the burst of liquidity is the setup. */
const KILL_ZONE_SCALP_MINUTES = 60;

export function computeValidity(
  tradingStyle: TradingStyle,
  killZoneActive: boolean,
  now: Date = new Date()
): ValidityWindow {
  const base = WINDOW_MINUTES[tradingStyle];
  const minutes =
    tradingStyle === 'Scalping' && killZoneActive ? Math.min(base, KILL_ZONE_SCALP_MINUTES) : base;

  const basis =
    tradingStyle === 'Scalping'
      ? killZoneActive
        ? 'Scalp membaca kill zone saat ini, jadi order batal setelah jendela itu tutup.'
        : 'Scalp membaca beberapa candle M15 terakhir, yang berhenti relevan dalam sekitar sembilan puluh menit.'
      : tradingStyle === 'Intraday'
      ? 'Setup intraday membaca sesi saat ini, jadi order batal di akhir hari trading.'
      : 'Setup swing membaca grafik harian, yang tetap relevan sekitar tiga hari trading.';

  return {
    validUntil: new Date(now.getTime() + minutes * 60_000).toISOString(),
    validForMinutes: minutes,
    basis,
  };
}

/**
 * Whether a resting order would be dead the moment it was placed.
 *
 * `evaluatePendingOrder` kills a resting order once price has run a full stop
 * distance past its entry. An order issued when price is already that far away
 * satisfies the rule immediately: the app records it as a missed entry within
 * seconds of offering it, and the user is handed a trade that never existed.
 *
 * This is the same rule read one moment earlier, so the two can never disagree.
 * A market order is exempt: it fills at price, so there is nothing to run away
 * from.
 */
export function isDeadOnArrival(
  order: { orderType: string; entryPrice: number; stopLoss: number },
  currentPrice: number
): boolean {
  if (order.orderType.includes('INSTANT')) return false;
  const risk = Math.abs(order.entryPrice - order.stopLoss);
  if (risk <= 0) return false;
  const isBuy = order.orderType.includes('BUY');
  const runFromEntry = isBuy ? currentPrice - order.entryPrice : order.entryPrice - currentPrice;
  return runFromEntry >= risk;
}

/**
 * Decides what has become of a pending order.
 *
 * Three things end it besides a fill: the clock runs out, price trades through
 * the invalidation without ever filling, or price reaches the first target
 * without filling, which means the move happened without you.
 */
export function evaluatePendingOrder(
  setup: Pick<
    InstitutionalTradingSetup,
    'orderType' | 'entryPrice' | 'stopLoss' | 'takeProfit1' | 'timestamp'
  > & { validUntil?: string; missAtR?: number },
  currentPrice: number,
  now: Date = new Date()
): PendingVerdict {
  const isBuy = setup.orderType.includes('BUY');

  // Price has gone past the point that would have invalidated the trade, and it
  // never filled. There is nothing left to wait for.
  const throughStop = isBuy ? currentPrice <= setup.stopLoss : currentPrice >= setup.stopLoss;
  if (throughStop) {
    return {
      state: 'invalidated',
      reason: `Harga mencapai ${currentPrice.toFixed(2)}, menembus titik invalidasi ${setup.stopLoss.toFixed(
        2
      )}, tanpa order pernah terisi. Idenya batal.`,
    };
  }

  // The move ran without you. Chasing it now is a different, worse trade.
  //
  // Measured against the risk the order carried rather than against the first
  // target. Targets sit on structure now, so one can be close, and a rule keyed
  // to it declared an order dead the moment price twitched in its favour. A
  // move of a full stop distance beyond the entry is the same statement at any
  // target distance: you would have been a stop's worth in profit, and you were
  // never in the trade.
  const risk = Math.abs(setup.entryPrice - setup.stopLoss);
  const runFromEntry = isBuy ? currentPrice - setup.entryPrice : setup.entryPrice - currentPrice;
  const multiple = setup.missAtR ?? MISS_AT_R;
  if (risk > 0 && runFromEntry >= risk * multiple) {
    return {
      state: 'ran-away',
      reason: `Harga lari ${runFromEntry.toFixed(2)} melewati entry ${setup.entryPrice.toFixed(2)}, ${
        multiple === 1 ? 'sejauh satu jarak stop' : `${multiple} kali jarak stop`
      }, tanpa pernah mengisinya. Pergerakannya terjadi tanpa entry.`,
    };
  }

  if (setup.validUntil) {
    const deadline = new Date(setup.validUntil).getTime();
    if (Number.isFinite(deadline)) {
      const minutesLeft = (deadline - now.getTime()) / 60_000;
      if (minutesLeft <= 0) {
        return {
          state: 'expired',
          reason: `Masa berlaku order habis tanpa terisi. Struktur yang jadi dasarnya sudah tidak menggambarkan pasar.`,
        };
      }
      return {
        state: 'waiting',
        minutesLeft: Math.round(minutesLeft),
        reason: `Menunggu harga mencapai ${setup.entryPrice.toFixed(2)}.`,
      };
    }
  }

  return { state: 'waiting', minutesLeft: Infinity, reason: 'Menunggu harga mencapai entry.' };
}

/**
 * Why a pending order ended without filling, in the form the learning engine
 * stores. The three causes teach different lessons: a runaway means the entry
 * sat too deep, an invalidation means the read was wrong, and an expiry means
 * the level simply never came back inside the window.
 */
export function missCause(state: PendingVerdict['state']): string {
  switch (state) {
    case 'ran-away':
      return 'Harga mencapai target tanpa mengisi order, jadi entry-nya terlalu dalam dibanding koreksi pasar.';
    case 'invalidated':
      return 'Harga menembus titik invalidasi sebelum order terisi, jadi bacaan arahnya salah.';
    case 'expired':
      return 'Masa berlaku order habis tanpa harga pernah mencapai entry.';
    default:
      return 'Order tidak terisi.';
  }
}

/** Human readable time remaining, for the countdown on the signal card. */
export function formatTimeLeft(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'kedaluwarsa';
  if (minutes < 60) return `${Math.round(minutes)} mnt lagi`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours < 24) return rest > 0 ? `${hours} jam ${rest} mnt lagi` : `${hours} jam lagi`;
  const days = Math.floor(hours / 24);
  return `${days} hari ${hours % 24} jam lagi`;
}

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
        ? 'A scalp reads the current kill zone, so the order is void once that window closes.'
        : 'A scalp reads the last few M15 candles, which stop describing the market within about ninety minutes.'
      : tradingStyle === 'Intraday'
      ? 'An intraday setup reads the current session, so the order is void by the end of the trading day.'
      : 'A swing setup reads the daily chart, which stays meaningful for about three trading days.';

  return {
    validUntil: new Date(now.getTime() + minutes * 60_000).toISOString(),
    validForMinutes: minutes,
    basis,
  };
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
  > & { validUntil?: string },
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
      reason: `Price reached ${currentPrice.toFixed(2)}, through the ${setup.stopLoss.toFixed(
        2
      )} invalidation, without the order ever filling. The idea is void.`,
    };
  }

  // The move ran without you. Chasing it now is a different, worse trade.
  const reachedTarget = isBuy ? currentPrice >= setup.takeProfit1 : currentPrice <= setup.takeProfit1;
  if (reachedTarget) {
    return {
      state: 'ran-away',
      reason: `Price reached the first target at ${setup.takeProfit1.toFixed(
        2
      )} without filling the order. The move happened without the entry.`,
    };
  }

  if (setup.validUntil) {
    const deadline = new Date(setup.validUntil).getTime();
    if (Number.isFinite(deadline)) {
      const minutesLeft = (deadline - now.getTime()) / 60_000;
      if (minutesLeft <= 0) {
        return {
          state: 'expired',
          reason: `The order passed its validity window without filling. The structure it was based on no longer describes the market.`,
        };
      }
      return {
        state: 'waiting',
        minutesLeft: Math.round(minutesLeft),
        reason: `Waiting for price to reach ${setup.entryPrice.toFixed(2)}.`,
      };
    }
  }

  return { state: 'waiting', minutesLeft: Infinity, reason: 'Waiting for price to reach the entry.' };
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
      return 'Price reached the target without filling, so the entry sat deeper than the market retraced.';
    case 'invalidated':
      return 'Price broke the invalidation before filling, so the directional read was wrong.';
    case 'expired':
      return 'The validity window closed with price never reaching the entry.';
    default:
      return 'The order did not fill.';
  }
}

/** Human readable time remaining, for the countdown on the signal card. */
export function formatTimeLeft(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'expired';
  if (minutes < 60) return `${Math.round(minutes)}m left`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours < 24) return rest > 0 ? `${hours}h ${rest}m left` : `${hours}h left`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h left`;
}

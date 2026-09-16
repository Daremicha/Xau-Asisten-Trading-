/**
 * What a trade is worth when it closes.
 *
 * The signal card projects the result on its outcome buttons and the learning
 * route records the result that actually happened. Those two used to compute it
 * separately, and the button quoted the risk budget while the ledger recorded
 * the real move, so a stop-out could read -$0.08 on the button and -$0.18 in
 * the balance. Both now call this.
 *
 * Everything here is in USD, which is what the contract is quoted in. Turning
 * it into the account's own unit is a display concern; see account-display.
 */

import { InstitutionalTradingSetup } from './types';

export type TradeOutcome = 'TP' | 'SL' | 'MISSED';

export interface TradeResult {
  /** Signed price distance in pips. Zero for an order that never filled. */
  pips: number;
  /** Signed money result in USD, commission included where the account charges it. */
  dollars: number;
}

export type ResultSetup = Pick<
  InstitutionalTradingSetup,
  'entryPrice' | 'recommendedLotSize' | 'accountType' | 'contractSpecs'
>;

/** Ounces of gold one lot controls on this account. */
export function contractMultiplier(setup: ResultSetup): number {
  if (setup.accountType === 'Cent') return 1;
  if (setup.contractSpecs?.contractSizeOz === 1) return 1;
  return 100;
}

export function computeTradeResult(
  setup: ResultSetup,
  closedPrice: number,
  outcome: TradeOutcome
): TradeResult {
  const isProfit = outcome === 'TP';
  // A missed order was never filled, so it moved neither pips nor money.
  const isMissed = outcome === 'MISSED';
  const priceDiff = Math.abs(closedPrice - setup.entryPrice);
  const direction = isProfit ? 1 : -1;

  const pips = isMissed ? 0 : parseFloat((priceDiff * 10).toFixed(1)) * direction;

  let gross = isMissed ? 0 : setup.recommendedLotSize * contractMultiplier(setup) * priceDiff * direction;
  if (setup.accountType === 'Pro' && !isMissed) {
    gross -= (setup.contractSpecs?.commissionPerLot || 6.0) * setup.recommendedLotSize;
  }

  return { pips, dollars: parseFloat(gross.toFixed(2)) };
}

/**
 * Result of a position closed at an arbitrary price.
 *
 * `computeTradeResult` answers "what does a take profit pay", which is what the
 * signal card and the learning route ask. A backtest also closes trades that
 * ran out of time, where the sign comes from where price actually ended up
 * rather than from the label on the exit.
 */
export function resultFromMove(
  setup: ResultSetup,
  exitPrice: number,
  direction: 'long' | 'short'
): TradeResult {
  const move = direction === 'long' ? exitPrice - setup.entryPrice : setup.entryPrice - exitPrice;
  const pips = parseFloat((move * 10).toFixed(1));

  let gross = move * contractMultiplier(setup) * setup.recommendedLotSize;
  if (setup.accountType === 'Pro') {
    gross -= (setup.contractSpecs?.commissionPerLot || 6.0) * setup.recommendedLotSize;
  }

  return { pips, dollars: parseFloat(gross.toFixed(2)) };
}

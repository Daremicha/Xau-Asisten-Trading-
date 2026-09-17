/**
 * Live state of an order: has it filled, what is it floating, and has it hit a
 * target or the stop.
 *
 * The app knew what it had proposed but never watched what happened to it. A
 * pending order showed the same card whether price was still fifty pips away or
 * had filled an hour ago and was running into profit.
 */

import { InstitutionalTradingSetup, OrderExecutionType } from './types';
import { roundMoney } from './trade-result';

export type FillState = 'pending' | 'filled' | 'closed';

export type CloseTrigger = 'TP1' | 'TP2' | 'TP3' | 'SL';

export interface LivePosition {
  state: FillState;
  /** True for a long, false for a short. */
  isLong: boolean;
  /** Pips price still has to travel to fill the order, null once filled. */
  distanceToEntryPips: number | null;
  /** Unrealised result while the position runs, null while still pending. */
  floatingDollars: number | null;
  floatingPips: number | null;
  /** Nought to one, how far price has run from entry toward the first target. */
  progressToTarget: number | null;
  /** Set once price has reached a target or the stop. */
  closedBy: CloseTrigger | null;
  /** Short sentence for the panel. */
  summary: string;
}

/** Contract size in troy ounces for the account the setup was built for. */
export function contractOunces(setup: Pick<InstitutionalTradingSetup, 'accountType' | 'contractSpecs'>): number {
  if (setup.contractSpecs?.contractSizeOz) return setup.contractSpecs.contractSizeOz;
  return setup.accountType === 'Cent' ? 1 : 100;
}

/**
 * Whether price has reached the order's entry.
 *
 * A limit order fills when price comes back to it; a stop order fills when
 * price pushes through it. An instant order is filled the moment it is placed.
 */
export function hasReachedEntry(
  orderType: OrderExecutionType,
  entryPrice: number,
  currentPrice: number
): boolean {
  if (orderType.includes('INSTANT')) return true;
  const isBuy = orderType.includes('BUY');
  const isStop = orderType.includes('STOP');

  if (isBuy) return isStop ? currentPrice >= entryPrice : currentPrice <= entryPrice;
  return isStop ? currentPrice <= entryPrice : currentPrice >= entryPrice;
}

/** Which target or stop price has reached, checked furthest first. */
export function detectClose(
  setup: Pick<InstitutionalTradingSetup, 'orderType' | 'stopLoss' | 'takeProfit1' | 'takeProfit2' | 'takeProfit3'>,
  currentPrice: number
): CloseTrigger | null {
  const isLong = setup.orderType.includes('BUY');

  // The stop is checked first: a bar that touched both is treated as the loss,
  // which is the conservative reading and the one a broker usually gives you.
  if (isLong ? currentPrice <= setup.stopLoss : currentPrice >= setup.stopLoss) return 'SL';

  if (isLong) {
    if (currentPrice >= setup.takeProfit3) return 'TP3';
    if (currentPrice >= setup.takeProfit2) return 'TP2';
    if (currentPrice >= setup.takeProfit1) return 'TP1';
  } else {
    if (currentPrice <= setup.takeProfit3) return 'TP3';
    if (currentPrice <= setup.takeProfit2) return 'TP2';
    if (currentPrice <= setup.takeProfit1) return 'TP1';
  }
  return null;
}

/** Unrealised result of a filled position at the current price. */
export function floatingResult(
  setup: Pick<
    InstitutionalTradingSetup,
    'orderType' | 'entryPrice' | 'recommendedLotSize' | 'accountType' | 'contractSpecs'
  >,
  currentPrice: number
): { dollars: number; pips: number } {
  const isLong = setup.orderType.includes('BUY');
  const move = (currentPrice - setup.entryPrice) * (isLong ? 1 : -1);
  const dollars = move * setup.recommendedLotSize * contractOunces(setup);
  return {
    // Four decimals of a dollar, because two is a whole unit on a cent account:
    // a float of 0.45 cent was being shown as 0.00 while the position moved.
    dollars: roundMoney(dollars),
    pips: parseFloat((move * 10).toFixed(1)),
  };
}

/**
 * Full live state.
 *
 * `alreadyFilled` latches: once an order has filled, a later price that drifts
 * back past the entry must not un-fill it.
 */
export function trackPosition(
  setup: InstitutionalTradingSetup,
  currentPrice: number,
  alreadyFilled: boolean
): LivePosition {
  const isLong = setup.orderType.includes('BUY');
  const filled = alreadyFilled || hasReachedEntry(setup.orderType, setup.entryPrice, currentPrice);

  if (!filled) {
    const distance = Math.abs(currentPrice - setup.entryPrice) * 10;
    return {
      state: 'pending',
      isLong,
      distanceToEntryPips: parseFloat(distance.toFixed(1)),
      floatingDollars: null,
      floatingPips: null,
      progressToTarget: null,
      closedBy: null,
      summary: `Waiting for price to reach ${setup.entryPrice.toFixed(2)}, ${distance.toFixed(0)} pips away.`,
    };
  }

  const floating = floatingResult(setup, currentPrice);
  const closedBy = detectClose(setup, currentPrice);

  const targetSpan = Math.abs(setup.takeProfit1 - setup.entryPrice);
  const travelled = (currentPrice - setup.entryPrice) * (isLong ? 1 : -1);
  const progressToTarget =
    targetSpan > 0 ? Math.max(-1, Math.min(1, travelled / targetSpan)) : 0;

  return {
    state: closedBy ? 'closed' : 'filled',
    isLong,
    distanceToEntryPips: null,
    floatingDollars: floating.dollars,
    floatingPips: floating.pips,
    progressToTarget,
    closedBy,
    summary: closedBy
      ? `Position closed at ${closedBy}.`
      : floating.dollars >= 0
      ? `Filled and floating ${floating.pips} pips in profit.`
      : `Filled and floating ${Math.abs(floating.pips)} pips in drawdown.`,
  };
}

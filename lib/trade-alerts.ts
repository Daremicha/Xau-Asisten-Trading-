/**
 * The words on every trade notification, whether the server sends it to a
 * closed app or the open app raises it itself.
 *
 * Each one leads with what happened, in capitals, so the notification shade
 * answers the only question that matters at a glance: did the pending order
 * trigger, and did the trade end at the target or at the stop. Both senders
 * use the same tag for the same event, so a phone that hears about it twice
 * shows it once.
 */

import { reviewLabel } from './ai-review-label';
import type { AiReview } from './types';

export interface AlertSetup {
  id: string;
  orderType: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
}

export interface TradeAlert {
  title: string;
  body: string;
  tag: string;
}

const price = (value: number) => value.toFixed(2);
const pips = (dollars: number) => `${Math.round(Math.abs(dollars) * 10)} pips`;
const side = (setup: AlertSetup) => (setup.orderType.startsWith('BUY') ? 'BUY' : 'SELL');

/** The pending order triggered and the position is open. */
export function filledAlert(setup: AlertSetup, fillPrice: number): TradeAlert {
  return {
    title: `✅ ORDER FILLED: ${setup.orderType} @ ${price(fillPrice)}`,
    body: `Your pending order triggered and the ${side(setup)} position is now open. SL ${price(setup.stopLoss)} · TP1 ${price(setup.takeProfit1)}.`,
    tag: `${setup.id}_filled`,
  };
}

/** Price reached the break-even trigger: the stop should now go to the entry. */
export function protectAlert(setup: AlertSetup, atR: number, fillPrice: number = setup.entryPrice): TradeAlert {
  return {
    title: `🔒 MOVE SL TO ENTRY: ${side(setup)} is ${atR}R in profit`,
    body: `Move the stop of your ${setup.orderType} to ${price(fillPrice)} in MT5 now, so the trade can no longer turn into a full loss.`,
    tag: `${setup.id}_protect`,
  };
}

/** The trade ended, at a target, at the stop, or at the entry after the break-even move. */
export function closedAlert(
  setup: AlertSetup,
  trigger: 'SL' | 'TP1' | 'TP2' | 'TP3',
  exitPrice: number,
  fillPrice: number = setup.entryPrice,
  breakEven = false
): TradeAlert {
  if (breakEven) {
    return {
      title: `⚖️ BREAK-EVEN: ${side(setup)} closed at entry`,
      body: `${setup.orderType} from ${price(fillPrice)} came back to its entry after the stop was moved there. No loss; only the spread is paid. The result is recorded when you open the app.`,
      tag: `${setup.id}_closed`,
    };
  }
  const won = trigger !== 'SL';
  const moved = pips(exitPrice - fillPrice);
  return {
    title: won
      ? `🎯 TAKE PROFIT ${trigger.slice(2)} HIT: ${side(setup)} closed in profit`
      : `🛑 STOP LOSS HIT: ${side(setup)} closed at a loss`,
    body: won
      ? `${setup.orderType} from ${price(fillPrice)} reached TP${trigger.slice(2)} at ${price(exitPrice)} (+${moved}). The result is recorded when you open the app.`
      : `${setup.orderType} from ${price(fillPrice)} was stopped out at ${price(exitPrice)} (-${moved}). The result is recorded when you open the app.`,
    tag: `${setup.id}_closed`,
  };
}

/** The pending order will not fill any more and should be deleted. */
export function missedAlert(setup: AlertSetup, reason: string): TradeAlert {
  return {
    title: `⚠️ ORDER NOT FILLED: delete ${setup.orderType} @ ${price(setup.entryPrice)}`,
    body: `${reason} Delete this pending order in MT5 and do not chase it at market.`,
    tag: `${setup.id}_missed`,
  };
}

/** Price is within reach of the stop or the first target of an open position. */
export function nearLevelAlert(setup: AlertSetup, level: 'SL' | 'TP1', marketPrice: number): TradeAlert {
  const target = level === 'SL' ? setup.stopLoss : setup.takeProfit1;
  const distance = pips(target - marketPrice);
  return level === 'SL'
    ? {
        title: `⚠️ NEAR STOP LOSS: ${side(setup)} ${distance} from SL ${price(target)}`,
        body: `XAUUSD is at ${price(marketPrice)}. Your ${setup.orderType} from ${price(setup.entryPrice)} is close to its stop.`,
        tag: `${setup.id}_SL`,
      }
    : {
        title: `📈 NEAR TAKE PROFIT 1: ${side(setup)} ${distance} from TP1 ${price(target)}`,
        body: `XAUUSD is at ${price(marketPrice)}. Your ${setup.orderType} from ${price(setup.entryPrice)} is close to its first target.`,
        tag: `${setup.id}_TP1`,
      };
}

/** A setup the server's scan found while the app was closed. */
export function newSetupAlert(
  setup: AlertSetup & { recommendedLotSize?: number; aiReview?: AiReview | null },
  scanId: string
): TradeAlert {
  const lot = typeof setup.recommendedLotSize === 'number' ? ` · lot ${setup.recommendedLotSize.toFixed(2)}` : '';
  const ai = reviewLabel(setup.aiReview);
  return {
    title: `📊 NEW SETUP: ${setup.orderType} @ ${price(setup.entryPrice)}`,
    body: `SL ${price(setup.stopLoss)} · TP1 ${price(setup.takeProfit1)}${lot}.${ai ? ` ${ai}.` : ''} Open the app to load it, then place the order in MT5.`,
    tag: `${scanId}_new`,
  };
}

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
    title: `✅ ORDER TERISI: ${setup.orderType} @ ${price(fillPrice)}`,
    body: `Order pending kamu terpicu dan posisi ${side(setup)} sekarang terbuka. SL ${price(setup.stopLoss)} · TP1 ${price(setup.takeProfit1)}.`,
    tag: `${setup.id}_filled`,
  };
}

/** Price reached the break-even trigger: the stop should now go to the entry. */
export function protectAlert(setup: AlertSetup, atR: number, fillPrice: number = setup.entryPrice): TradeAlert {
  return {
    title: `🔒 PINDAH SL KE ENTRY: ${side(setup)} sudah untung ${atR}R`,
    body: `Pindahkan stop ${setup.orderType} kamu ke ${price(fillPrice)} di MT5 sekarang, supaya trade ini tidak bisa lagi berubah jadi rugi penuh.`,
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
      title: `⚖️ IMPAS: ${side(setup)} tertutup di entry`,
      body: `${setup.orderType} dari ${price(fillPrice)} kembali ke entry setelah stop dipindah ke sana. Tidak rugi; hanya bayar spread. Hasilnya dicatat saat kamu membuka aplikasi.`,
      tag: `${setup.id}_closed`,
    };
  }
  const won = trigger !== 'SL';
  const moved = pips(exitPrice - fillPrice);
  return {
    title: won
      ? `🎯 KENA TAKE PROFIT ${trigger.slice(2)}: ${side(setup)} tertutup untung`
      : `🛑 KENA STOP LOSS: ${side(setup)} tertutup rugi`,
    body: won
      ? `${setup.orderType} dari ${price(fillPrice)} mencapai TP${trigger.slice(2)} di ${price(exitPrice)} (+${moved}). Hasilnya dicatat saat kamu membuka aplikasi.`
      : `${setup.orderType} dari ${price(fillPrice)} kena stop di ${price(exitPrice)} (-${moved}). Hasilnya dicatat saat kamu membuka aplikasi.`,
    tag: `${setup.id}_closed`,
  };
}

/** The pending order will not fill any more and should be deleted. */
export function missedAlert(setup: AlertSetup, reason: string): TradeAlert {
  return {
    title: `⚠️ ORDER TIDAK TERISI: hapus ${setup.orderType} @ ${price(setup.entryPrice)}`,
    body: `${reason} Hapus order pending ini di MT5 dan jangan dikejar dengan order market.`,
    tag: `${setup.id}_missed`,
  };
}

/** Price is within reach of the stop or the first target of an open position. */
export function nearLevelAlert(setup: AlertSetup, level: 'SL' | 'TP1', marketPrice: number): TradeAlert {
  const target = level === 'SL' ? setup.stopLoss : setup.takeProfit1;
  const distance = pips(target - marketPrice);
  return level === 'SL'
    ? {
        title: `⚠️ DEKAT STOP LOSS: ${side(setup)} ${distance} dari SL ${price(target)}`,
        body: `XAUUSD di ${price(marketPrice)}. ${setup.orderType} kamu dari ${price(setup.entryPrice)} sudah dekat stop-nya.`,
        tag: `${setup.id}_SL`,
      }
    : {
        title: `📈 DEKAT TAKE PROFIT 1: ${side(setup)} ${distance} dari TP1 ${price(target)}`,
        body: `XAUUSD di ${price(marketPrice)}. ${setup.orderType} kamu dari ${price(setup.entryPrice)} sudah dekat target pertamanya.`,
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
    title: `📊 SETUP BARU: ${setup.orderType} @ ${price(setup.entryPrice)}`,
    body: `SL ${price(setup.stopLoss)} · TP1 ${price(setup.takeProfit1)}${lot}.${ai ? ` ${ai}.` : ''} Buka aplikasi untuk memuatnya, lalu pasang ordernya di MT5.`,
    tag: `${scanId}_new`,
  };
}

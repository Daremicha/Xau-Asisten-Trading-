/**
 * The trade that was opened and stopped out in the same breath.
 *
 * A market order issued at 4346.31 with its stop 180 pips away was recorded as
 * a stop loss seconds later, on a quote that sat past the stop while the market
 * itself was still at 4346. The loss went into the ledger and the engine was
 * taught the setup had failed.
 */
import { describe, expect, test } from 'bun:test';
import { tickMayResolve } from '../lib/close-guard';
import { trackPosition } from '../lib/position-tracker';
import { resolveClose } from '../lib/order-replay';
import type { Candle } from '../lib/candles';
import type { InstitutionalTradingSetup } from '../lib/types';

const M15 = 15 * 60_000;
const NOW = Date.UTC(2026, 8, 18, 3, 14, 17);

// The market the user's chart actually showed: trading around 4346.
const candles: Candle[] = Array.from({ length: 8 }, (_, i) => ({
  time: NOW - (8 - i) * M15,
  open: 4346, high: 4350, low: 4342, close: 4346, volume: 100,
}));

// The exact order from the screenshot.
const setup = {
  orderType: 'SELL INSTANT',
  entryPrice: 4346.31,
  stopLoss: 4364.31,
  takeProfit1: 4337.31, takeProfit2: 4328.31, takeProfit3: 4319.31,
  timestamp: new Date(NOW - 4_000).toISOString(),  // four seconds old
  accountType: 'Cent',
} as unknown as InstitutionalTradingSetup;

// A quote from another moment, sitting past the stop. This is what recorded
// "Stop Loss ... -18.00 Cent" on a trade seconds after it opened.
const badQuote = 4365.0;

describe('the reported bug: opened and stopped out in the same breath', () => {
  test('before the guard, the tick calls it a stop loss', () => {
    const live = trackPosition(setup, badQuote, true);
    expect(live.state).toBe('closed');
    expect(live.closedBy).toBe('SL');
    const unguarded = resolveClose(null, live.closedBy);
    expect(unguarded?.trigger).toBe('SL');   // the false record
  });

  test('the guard refuses it', () => {
    const live = trackPosition(setup, badQuote, true);
    for (const [label, over] of [
      // The order's own age is what catches this one: an eighteen dollar drift
      // is inside twice the recent range, so plausibility alone would pass it.
      ['order four seconds old', {}],
      ['quote the feed called stale', { feedStatus: 'stale' }],
      ['quote two hundred seconds old', { quoteAgeSeconds: 200 }],
    ] as const) {
      const trust = tickMayResolve({
        feedStatus: 'live', quoteAgeSeconds: 5,
        issuedAt: setup.timestamp, price: badQuote, candles, now: NOW,
        ...over,
      });
      expect(trust.ok).toBe(false);
      if (!trust.ok) console.log(`  ${label}: refused — ${trust.reason.slice(0, 72)}…`);
      const guarded = resolveClose(null, trust.ok && live.state === 'closed' ? live.closedBy : null);
      expect(guarded).toBeNull();
    }
  });

  test('plausibility is the third line, and catches a futures-sized error', () => {
    // The COMEX basis measured earlier in this work was about thirty eight
    // dollars. That is what this rule is calibrated to reject.
    const trust = tickMayResolve({
      feedStatus: 'live', quoteAgeSeconds: 5,
      issuedAt: new Date(NOW - 600_000).toISOString(),
      price: 4385, candles, now: NOW,
    });
    expect(trust.ok).toBe(false);
    if (!trust.ok) console.log('  futures-sized quote refused —', trust.reason.slice(0, 70) + '…');
  });

  test('a real stop out, on a settled order and a believable quote, still closes', () => {
    // Same order ten minutes on, price genuinely up at the stop.
    const realistic: Candle[] = Array.from({ length: 8 }, (_, i) => ({
      time: NOW - (8 - i) * M15, open: 4358, high: 4366, low: 4352, close: 4362, volume: 100,
    }));
    const live = trackPosition(setup, 4364.5, true);
    const trust = tickMayResolve({
      feedStatus: 'live', quoteAgeSeconds: 6,
      issuedAt: new Date(NOW - 600_000).toISOString(),
      price: 4364.5, candles: realistic, now: NOW,
    });
    expect(trust.ok).toBe(true);
    const guarded = resolveClose(null, trust.ok && live.state === 'closed' ? live.closedBy : null);
    expect(guarded?.trigger).toBe('SL');
    console.log('  genuine stop out still recorded:', guarded?.trigger);
  });
});

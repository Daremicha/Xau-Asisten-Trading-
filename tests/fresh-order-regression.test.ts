/**
 * The setup that closed itself the moment it was offered.
 *
 * A resting order was reported as filled and stopped out one second after it
 * was issued, against a range price had traded through before anyone asked for
 * it. The bar already forming when an order is placed covers the fifteen
 * minutes *before* it existed, and the replay was reading outcomes from it.
 *
 * The close guard did not catch this: it gates the live tick, and the replay
 * is deliberately exempt from it because the replay carries its own timestamps.
 * Which is exactly why the replay has to use them honestly.
 */
import { describe, expect, test } from 'bun:test';
import { replayOrder, resolveClose, resolveMiss } from '../lib/order-replay';
import type { Candle } from '../lib/candles';
import type { InstitutionalTradingSetup } from '../lib/types';

const M15 = 15 * 60_000;
const BAR_OPEN = Date.UTC(2026, 8, 22, 11, 0, 0);
/** Fourteen minutes into the bar: the order is one minute from its close. */
const ISSUED = BAR_OPEN + 14 * 60_000;

/** A choppy two hours. The forming bar alone swung 4320 to 4372. */
function choppy(): Candle[] {
  return [
    { time: BAR_OPEN - 2 * M15, open: 4345, high: 4350, low: 4340, close: 4346, volume: 100 },
    { time: BAR_OPEN - M15, open: 4346, high: 4352, low: 4341, close: 4347, volume: 100 },
    { time: BAR_OPEN, open: 4347, high: 4372, low: 4320, close: 4346, volume: 100 },
  ];
}

function resting(over: Record<string, unknown> = {}) {
  return {
    orderType: 'BUY LIMIT',
    entryPrice: 4340,
    stopLoss: 4325,
    takeProfit1: 4360,
    takeProfit2: 4368,
    takeProfit3: 4375,
    timestamp: new Date(ISSUED).toISOString(),
    validUntil: new Date(ISSUED + 8 * 3_600_000).toISOString(),
    ...over,
  } as unknown as InstitutionalTradingSetup;
}

describe('an order issued this minute', () => {
  test('is not closed by the bar that was forming before it existed', () => {
    const verdict = replayOrder(resting(), choppy(), ISSUED + 1000);
    expect(verdict.kind).toBe('running');
    expect(resolveClose(verdict, null)).toBeNull();
  });

  test('is not called a miss by it either', () => {
    // The same bar ran a full stop distance past the entry. Read as evidence
    // it would have written a missed entry for an order a second old.
    const away = resting({ entryPrice: 4300, stopLoss: 4290 });
    const verdict = replayOrder(away, choppy(), ISSUED + 1000);
    expect(verdict.kind).not.toBe('missed');
    expect(resolveMiss(verdict, null)).toBeNull();
  });

  test('a market order is left running too', () => {
    const verdict = replayOrder(
      resting({ orderType: 'BUY INSTANT', entryPrice: 4346 }),
      choppy(),
      ISSUED + 1000
    );
    expect(verdict.kind).toBe('running');
  });
});

describe('what the forming bar may still establish', () => {
  test('a fill, because that only protects the order from being called missed', () => {
    // The bar's range contains the entry. Treating that as a fill is the safe
    // way to be wrong: it writes nothing and stops a false miss.
    const candles = choppy();
    const verdict = replayOrder(resting(), candles, ISSUED + 1000);
    expect(verdict.kind).toBe('running');
    if (verdict.kind !== 'running') throw new Error('expected a running position');
    expect(verdict.fillPrice).toBe(4340);
  });
});

describe('once bars of its own arrive, it resolves normally', () => {
  test('a stop reached in a later bar is a real stop', () => {
    const candles = [
      ...choppy(),
      { time: BAR_OPEN + M15, open: 4346, high: 4348, low: 4322, close: 4324, volume: 100 },
    ];
    const verdict = replayOrder(resting(), candles, ISSUED + 20 * 60_000);
    expect(verdict.kind).toBe('closed');
    if (verdict.kind !== 'closed') throw new Error('expected a close');
    expect(verdict.trigger).toBe('SL');
  });

  test('a target reached in a later bar is a real win', () => {
    const candles = [
      ...choppy(),
      { time: BAR_OPEN + M15, open: 4346, high: 4362, low: 4344, close: 4360, volume: 100 },
    ];
    const verdict = replayOrder(resting(), candles, ISSUED + 20 * 60_000);
    if (verdict.kind !== 'closed') throw new Error('expected a close');
    expect(verdict.trigger).toBe('TP1');
  });
});

/**
 * The setup closed by price action from its own past.
 *
 * Twelve Data's default timezone is the exchange's, not UTC. The parser added
 * a `Z` regardless, so the whole series arrived stamped four hours ahead: the
 * bar opening at 12:00 UTC came back as 16:00 and was read as 16:00 UTC.
 *
 * Every stale bar then looked like it came after the order. The replay walked
 * them as evidence and closed a setup the second it was offered — the banner
 * even said so, naming a time four hours in the future.
 */
import { describe, expect, test } from 'bun:test';
import { replayOrder, resolveClose, resolveMiss } from '../lib/order-replay';
import { parseTwelveDataTime } from '../lib/price-feed';
import type { Candle } from '../lib/candles';
import type { InstitutionalTradingSetup } from '../lib/types';

const M15 = 15 * 60_000;
const NOW = Date.parse('2026-09-22T12:05:00Z');   // 19:05 WIB, as reported
const SHIFT = 4 * 3_600_000;                       // what the exchange zone added

/** The real last two hours, then stamped four hours into the future. */
function shiftedHistory(): Candle[] {
  const lastOpen = Math.floor(NOW / M15) * M15;
  return Array.from({ length: 8 }, (_, i) => {
    const realOpen = lastOpen - (7 - i) * M15;
    const mid = 4320 + Math.sin(i) * 12;
    return {
      time: realOpen + SHIFT,     // the fault
      open: mid, high: mid + 10, low: mid - 10, close: mid, volume: 100,
    };
  });
}

const setup = {
  orderType: 'SELL LIMIT',
  entryPrice: 4339.72,
  stopLoss: 4357.72,
  takeProfit1: 4315.81, takeProfit2: 4300.0, takeProfit3: 4280.0,
  timestamp: new Date(NOW).toISOString(),
  validUntil: new Date(NOW + 8 * 3_600_000).toISOString(),
} as unknown as InstitutionalTradingSetup;

describe('a series stamped into the future', () => {
  test('cannot close a setup that was just offered', () => {
    const v = replayOrder(setup, shiftedHistory(), NOW + 1000);
    expect(v.kind).not.toBe('closed');
    expect(resolveClose(v, null)).toBeNull();
  });

  test('cannot record it as a miss either', () => {
    const v = replayOrder(setup, shiftedHistory(), NOW + 1000);
    expect(v.kind).not.toBe('missed');
    expect(resolveMiss(v, null)).toBeNull();
  });

  test('is reported as history it cannot read, not as an outcome', () => {
    const v = replayOrder(setup, shiftedHistory(), NOW + 1000);
    expect(v.kind).toBe('unknown');
  });

  test('a candle a couple of minutes ahead is clock skew, and still usable', () => {
    const lastOpen = Math.floor(NOW / M15) * M15;
    const candles: Candle[] = [
      { time: lastOpen - M15, open: 4330, high: 4341, low: 4320, close: 4335, volume: 100 },
      { time: NOW + 60_000, open: 4335, high: 4340, low: 4330, close: 4336, volume: 100 },
    ];
    expect(replayOrder(setup, candles, NOW).kind).not.toBe('unknown');
  });
});

describe('the parse that made the shift invisible', () => {
  test('a bare datetime is still read as UTC, which is why the request must ask for UTC', () => {
    expect(parseTwelveDataTime('2026-09-22 12:00:00')).toBe(Date.parse('2026-09-22T12:00:00Z'));
  });

  test('an explicit offset is honoured rather than overwritten', () => {
    expect(parseTwelveDataTime('2026-09-22 16:00:00+04:00')).toBe(Date.parse('2026-09-22T12:00:00Z'));
  });
});

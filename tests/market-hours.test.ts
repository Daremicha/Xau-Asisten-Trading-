import { describe, expect, test } from 'bun:test';
import { isGoldMarketClosed, tradingCandles } from '../lib/market-hours';

const at = (iso: string) => Date.parse(iso);
const bar = (iso: string) => ({ time: at(iso), open: 1, high: 1, low: 1, close: 1, volume: 0 });

describe('weekend bars are left out', () => {
  test('Saturday, late Friday and Sunday before the open are closed', () => {
    expect(isGoldMarketClosed(at('2026-09-19T12:00:00Z'))).toBe(true); // Saturday
    expect(isGoldMarketClosed(at('2026-09-18T22:00:00Z'))).toBe(true); // Friday 22:00
    expect(isGoldMarketClosed(at('2026-09-20T20:45:00Z'))).toBe(true); // Sunday 20:45
  });

  test('the hour either side of the closure is kept, since it trades in one season', () => {
    expect(isGoldMarketClosed(at('2026-09-18T21:45:00Z'))).toBe(false); // Friday 21:45
    expect(isGoldMarketClosed(at('2026-09-20T21:00:00Z'))).toBe(false); // Sunday 21:00
    expect(isGoldMarketClosed(at('2026-09-20T22:15:00Z'))).toBe(false);
  });

  test('weekdays are never touched', () => {
    for (let h = 0; h < 24; h++) {
      expect(isGoldMarketClosed(at(`2026-09-23T${String(h).padStart(2, '0')}:00:00Z`))).toBe(false);
    }
  });

  test('tradingCandles keeps order and drops only the closed bars', () => {
    const kept = tradingCandles([
      bar('2026-09-18T21:45:00Z'),
      bar('2026-09-19T03:00:00Z'),
      bar('2026-09-20T12:00:00Z'),
      bar('2026-09-20T22:00:00Z'),
    ]);
    expect(kept.map((c) => new Date(c.time).toISOString())).toEqual([
      '2026-09-18T21:45:00.000Z',
      '2026-09-20T22:00:00.000Z',
    ]);
  });
});

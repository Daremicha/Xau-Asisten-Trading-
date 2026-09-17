import { describe, expect, test } from 'bun:test';
import {
  isMarketClosed,
  nextCandleClose,
  nextCheck,
  nextMarketOpen,
  nextSessionOpen,
} from '../lib/next-check';

/** 2026-09-17 is a Thursday, which keeps the weekday cases uncomplicated. */
const THURSDAY = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 17, h, m));

describe('when the next candle closes', () => {
  test('a scalp waits for the next quarter hour', () => {
    expect(nextCandleClose('Scalping', THURSDAY(11, 7)).toISOString()).toBe('2026-09-17T11:15:00.000Z');
    expect(nextCandleClose('Scalping', THURSDAY(11, 15)).toISOString()).toBe('2026-09-17T11:30:00.000Z');
  });

  test('an intraday setup waits for the hour', () => {
    expect(nextCandleClose('Intraday', THURSDAY(11, 7)).toISOString()).toBe('2026-09-17T12:00:00.000Z');
  });

  test('a swing setup waits for the four hour boundary', () => {
    expect(nextCandleClose('Swing', THURSDAY(11, 7)).toISOString()).toBe('2026-09-17T12:00:00.000Z');
    expect(nextCandleClose('Swing', THURSDAY(12, 1)).toISOString()).toBe('2026-09-17T16:00:00.000Z');
  });

  test('a candle close is always ahead, never the moment itself', () => {
    for (const minute of [0, 1, 14, 15, 30, 44, 59]) {
      const now = THURSDAY(9, minute);
      expect(nextCandleClose('Scalping', now).getTime()).toBeGreaterThan(now.getTime());
    }
  });

  test('the last candle of the day rolls into tomorrow', () => {
    expect(nextCandleClose('Scalping', THURSDAY(23, 52)).toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });
});

describe('when the next session opens', () => {
  test('before London, the next opening is London', () => {
    const next = nextSessionOpen(THURSDAY(6, 30));
    expect(next.name).toBe('London open');
    expect(next.at.toISOString()).toBe('2026-09-17T07:00:00.000Z');
  });

  test('inside London, the next opening is New York', () => {
    expect(nextSessionOpen(THURSDAY(8)).name).toBe('New York open');
  });

  test('after the last opening, it rolls to tomorrow’s Asian session', () => {
    const next = nextSessionOpen(THURSDAY(20));
    expect(next.name).toBe('Asian session');
    expect(next.at.toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });
});

describe('the weekend recess', () => {
  test('the market is shut from Friday evening to Sunday night', () => {
    expect(isMarketClosed(new Date(Date.UTC(2026, 8, 18, 20, 59)))).toBe(false); // Friday 20:59
    expect(isMarketClosed(new Date(Date.UTC(2026, 8, 18, 21, 0)))).toBe(true); // Friday 21:00
    expect(isMarketClosed(new Date(Date.UTC(2026, 8, 19, 12, 0)))).toBe(true); // Saturday
    expect(isMarketClosed(new Date(Date.UTC(2026, 8, 20, 21, 59)))).toBe(true); // Sunday 21:59
    expect(isMarketClosed(new Date(Date.UTC(2026, 8, 20, 22, 0)))).toBe(false); // Sunday 22:00
  });

  test('the reopening is the coming Sunday at 22:00 UTC', () => {
    expect(nextMarketOpen(new Date(Date.UTC(2026, 8, 18, 22, 0))).toISOString()).toBe(
      '2026-09-20T22:00:00.000Z'
    );
    expect(nextMarketOpen(new Date(Date.UTC(2026, 8, 19, 12, 0))).toISOString()).toBe(
      '2026-09-20T22:00:00.000Z'
    );
  });

  test('a check during the recess points at the reopening and says so', () => {
    const check = nextCheck('Intraday', new Date(Date.UTC(2026, 8, 19, 12, 0)));
    expect(check.marketClosed).toBe(true);
    expect(check.at).toBe('2026-09-20T22:00:00.000Z');
    expect(check.reason).toContain('closed for the weekend');
  });
});

describe('what the user is told', () => {
  test('a weekday check points at the candle close and names the coming session', () => {
    const check = nextCheck('Intraday', THURSDAY(11, 40));
    expect(check.marketClosed).toBe(false);
    expect(check.at).toBe('2026-09-17T12:00:00.000Z');
    expect(check.reason).toContain('H1 candle closes in about 20 minutes');
    expect(check.session).toEqual({ name: 'New York open', at: '2026-09-17T12:00:00.000Z' });
  });

  test('the wait is never reported as zero minutes', () => {
    const check = nextCheck('Scalping', new Date(Date.UTC(2026, 8, 17, 11, 14, 59)));
    expect(check.reason).toContain('1 minute.');
  });

  test('every style names the timeframe it actually decides on', () => {
    expect(nextCheck('Scalping', THURSDAY(9)).reason).toContain('M15');
    expect(nextCheck('Intraday', THURSDAY(9)).reason).toContain('H1');
    expect(nextCheck('Swing', THURSDAY(9)).reason).toContain('H4');
  });
});

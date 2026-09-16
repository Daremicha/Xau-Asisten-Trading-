import { describe, expect, test } from 'bun:test';
import { computeValidity, evaluatePendingOrder, formatTimeLeft } from '../lib/order-validity';

const NOW = new Date('2026-09-16T10:00:00Z');

const pending = {
  orderType: 'BUY LIMIT' as const,
  entryPrice: 4190,
  stopLoss: 4182,
  takeProfit1: 4205,
  timestamp: NOW.toISOString(),
  validUntil: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
};

describe('how long an order stays worth leaving on the book', () => {
  test('a scalp expires in hours, a swing in days', () => {
    const scalp = computeValidity('Scalping', false, NOW);
    const intraday = computeValidity('Intraday', false, NOW);
    const swing = computeValidity('Swing', false, NOW);
    expect(scalp.validForMinutes).toBeLessThan(intraday.validForMinutes);
    expect(intraday.validForMinutes).toBeLessThan(swing.validForMinutes);
    expect(swing.validForMinutes).toBe(3 * 24 * 60);
  });

  test('a scalp inside a kill zone expires with that window', () => {
    expect(computeValidity('Scalping', true, NOW).validForMinutes).toBe(60);
    expect(computeValidity('Scalping', false, NOW).validForMinutes).toBe(90);
  });

  test('every window explains itself', () => {
    for (const style of ['Scalping', 'Intraday', 'Swing'] as const) {
      expect(computeValidity(style, false, NOW).basis.length).toBeGreaterThan(30);
    }
  });

  test('the deadline is a real timestamp in the future', () => {
    const w = computeValidity('Intraday', false, NOW);
    expect(new Date(w.validUntil).getTime()).toBe(NOW.getTime() + 8 * 60 * 60_000);
  });
});

describe('what ends a pending order besides a fill', () => {
  test('while price sits between entry and target it simply waits', () => {
    const v = evaluatePendingOrder(pending, 4195, NOW);
    expect(v.state).toBe('waiting');
    if (v.state === 'waiting') expect(v.minutesLeft).toBe(60);
  });

  test('price through the invalidation without filling voids the idea', () => {
    const v = evaluatePendingOrder(pending, 4180, NOW);
    expect(v.state).toBe('invalidated');
    expect(v.reason).toContain('void');
  });

  test('price reaching the target without filling means the move ran away', () => {
    const v = evaluatePendingOrder(pending, 4206, NOW);
    expect(v.state).toBe('ran-away');
    expect(v.reason).toContain('without filling');
  });

  test('the clock running out expires it', () => {
    const later = new Date(NOW.getTime() + 2 * 60 * 60_000);
    expect(evaluatePendingOrder(pending, 4195, later).state).toBe('expired');
  });

  test('invalidation is checked before the clock, since the idea died first', () => {
    const later = new Date(NOW.getTime() + 2 * 60 * 60_000);
    expect(evaluatePendingOrder(pending, 4180, later).state).toBe('invalidated');
  });

  test('a sell order mirrors every rule', () => {
    const sell = { ...pending, orderType: 'SELL LIMIT' as const, entryPrice: 4210, stopLoss: 4218, takeProfit1: 4195 };
    expect(evaluatePendingOrder(sell, 4219, NOW).state).toBe('invalidated');
    expect(evaluatePendingOrder(sell, 4194, NOW).state).toBe('ran-away');
    expect(evaluatePendingOrder(sell, 4205, NOW).state).toBe('waiting');
  });

  test('an order with no deadline waits rather than expiring by accident', () => {
    const noDeadline = { ...pending, validUntil: undefined };
    expect(evaluatePendingOrder(noDeadline, 4195, NOW).state).toBe('waiting');
  });

  test('a corrupt deadline does not expire the order', () => {
    const bad = { ...pending, validUntil: 'not-a-date' };
    expect(evaluatePendingOrder(bad, 4195, NOW).state).toBe('waiting');
  });
});

describe('the countdown reads naturally', () => {
  test('minutes, hours and days each phrase correctly', () => {
    expect(formatTimeLeft(45)).toBe('45m left');
    expect(formatTimeLeft(90)).toBe('1h 30m left');
    expect(formatTimeLeft(120)).toBe('2h left');
    expect(formatTimeLeft(3000)).toBe('2d 2h left');
  });

  test('a passed deadline reads as expired, never as a negative', () => {
    expect(formatTimeLeft(0)).toBe('expired');
    expect(formatTimeLeft(-10)).toBe('expired');
    expect(formatTimeLeft(Infinity)).toBe('expired');
  });
});

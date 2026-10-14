import { describe, expect, test } from 'bun:test';
import {
  computeValidity,
  evaluatePendingOrder,
  formatTimeLeft,
  isDeadOnArrival,
  missAtR,
  missCause,
} from '../lib/order-validity';

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
    expect(v.reason).toContain('batal');
  });

  test('price running a full stop distance past the entry means the move ran away', () => {
    const v = evaluatePendingOrder(pending, 4206, NOW);
    expect(v.state).toBe('ran-away');
    expect(v.reason).toContain('tanpa pernah mengisinya');
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
    expect(formatTimeLeft(45)).toBe('45 mnt lagi');
    expect(formatTimeLeft(90)).toBe('1 jam 30 mnt lagi');
    expect(formatTimeLeft(120)).toBe('2 jam lagi');
    expect(formatTimeLeft(3000)).toBe('2 hari 2 jam lagi');
  });

  test('a passed deadline reads as expired, never as a negative', () => {
    expect(formatTimeLeft(0)).toBe('kedaluwarsa');
    expect(formatTimeLeft(-10)).toBe('kedaluwarsa');
    expect(formatTimeLeft(Infinity)).toBe('kedaluwarsa');
  });
});

describe('the cause of a miss is specific, since each teaches a different lesson', () => {
  test('a runaway says the entry sat too deep', () => {
    expect(missCause('ran-away')).toContain('terlalu dalam dibanding koreksi pasar');
  });

  test('an invalidation says the directional read was wrong', () => {
    expect(missCause('invalidated')).toContain('bacaan arahnya salah');
  });

  test('an expiry says the level never came back', () => {
    expect(missCause('expired')).toContain('tanpa harga pernah mencapai entry');
  });

  test('the three causes are all different, so learning can tell them apart', () => {
    const causes = new Set([missCause('ran-away'), missCause('invalidated'), missCause('expired')]);
    expect(causes.size).toBe(3);
  });

  test('a waiting order has no miss cause to report', () => {
    expect(missCause('waiting')).toBe('Order tidak terisi.');
  });
});

describe('an order that would be dead the moment it is placed', () => {
  // The setup from the screen recording: a BUY LIMIT eight-and-twenty dollars
  // under a market that had already left it behind, carrying an eighteen dollar
  // stop. It was recorded as a missed entry seconds after being offered.
  const stranded = { orderType: 'BUY LIMIT' as const, entryPrice: 4318.54, stopLoss: 4300.54 };

  test('the engine and the pending evaluator agree that it is dead', () => {
    expect(isDeadOnArrival(stranded, 4346.31)).toBe(true);
    expect(
      evaluatePendingOrder({ ...stranded, takeProfit1: 4338.79, timestamp: new Date().toISOString() }, 4346.31).state
    ).toBe('ran-away');
  });

  test('an order price can still come back to is alive', () => {
    expect(isDeadOnArrival(stranded, 4330)).toBe(false);
    expect(isDeadOnArrival(stranded, 4336.53)).toBe(false);
  });

  test('the threshold is the stop the order carries, not a fixed distance', () => {
    const wide = { orderType: 'BUY LIMIT' as const, entryPrice: 4318.54, stopLoss: 4278.54 };
    expect(isDeadOnArrival(wide, 4346.31)).toBe(false);
  });

  test('a sell limit is judged the other way round', () => {
    const sell = { orderType: 'SELL LIMIT' as const, entryPrice: 4350, stopLoss: 4368 };
    expect(isDeadOnArrival(sell, 4330)).toBe(true);
    expect(isDeadOnArrival(sell, 4345)).toBe(false);
  });

  test('a market order has nothing to run away from', () => {
    expect(isDeadOnArrival({ ...stranded, orderType: 'BUY INSTANT' }, 4346.31)).toBe(false);
  });
});

describe('the quick target waits longer before calling a miss', () => {
  test('the miss distance is one stop for the engine targets and one and a half for the quick target', () => {
    expect(missAtR(false)).toBe(1);
    expect(missAtR(true)).toBe(1.5);
  });

  test('a run of one stop distance is still waiting under the quick target', () => {
    // Entry 4190, stop 4182: risk 8. 4199 is 9 past the entry, under 12.
    expect(evaluatePendingOrder(pending, 4199, NOW).state).toBe('ran-away');
    expect(evaluatePendingOrder({ ...pending, missAtR: 1.5 }, 4199, NOW).state).toBe('waiting');
  });

  test('one and a half stop distances is a miss under the quick target', () => {
    const v = evaluatePendingOrder({ ...pending, missAtR: 1.5 }, 4202, NOW);
    expect(v.state).toBe('ran-away');
    expect(v.reason).toContain('1.5 kali jarak stop');
  });
});

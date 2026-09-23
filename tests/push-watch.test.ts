import { describe, expect, test } from 'bun:test';
import { messagesFor, sanitiseSubscription, sanitiseWatchedSetup, type WatchedSetup } from '../lib/push-watch';
import { replayOrder } from '../lib/order-replay';
import type { Candle } from '../lib/candles';

const T0 = Date.UTC(2026, 8, 22, 8, 0);
const M15 = 15 * 60_000;

const buyLimit: WatchedSetup = {
  id: 'setup-1',
  orderType: 'BUY LIMIT',
  entryPrice: 4300,
  stopLoss: 4290,
  takeProfit1: 4320,
  takeProfit2: 4330,
  takeProfit3: 4340,
  timestamp: new Date(T0).toISOString(),
  validUntil: new Date(T0 + 24 * 3_600_000).toISOString(),
  status: 'PENDING',
};

function bars(...ranges: Array<[number, number]>): Candle[] {
  return ranges.map(([low, high], i) => ({
    time: T0 + i * M15,
    open: (low + high) / 2,
    high,
    low,
    close: (low + high) / 2,
    volume: 0,
  }));
}

const run = (candles: Candle[], price: number | null, sent: string[] = []) => {
  const now = candles[candles.length - 1].time + 60_000;
  return messagesFor(buyLimit, replayOrder(buyLimit, candles, now), price, new Set(sent));
};

describe('what the phone is told', () => {
  test('nothing while the order waits for its entry', () => {
    expect(run(bars([4302, 4306], [4304, 4309]), 4306)).toEqual([]);
  });

  test('a fill is announced once', () => {
    const candles = bars([4302, 4306], [4299, 4306]);
    const first = run(candles, 4305);
    expect(first.map((m) => m.key)).toEqual(['setup-1:filled']);
    expect(first[0].title).toContain('filled at $4300.00');
    expect(run(candles, 4305, ['setup-1:filled'])).toEqual([]);
  });

  test('price within ten pips of the stop warns, with the tag the open app uses', () => {
    const messages = run(bars([4302, 4306], [4299, 4306]), 4290.6, ['setup-1:filled']);
    expect(messages.map((m) => m.key)).toEqual(['setup-1:near-SL']);
    expect(messages[0].tag).toBe('setup-1_SL');
    expect(messages[0].final).toBe(false);
  });

  test('price near the first target says so', () => {
    const messages = run(bars([4302, 4306], [4299, 4318]), 4319.5, ['setup-1:filled']);
    expect(messages.map((m) => m.key)).toEqual(['setup-1:near-TP1']);
  });

  test('a stop out is final, and names the exit', () => {
    const messages = run(bars([4302, 4306], [4299, 4306], [4288, 4301]), 4289, ['setup-1:filled']);
    expect(messages).toHaveLength(1);
    expect(messages[0].title).toBe('Stop Loss hit at $4290.00');
    expect(messages[0].final).toBe(true);
  });

  test('a target hit is final', () => {
    const messages = run(bars([4302, 4306], [4299, 4306], [4305, 4332]), 4331, ['setup-1:filled']);
    expect(messages[0].title).toBe('Take Profit 2 hit at $4330.00');
    expect(messages[0].final).toBe(true);
  });

  test('a missed order says to cancel it, not to chase it', () => {
    // Ran a full stop distance past the entry without ever filling.
    const messages = run(bars([4302, 4306], [4309, 4312]), 4311);
    expect(messages.map((m) => m.key)).toEqual(['setup-1:missed']);
    expect(messages[0].body).toContain('do not chase it');
    expect(messages[0].final).toBe(true);
  });
});

describe('what the server accepts', () => {
  test('a setup keeps only the watched fields', () => {
    const cleaned = sanitiseWatchedSetup({ ...buyLimit, recommendedLotSize: 0.01, riskDollarAmount: 5 });
    expect(cleaned).toEqual(buyLimit);
  });

  test('a resolved setup means stop watching', () => {
    expect(sanitiseWatchedSetup({ ...buyLimit, status: 'TP_HIT' })).toBeNull();
    expect(sanitiseWatchedSetup(null)).toBeNull();
  });

  test('a setup with a missing or bogus level is refused', () => {
    expect(sanitiseWatchedSetup({ ...buyLimit, stopLoss: 'x' })).toBeNull();
    expect(sanitiseWatchedSetup({ ...buyLimit, takeProfit1: -1 })).toBeNull();
    expect(sanitiseWatchedSetup({ ...buyLimit, orderType: 'HOLD' })).toBeNull();
  });

  const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

  test('a real push service endpoint is accepted', () => {
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def', keys };
    expect(sanitiseSubscription(sub)).toEqual(sub);
  });

  test('an endpoint that is not a push service is refused, so the server never fetches it', () => {
    expect(sanitiseSubscription({ endpoint: 'https://evil.example/fcm.googleapis.com', keys })).toBeNull();
    expect(sanitiseSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys })).toBeNull();
    expect(sanitiseSubscription({ endpoint: 'https://fcm.googleapis.com.evil.example/x', keys })).toBeNull();
    expect(sanitiseSubscription({ endpoint: 'https://169.254.169.254/latest', keys })).toBeNull();
  });

  test('keys that are not base64url are refused', () => {
    expect(
      sanitiseSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'a b', auth: 'c' } })
    ).toBeNull();
  });
});

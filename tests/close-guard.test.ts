import { describe, expect, test } from 'bun:test';
import { tickMayResolve } from '../lib/close-guard';
import type { Candle } from '../lib/candles';

const M15 = 15 * 60_000;
const NOW = Date.UTC(2026, 8, 18, 3, 30, 0);

/** Two hours of candles trading between 4340 and 4352. */
function recent(): Candle[] {
  return Array.from({ length: 8 }, (_, i) => {
    const mid = 4346;
    return {
      time: NOW - (8 - i) * M15,
      open: mid,
      high: mid + 6,
      low: mid - 6,
      close: mid,
      volume: 100,
    };
  });
}

function inputs(over: Record<string, unknown> = {}) {
  return {
    feedStatus: 'live' as const,
    quoteAgeSeconds: 5,
    issuedAt: new Date(NOW - 10 * 60_000).toISOString(),
    price: 4347,
    candles: recent(),
    now: NOW,
    ...over,
  };
}

describe('an ordinary live quote on a settled order', () => {
  test('is allowed to close it', () => {
    expect(tickMayResolve(inputs()).ok).toBe(true);
  });

  test('is still allowed when no candles are loaded to check against', () => {
    // The other guards still applied; there is simply nothing to compare to.
    expect(tickMayResolve(inputs({ candles: [] })).ok).toBe(true);
  });

  test('is allowed when the quote age is unknown', () => {
    expect(tickMayResolve(inputs({ quoteAgeSeconds: null })).ok).toBe(true);
  });
});

describe('the price that closed a trade that had just been opened', () => {
  test('an order seconds old cannot be closed by a tick', () => {
    // The reported bug: a market order issued and stopped out in the same
    // breath, on a stop a hundred and eighty pips away.
    const verdict = tickMayResolve(inputs({ issuedAt: new Date(NOW - 3_000).toISOString() }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.reason).toContain('harga dari waktu lain');
  });

  test('the same order a minute later may be closed', () => {
    expect(tickMayResolve(inputs({ issuedAt: new Date(NOW - 60_000).toISOString() })).ok).toBe(true);
  });

  test('the boundary is not open on the wrong side', () => {
    expect(tickMayResolve(inputs({ issuedAt: new Date(NOW - 44_000).toISOString() })).ok).toBe(false);
    expect(tickMayResolve(inputs({ issuedAt: new Date(NOW - 46_000).toISOString() })).ok).toBe(true);
  });
});

describe('a quote the app itself does not believe', () => {
  test('a stale quote may not end a trade', () => {
    // The feed marks a price stale once it is too old to trade on. It was
    // being used to close trades anyway.
    const verdict = tickMayResolve(inputs({ feedStatus: 'stale' }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.reason).toContain('tidak live');
  });

  test('nor may an unavailable one', () => {
    expect(tickMayResolve(inputs({ feedStatus: 'unavailable' })).ok).toBe(false);
  });

  test('a live quote that has nonetheless gone old may not either', () => {
    expect(tickMayResolve(inputs({ quoteAgeSeconds: 300 })).ok).toBe(false);
  });

  test('an order with no readable time is refused rather than guessed at', () => {
    expect(tickMayResolve(inputs({ issuedAt: undefined })).ok).toBe(false);
    expect(tickMayResolve(inputs({ issuedAt: 'not a date' })).ok).toBe(false);
  });
});

describe('a price that contradicts the candles', () => {
  test('a quote far outside what the market just traded is disbelieved', () => {
    // The futures basis, or a quote from hours ago: either way it describes a
    // market this one is not.
    const verdict = tickMayResolve(inputs({ price: 4390 }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.reason).toContain('menggambarkan waktu lain');
  });

  test('and so is one far below', () => {
    expect(tickMayResolve(inputs({ price: 4300 })).ok).toBe(false);
  });

  test('a genuine fast move is still allowed through', () => {
    // The last two hours spanned twelve dollars; this is eleven beyond the
    // high, which is violent but real. Blocking it would delay real stop outs.
    expect(tickMayResolve(inputs({ price: 4363 })).ok).toBe(true);
  });

  test('a flat market does not make every quote implausible', () => {
    // A zero range would otherwise reject everything but the exact price.
    const flat = recent().map((c) => ({ ...c, high: 4346, low: 4346 }));
    expect(tickMayResolve(inputs({ candles: flat, price: 4351 })).ok).toBe(true);
  });
});

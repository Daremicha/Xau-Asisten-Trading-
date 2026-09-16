import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ACTIVE_SETUP_KEY,
  clearActiveSetup,
  isUnresolved,
  loadActiveSetup,
  pickNewer,
  saveActiveSetup,
} from '../lib/active-setup-store';
import type { InstitutionalTradingSetup, SignalStatus } from '../lib/types';

function installStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  } as Storage;
  return map;
}

function setup(status: SignalStatus, timestamp = '2026-09-16T10:00:00Z'): InstitutionalTradingSetup {
  return {
    id: 'setup_1', status, timestamp,
    orderType: 'BUY LIMIT', entryPrice: 4337.86, stopLoss: 4319.86,
    takeProfit1: 4364.86, takeProfit2: 4384.66, takeProfit3: 4409.86,
  } as unknown as InstitutionalTradingSetup;
}

beforeEach(() => installStorage());

describe('an order the user has not resolved is held', () => {
  test('an active setup survives a reload', () => {
    saveActiveSetup(setup('ACTIVE'));
    const restored = loadActiveSetup();
    expect(restored).not.toBeNull();
    expect(restored!.entryPrice).toBe(4337.86);
    expect(restored!.orderType).toBe('BUY LIMIT');
  });

  test('a pending setup is held too', () => {
    saveActiveSetup(setup('PENDING'));
    expect(loadActiveSetup()).not.toBeNull();
  });

  test('an expired window does not clear it; only recording an outcome does', () => {
    // The whole point: the user must acknowledge it so the engine learns.
    saveActiveSetup(setup('ACTIVE', '2020-01-01T00:00:00Z'));
    expect(loadActiveSetup()).not.toBeNull();
  });
});

describe('a resolved trade is not held', () => {
  test.each(['TP_HIT', 'SL_HIT', 'MISSED', 'CANCELLED'] as SignalStatus[])(
    'status %s clears the stored setup',
    (status) => {
      saveActiveSetup(setup('ACTIVE'));
      expect(loadActiveSetup()).not.toBeNull();
      saveActiveSetup(setup(status));
      expect(loadActiveSetup()).toBeNull();
    }
  );

  test('saving null clears it', () => {
    saveActiveSetup(setup('ACTIVE'));
    saveActiveSetup(null);
    expect(loadActiveSetup()).toBeNull();
  });

  test('clearing explicitly works', () => {
    saveActiveSetup(setup('ACTIVE'));
    clearActiveSetup();
    expect(loadActiveSetup()).toBeNull();
  });
});

describe('a corrupt or foreign value never reaches the app', () => {
  test('unparseable JSON restores nothing rather than throwing', () => {
    installStorage({ [ACTIVE_SETUP_KEY]: '{not json' });
    expect(loadActiveSetup()).toBeNull();
  });

  test('an object missing the prices it cannot rebuild is rejected', () => {
    installStorage({ [ACTIVE_SETUP_KEY]: JSON.stringify({ id: 'x', status: 'ACTIVE' }) });
    expect(loadActiveSetup()).toBeNull();
  });

  test('storage that throws is treated as empty', () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;
    expect(() => saveActiveSetup(setup('ACTIVE'))).not.toThrow();
    expect(loadActiveSetup()).toBeNull();
  });
});

describe('choosing between a cloud and a browser copy', () => {
  test('the newer timestamp wins', () => {
    const older = setup('ACTIVE', '2026-09-16T10:00:00Z');
    const newer = setup('ACTIVE', '2026-09-16T12:00:00Z');
    expect(pickNewer(older, newer)).toBe(newer);
    expect(pickNewer(newer, older)).toBe(newer);
  });

  test('a missing copy falls back to the other', () => {
    const only = setup('ACTIVE');
    expect(pickNewer(null, only)).toBe(only);
    expect(pickNewer(only, null)).toBe(only);
    expect(pickNewer(null, null)).toBeNull();
  });

  test('an unreadable timestamp yields to the readable one', () => {
    const broken = setup('ACTIVE', 'not-a-date');
    const good = setup('ACTIVE', '2026-09-16T10:00:00Z');
    expect(pickNewer(broken, good)).toBe(good);
  });
});

describe('what counts as unresolved', () => {
  test('only pending and active are held', () => {
    expect(isUnresolved(setup('ACTIVE'))).toBe(true);
    expect(isUnresolved(setup('PENDING'))).toBe(true);
    expect(isUnresolved(setup('TP_HIT'))).toBe(false);
    expect(isUnresolved(null)).toBe(false);
  });
});

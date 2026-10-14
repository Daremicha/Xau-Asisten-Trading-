import { describe, expect, test } from 'bun:test';
import { trackPosition } from '../lib/position-tracker';
import { LIVE_LEARNING, learningInput } from '../lib/tested-configuration';
import type { InstitutionalTradingSetup } from '../lib/types';

const setup = {
  id: 'be-1',
  orderType: 'SELL LIMIT',
  entryPrice: 4280,
  stopLoss: 4298,
  takeProfit1: 4253,
  takeProfit2: 4233,
  takeProfit3: 4208,
  recommendedLotSize: 0.01,
  accountType: 'Cent',
} as unknown as InstitutionalTradingSetup;

describe('the tick tracker under the break-even rule', () => {
  test('before it arms, a return to the entry is just a position still open', () => {
    expect(trackPosition(setup, 4280.5, true).closedBy).toBeNull();
  });

  test('once armed, the entry is the stop, and reaching it closes at break-even', () => {
    const live = trackPosition(setup, 4280.5, true, true);
    expect(live.closedBy).toBe('SL');
    expect(live.summary).toBe('Posisi tertutup impas.');
  });

  test('once armed, the original stop is no longer the level that matters', () => {
    expect(trackPosition(setup, 4275, true, true).closedBy).toBeNull();
  });
});

describe('live learning', () => {
  test('is off, so the engine trades the tested weights whatever the ledger holds', () => {
    expect(LIVE_LEARNING).toBe(false);
    expect(learningInput([1, 2, 3])).toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';
import {
  contractOunces,
  detectClose,
  floatingResult,
  hasReachedEntry,
  trackPosition,
} from '../lib/position-tracker';
import type { InstitutionalTradingSetup, OrderExecutionType } from '../lib/types';

function setup(overrides: Partial<InstitutionalTradingSetup> = {}): InstitutionalTradingSetup {
  return {
    id: 's1', status: 'PENDING', timestamp: '2026-09-16T10:00:00Z',
    orderType: 'BUY LIMIT', entryPrice: 4200, stopLoss: 4190,
    takeProfit1: 4215, takeProfit2: 4225, takeProfit3: 4240,
    recommendedLotSize: 0.1, accountType: 'Standard',
    contractSpecs: { contractSizeOz: 100 },
    ...overrides,
  } as unknown as InstitutionalTradingSetup;
}

describe('knowing when an order has actually filled', () => {
  const cases: Array<[OrderExecutionType, number, number, boolean, string]> = [
    ['BUY LIMIT', 4200, 4199, true, 'price came down to the limit'],
    ['BUY LIMIT', 4200, 4205, false, 'price still above the limit'],
    ['SELL LIMIT', 4200, 4201, true, 'price came up to the limit'],
    ['SELL LIMIT', 4200, 4195, false, 'price still below the limit'],
    ['BUY STOP', 4200, 4201, true, 'price broke up through the stop'],
    ['BUY STOP', 4200, 4195, false, 'price has not reached the stop'],
    ['SELL STOP', 4200, 4199, true, 'price broke down through the stop'],
    ['SELL STOP', 4200, 4205, false, 'price has not reached the stop'],
  ];

  for (const [orderType, entry, price, expected, why] of cases) {
    test(`${orderType} at ${entry} with price ${price}: ${why}`, () => {
      expect(hasReachedEntry(orderType, entry, price)).toBe(expected);
    });
  }

  test('an instant order is filled the moment it is placed', () => {
    expect(hasReachedEntry('BUY INSTANT', 4200, 4180)).toBe(true);
    expect(hasReachedEntry('SELL INSTANT', 4200, 4300)).toBe(true);
  });

  test('touching the exact entry counts as filled', () => {
    expect(hasReachedEntry('BUY LIMIT', 4200, 4200)).toBe(true);
  });
});

describe('floating result while a position runs', () => {
  test('a long in profit reports a gain', () => {
    const r = floatingResult(setup(), 4210);
    expect(r.pips).toBe(100);
    expect(r.dollars).toBe(100); // 0.1 lot x 100 oz x 10 dollars
  });

  test('a long in drawdown reports a loss', () => {
    const r = floatingResult(setup(), 4195);
    expect(r.pips).toBe(-50);
    expect(r.dollars).toBe(-50);
  });

  test('a short is the mirror: price falling is profit', () => {
    const r = floatingResult(setup({ orderType: 'SELL LIMIT' }), 4190);
    expect(r.pips).toBe(100);
    expect(r.dollars).toBeGreaterThan(0);
  });

  test('a cent account moves a hundredth of a standard account', () => {
    const std = floatingResult(setup(), 4210);
    const cent = floatingResult(
      setup({ accountType: 'Cent', contractSpecs: { contractSizeOz: 1 } as never }),
      4210
    );
    expect(cent.dollars).toBeCloseTo(std.dollars / 100, 2);
  });

  test('sitting exactly at entry floats nothing', () => {
    expect(floatingResult(setup(), 4200).dollars).toBe(0);
  });

  test('contract size falls back sensibly when the specs are missing', () => {
    expect(contractOunces({ accountType: 'Cent' } as never)).toBe(1);
    expect(contractOunces({ accountType: 'Standard' } as never)).toBe(100);
  });
});

describe('detecting a close', () => {
  test('each target is recognised, furthest first', () => {
    expect(detectClose(setup(), 4216)).toBe('TP1');
    expect(detectClose(setup(), 4226)).toBe('TP2');
    expect(detectClose(setup(), 4241)).toBe('TP3');
  });

  test('the stop is recognised', () => {
    expect(detectClose(setup(), 4189)).toBe('SL');
  });

  test('price between entry and the first target is still running', () => {
    expect(detectClose(setup(), 4205)).toBeNull();
  });

  test('a short mirrors every level', () => {
    const short = setup({
      orderType: 'SELL LIMIT', entryPrice: 4200, stopLoss: 4210,
      takeProfit1: 4185, takeProfit2: 4175, takeProfit3: 4160,
    });
    expect(detectClose(short, 4184)).toBe('TP1');
    expect(detectClose(short, 4159)).toBe('TP3');
    expect(detectClose(short, 4211)).toBe('SL');
    expect(detectClose(short, 4195)).toBeNull();
  });

  test('when both the stop and a target are reachable the stop wins', () => {
    // The conservative reading, and the one a broker usually gives you.
    const wide = setup({ stopLoss: 4220, takeProfit1: 4215 });
    expect(detectClose(wide, 4218)).toBe('SL');
  });
});

describe('the full live state', () => {
  test('an unfilled order reports the distance left to travel', () => {
    const p = trackPosition(setup(), 4206, false);
    expect(p.state).toBe('pending');
    expect(p.distanceToEntryPips).toBe(60);
    expect(p.floatingDollars).toBeNull();
    expect(p.summary).toContain('Waiting for price');
  });

  test('a filled order reports its floating result', () => {
    // A buy limit at 4200 only fills when price comes down to it. Price at
    // 4208 means it filled earlier and has since run into profit.
    const p = trackPosition(setup(), 4208, true);
    expect(p.state).toBe('filled');
    expect(p.floatingPips).toBe(80);
    expect(p.summary).toContain('profit');
  });

  test('price above a buy limit it never reached is still pending', () => {
    const p = trackPosition(setup(), 4208, false);
    expect(p.state).toBe('pending');
    expect(p.distanceToEntryPips).toBe(80);
  });

  test('a filled order in drawdown says so', () => {
    const p = trackPosition(setup(), 4196, true);
    expect(p.floatingDollars).toBeLessThan(0);
    expect(p.summary).toContain('drawdown');
  });

  test('a fill latches: drifting back past the entry does not un-fill it', () => {
    // Price filled the order, then ran up beyond it. The position is open.
    const p = trackPosition(setup(), 4210, true);
    expect(p.state).toBe('filled');
    expect(p.distanceToEntryPips).toBeNull();
  });

  test('reaching a target marks it closed', () => {
    const p = trackPosition(setup(), 4216, true);
    expect(p.state).toBe('closed');
    expect(p.closedBy).toBe('TP1');
  });

  test('progress toward the first target is reported between minus one and one', () => {
    expect(trackPosition(setup(), 4200, true).progressToTarget).toBe(0);
    expect(trackPosition(setup(), 4207.5, true).progressToTarget).toBeCloseTo(0.5, 2);
    expect(trackPosition(setup(), 4180, true).progressToTarget).toBe(-1);
  });

  test('a zero width target does not divide by zero', () => {
    const p = trackPosition(setup({ takeProfit1: 4200 }), 4200, true);
    expect(p.progressToTarget).toBe(0);
  });
});

describe('money keeps cent precision while a position runs', () => {
  test('a float smaller than a whole cent is not rounded away', () => {
    // A cent account, minimum lot: one troy ounce. A forty five cent move is
    // 0.0045 dollars, which two decimal places erase entirely.
    const result = floatingResult(
      setup({
        orderType: 'BUY LIMIT',
        entryPrice: 4300,
        recommendedLotSize: 0.01,
        accountType: 'Cent',
        contractSpecs: { contractSizeOz: 1 } as never,
      }),
      4300.45
    );
    expect(result.dollars).toBeCloseTo(0.0045, 6);
    expect(result.dollars).not.toBe(0);
    expect(result.pips).toBe(4.5);
  });

  test('a short is the mirror of it', () => {
    const short = setup({
      orderType: 'SELL LIMIT',
      entryPrice: 4300,
      recommendedLotSize: 0.01,
      accountType: 'Cent',
      contractSpecs: { contractSizeOz: 1 } as never,
    });
    expect(floatingResult(short, 4300.45).dollars).toBeCloseTo(-0.0045, 6);
  });
});

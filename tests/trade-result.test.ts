import { describe, expect, test } from 'bun:test';
import { computeTradeResult, contractMultiplier, roundMoney } from '../lib/trade-result';
import type { InstitutionalTradingSetup } from '../lib/types';

type ResultSetup = Parameters<typeof computeTradeResult>[0];

function setup(overrides: Partial<InstitutionalTradingSetup> = {}): ResultSetup {
  return {
    entryPrice: 4300,
    recommendedLotSize: 0.1,
    accountType: 'Standard',
    contractSpecs: undefined,
    ...overrides,
  } as ResultSetup;
}

describe('contract size', () => {
  test('a standard lot controls 100 ounces', () => {
    expect(contractMultiplier(setup())).toBe(100);
  });

  test('a cent lot controls one ounce', () => {
    expect(contractMultiplier(setup({ accountType: 'Cent' }))).toBe(1);
  });

  test('a one-ounce contract spec wins over the account label', () => {
    expect(
      contractMultiplier(
        setup({ contractSpecs: { contractSizeOz: 1 } as InstitutionalTradingSetup['contractSpecs'] })
      )
    ).toBe(1);
  });
});

describe('trade result', () => {
  test('a take profit pays the distance times the contract', () => {
    const result = computeTradeResult(setup(), 4310, 'TP');
    expect(result.pips).toBe(100);
    expect(result.dollars).toBe(100);
  });

  test('a stop loss is signed negative', () => {
    const result = computeTradeResult(setup(), 4290, 'SL');
    expect(result.pips).toBe(-100);
    expect(result.dollars).toBe(-100);
  });

  test('a missed order moved neither price nor money', () => {
    const result = computeTradeResult(setup(), 4350, 'MISSED');
    expect(result.pips).toBe(0);
    expect(result.dollars).toBe(0);
  });

  test('a cent account books the same move on a one ounce contract', () => {
    // The case the user hit: a 0.01 cent lot stopped out 18.00 away is $0.18,
    // which is 18.00 Cent, not the 8.00 Cent risk budget the button used to show.
    const result = computeTradeResult(
      setup({ accountType: 'Cent', recommendedLotSize: 0.01, entryPrice: 4366.81 }),
      4348.81,
      'SL'
    );
    expect(result.dollars).toBe(-0.18);
  });

  test('a pro account pays commission out of the result', () => {
    const result = computeTradeResult(
      setup({
        accountType: 'Pro',
        contractSpecs: { commissionPerLot: 7 } as InstitutionalTradingSetup['contractSpecs'],
      }),
      4310,
      'TP'
    );
    expect(result.dollars).toBe(99.3);
  });

  test('commission also deepens a pro account loss', () => {
    const result = computeTradeResult(
      setup({
        accountType: 'Pro',
        contractSpecs: { commissionPerLot: 7 } as InstitutionalTradingSetup['contractSpecs'],
      }),
      4290,
      'SL'
    );
    expect(result.dollars).toBe(-100.7);
  });
});

describe('precision small enough for a cent account', () => {
  test('money keeps four decimals, because two is a whole cent unit', () => {
    expect(roundMoney(0.27364)).toBe(0.2736);
    expect(roundMoney(0.004495)).toBe(0.0045);
  });

  test('a cent trade is not flattened to a whole cent', () => {
    // 0.01 lots on one ounce moved 27.36, which is 27.36 cent, not 27.00.
    const result = computeTradeResult(
      setup({ accountType: 'Cent', recommendedLotSize: 0.01, entryPrice: 4300 }),
      4327.36,
      'TP'
    );
    expect(result.dollars).toBe(0.2736);
  });
});

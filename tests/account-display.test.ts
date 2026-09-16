import { describe, expect, test } from 'bun:test';
import {
  CENT_UNITS_PER_DOLLAR,
  GROUP_SEPARATOR,
  accountUnitLabel,
  formatAccountMoney,
  formatAccountTick,
  isCentAccount,
  toAccountUnits,
} from '../lib/account-display';

describe('account unit conversion', () => {
  test('a standard account is quoted in the dollars it holds', () => {
    expect(toAccountUnits(10, 'Standard')).toBe(10);
    expect(formatAccountMoney(10, 'Standard')).toBe('$10.00');
  });

  test('a pro account is quoted in dollars too', () => {
    expect(isCentAccount('Pro')).toBe(false);
    expect(formatAccountMoney(10, 'Pro')).toBe('$10.00');
  });

  test('a cent account restates the same value in cents', () => {
    expect(CENT_UNITS_PER_DOLLAR).toBe(100);
    expect(toAccountUnits(10, 'Cent')).toBe(1000);
    expect(formatAccountMoney(10, 'Cent')).toBe(`1${GROUP_SEPARATOR}000.00 Cent`);
  });

  test('the user-reported balance of $10.16 shows as 1 016.00 Cent', () => {
    expect(formatAccountMoney(10.16, 'Cent')).toBe(`1${GROUP_SEPARATOR}016.00 Cent`);
  });

  test('an unset account type falls back to dollars rather than guessing', () => {
    expect(formatAccountMoney(10, undefined)).toBe('$10.00');
    expect(formatAccountMoney(10, null)).toBe('$10.00');
  });
});

describe('formatting', () => {
  test('a loss keeps its sign in front of the unit', () => {
    expect(formatAccountMoney(-12.5, 'Standard')).toBe('-$12.50');
    expect(formatAccountMoney(-12.5, 'Cent')).toBe(`-1${GROUP_SEPARATOR}250.00 Cent`);
  });

  test('signed mode marks a gain but never writes +0', () => {
    expect(formatAccountMoney(4.2, 'Standard', { signed: true })).toBe('+$4.20');
    expect(formatAccountMoney(0, 'Standard', { signed: true })).toBe('+$0.00');
    expect(formatAccountMoney(-0, 'Standard', { signed: true })).toBe('+$0.00');
  });

  test('large balances group with commas in dollars and spaces in cents', () => {
    expect(formatAccountMoney(5000, 'Standard')).toBe('$5,000.00');
    expect(formatAccountMoney(5000, 'Cent')).toBe(`500${GROUP_SEPARATOR}000.00 Cent`);
  });

  test('axis ticks drop the decimals', () => {
    expect(formatAccountTick(5000, 'Standard')).toBe('$5,000');
    expect(formatAccountTick(10, 'Cent')).toBe(`1${GROUP_SEPARATOR}000 Cent`);
  });

  test('a non-finite amount reads as zero instead of NaN', () => {
    expect(formatAccountMoney(Number.NaN, 'Standard')).toBe('$0.00');
  });

  test('the unit label follows the account type', () => {
    expect(accountUnitLabel('Cent')).toBe('Cent');
    expect(accountUnitLabel('Standard')).toBe('USD');
  });
});

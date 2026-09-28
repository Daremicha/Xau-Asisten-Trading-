/**
 * Shows money in the unit the user's account is actually denominated in.
 *
 * Every figure the app computes is in USD, because that is what the gold price
 * and the contract specification are quoted in. A cent (USC) account holds the
 * same value but denominates it in hundredths of a dollar: a $10 deposit shows
 * as 1 000.00 Cent in the terminal. Displaying $10 there does not match what
 * the user sees in MetaTrader, so the display converts even though the maths
 * behind it never does.
 *
 * Conversion is display-only. Nothing here feeds position sizing, risk, or the
 * learning records, all of which stay in USD.
 */

import { AccountType } from './types';

/** A cent account denominates one dollar of value as 100 units. */
export const CENT_UNITS_PER_DOLLAR = 100;

/**
 * Digit grouping separator. MetaTrader groups a cent balance with a space
 * (1 016.00), and a non-breaking one keeps the number from wrapping mid-figure.
 */
export const GROUP_SEPARATOR = ' ';

export function isCentAccount(accountType?: AccountType | null): boolean {
  return accountType === 'Cent';
}

/** Converts an internal USD amount into the account's own unit. */
export function toAccountUnits(usd: number, accountType?: AccountType | null): number {
  if (!Number.isFinite(usd)) return 0;
  return isCentAccount(accountType) ? usd * CENT_UNITS_PER_DOLLAR : usd;
}

/** Converts an amount typed in the account's own unit back into internal USD. */
export function fromAccountUnits(amount: number, accountType?: AccountType | null): number {
  if (!Number.isFinite(amount)) return 0;
  return isCentAccount(accountType) ? amount / CENT_UNITS_PER_DOLLAR : amount;
}

/** The unit a balance is quoted in, for labels and column headers. */
export function accountUnitLabel(accountType?: AccountType | null): string {
  return isCentAccount(accountType) ? 'Cent' : 'USD';
}

export interface MoneyFormatOptions {
  /** Prefix a positive amount with +, for profit and loss figures. */
  signed?: boolean;
  /** Decimal places. Balances use 2; an axis tick may want 0. */
  decimals?: number;
}

function groupCents(magnitude: number, decimals: number): string {
  const text = magnitude.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return text.replace(/,/g, GROUP_SEPARATOR);
}

/**
 * Formats a USD amount the way the selected account type would show it.
 *
 * Standard and Pro: `$1,016.00`. Cent: `1 016.00 Cent`.
 */
export function formatAccountMoney(
  usd: number,
  accountType?: AccountType | null,
  options: MoneyFormatOptions = {}
): string {
  const { signed = false, decimals = 2 } = options;
  const amount = toAccountUnits(usd, accountType);
  // -0 formats as "-0.00" without this, which reads as a loss that never happened.
  const negative = amount < 0;
  const magnitude = Math.abs(amount);
  const sign = negative ? '-' : signed ? '+' : '';

  if (isCentAccount(accountType)) {
    return `${sign}${groupCents(magnitude, decimals)} Cent`;
  }

  return `${sign}$${magnitude.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Compact form for chart axis ticks, where space is tight. */
export function formatAccountTick(usd: number, accountType?: AccountType | null): string {
  return formatAccountMoney(usd, accountType, { decimals: 0 });
}

/**
 * A tick with the unit left off, for an axis that names the unit once.
 *
 * "1 024 Cent" wraps onto two lines in the width an axis can spare, and a
 * column of wrapped labels is harder to read than a column of numbers under a
 * heading that says what they are.
 */
export function formatAxisNumber(usd: number, accountType?: AccountType | null): string {
  const amount = toAccountUnits(usd, accountType);
  const negative = amount < 0;
  const magnitude = Math.abs(amount);
  const body = isCentAccount(accountType)
    ? groupCents(magnitude, 0)
    : magnitude.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return `${negative ? '-' : ''}${body}`;
}

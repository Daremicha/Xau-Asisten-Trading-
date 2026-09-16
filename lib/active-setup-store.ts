/**
 * Keeps the open setup alive across a page reload.
 *
 * The active setup lived only in React state, so refreshing the page threw away
 * an order the user had not yet resolved. The trade was still running in their
 * terminal, but the app had forgotten it, and the learning engine lost the
 * outcome entirely.
 *
 * A setup is held until the user records a take profit, a stop loss or a miss.
 * Nothing else clears it, including expiry: an expired order still has to be
 * acknowledged so the engine learns from it.
 */

import { InstitutionalTradingSetup, SignalStatus } from './types';

export const ACTIVE_SETUP_KEY = 'xauusd_active_setup';

/** Statuses that mean the user has not finished with this setup yet. */
const UNRESOLVED: SignalStatus[] = ['PENDING', 'ACTIVE'];

export function isUnresolved(setup: Pick<InstitutionalTradingSetup, 'status'> | null): boolean {
  return Boolean(setup && UNRESOLVED.includes(setup.status));
}

/** The fields the app cannot rebuild, so a restored setup must carry them. */
function looksLikeSetup(value: unknown): value is InstitutionalTradingSetup {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    typeof s.orderType === 'string' &&
    typeof s.entryPrice === 'number' &&
    typeof s.stopLoss === 'number' &&
    typeof s.takeProfit1 === 'number' &&
    typeof s.status === 'string'
  );
}

/** Stores the setup, or clears it once the user has resolved the trade. */
export function saveActiveSetup(setup: InstitutionalTradingSetup | null): void {
  try {
    if (!setup || !isUnresolved(setup)) {
      localStorage.removeItem(ACTIVE_SETUP_KEY);
      return;
    }
    localStorage.setItem(ACTIVE_SETUP_KEY, JSON.stringify(setup));
  } catch {
    // A browser that refuses storage simply loses the setup on reload, which is
    // the old behaviour rather than a new failure.
  }
}

/** Reads back an unresolved setup, or null when there is nothing to restore. */
export function loadActiveSetup(): InstitutionalTradingSetup | null {
  try {
    const raw = localStorage.getItem(ACTIVE_SETUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!looksLikeSetup(parsed)) return null;
    return isUnresolved(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearActiveSetup(): void {
  try {
    localStorage.removeItem(ACTIVE_SETUP_KEY);
  } catch {
    // Nothing to do; the next save overwrites it anyway.
  }
}

/** Picks the fresher of a cloud and a browser copy of the same slot. */
export function pickNewer(
  a: InstitutionalTradingSetup | null,
  b: InstitutionalTradingSetup | null
): InstitutionalTradingSetup | null {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a.timestamp ?? '');
  const tb = Date.parse(b.timestamp ?? '');
  if (!Number.isFinite(ta)) return b;
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
}

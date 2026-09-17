/**
 * Browser storage for the guest trader, and the shape used to carry that data
 * into the cloud the first time someone signs in.
 *
 * Every read is defensive: storage can be unavailable in a private window, and
 * a half written value from an older build must not crash the app.
 */

import { AccountType, BrokerId, SelfLearningMemoryRecord, TradingStyle } from './types';
import { chronological, normalisePrior, type PriorWeights } from './learning-engine';

export const LOCAL_KEYS = {
  equity: 'xauusd_locked_equity',
  initialEquity: 'xauusd_initial_equity',
  isLocked: 'xauusd_is_equity_locked',
  riskPct: 'xauusd_risk_pct',
  records: 'xauusd_learning_records',
  style: 'xauusd_trading_style',
  account: 'xauusd_account_type',
  broker: 'xauusd_selected_broker',
  migratedFor: 'xauusd_migrated_to_uid',
  /** Starting parameters adopted from a backtest, if the user accepted one. */
  backtestPrior: 'xauusd_backtest_prior',
  /** Lowest conviction the user is willing to trade. */
  minConviction: 'xauusd_min_conviction',
} as const;

export interface LocalProfile {
  equity: number | null;
  initialEquity: number | null;
  isEquityLocked: boolean | null;
  riskPercentage: number | null;
  tradingStyle: TradingStyle | null;
  accountType: AccountType | null;
  selectedBroker: BrokerId | null;
  learningRecords: SelfLearningMemoryRecord[];
  /** Parameters adopted from a backtest, already sanitised. Null when none. */
  backtestPrior: PriorWeights | null;
  /** Conviction floor, or null when the user has not set one. */
  minConviction: number | null;
}

const TRADING_STYLES: TradingStyle[] = ['Scalping', 'Intraday', 'Swing'];
const ACCOUNT_TYPES: AccountType[] = ['Standard', 'Cent', 'Pro'];

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readNumber(key: string): number | null {
  const raw = readRaw(key);
  if (raw === null) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** Reads the guest profile. Missing or corrupt values come back as null. */
export function readLocalProfile(): LocalProfile {
  let learningRecords: SelfLearningMemoryRecord[] = [];
  const rawRecords = readRaw(LOCAL_KEYS.records);
  if (rawRecords) {
    try {
      const parsed = JSON.parse(rawRecords);
      if (Array.isArray(parsed)) {
        // Only keep entries with the fields the rest of the app relies on.
        learningRecords = chronological(
          parsed.filter(
            (r) => r && typeof r === 'object' && typeof r.id === 'string' && typeof r.outcome === 'string'
          )
        );
      }
    } catch {
      learningRecords = [];
    }
  }

  const style = readRaw(LOCAL_KEYS.style) as TradingStyle | null;
  const account = readRaw(LOCAL_KEYS.account) as AccountType | null;
  const broker = readRaw(LOCAL_KEYS.broker) as BrokerId | null;
  const locked = readRaw(LOCAL_KEYS.isLocked);

  // A stored prior is run through the engine's own sanitiser rather than
  // trusted, so an edited or stale value degrades to the defaults instead of
  // distorting live analysis.
  let backtestPrior: PriorWeights | null = null;
  const rawPrior = readRaw(LOCAL_KEYS.backtestPrior);
  if (rawPrior) {
    try {
      const parsed = JSON.parse(rawPrior);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        backtestPrior = normalisePrior(parsed);
      }
    } catch {
      backtestPrior = null;
    }
  }

  return {
    equity: readNumber(LOCAL_KEYS.equity),
    initialEquity: readNumber(LOCAL_KEYS.initialEquity),
    isEquityLocked: locked === null ? null : locked === 'true',
    riskPercentage: readNumber(LOCAL_KEYS.riskPct),
    tradingStyle: style && TRADING_STYLES.includes(style) ? style : null,
    accountType: account && ACCOUNT_TYPES.includes(account) ? account : null,
    selectedBroker: broker,
    learningRecords,
    backtestPrior,
    minConviction: (() => {
      const value = readNumber(LOCAL_KEYS.minConviction);
      return value !== null && value >= 0 && value <= 100 ? value : null;
    })(),
  };
}

/**
 * True when there is guest work worth carrying to the cloud: a locked balance,
 * or at least one recorded trade outcome.
 */
export function hasLocalDataWorthMigrating(profile: LocalProfile): boolean {
  return profile.learningRecords.length > 0 || profile.isEquityLocked === true;
}

/** Remembers that this account has already received the guest data. */
export function markMigrated(uid: string) {
  try {
    localStorage.setItem(LOCAL_KEYS.migratedFor, uid);
  } catch {
    // A browser that refuses to store this will simply re-check next time, and
    // the upload itself is idempotent, so nothing is duplicated.
  }
}

/** True when the guest data has already been copied into this account. */
export function alreadyMigrated(uid: string): boolean {
  return readRaw(LOCAL_KEYS.migratedFor) === uid;
}

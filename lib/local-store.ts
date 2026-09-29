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
  /** Multiple of risk at which a live setup says to move the stop to entry. */
  protectStopAtR: 'xauusd_protect_stop_at_r',
  /** A conviction band live analysis refuses outright. */
  skipConvictionBand: 'xauusd_skip_conviction_band',
  /** Daily loss limit in percent; zero when the user turned it off. */
  dailyLossLimit: 'xauusd_daily_loss_limit',
  /** A single target at 0.5R; see quick-target. */
  quickTarget: 'xauusd_quick_target',
  /** Dark or light, so the app opens looking the way it was left. */
  theme: 'xauusd_theme',
  /**
   * Which account the mirrored settings belong to.
   *
   * The mirror exists so signing out cannot fall back to something older. It
   * must never be carried *up* into a different account: on a shared browser
   * that would hand one person's balance to the next one who signs in.
   */
  mirrorOwner: 'xauusd_settings_owner',
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
  /**
   * Multiple of risk at which setups instruct moving the stop to entry, or null
   * when trades are held to the target or the stop as quoted.
   */
  protectStopAtR: number | null;
  /**
   * A conviction band refused outright, or null when every band is taken.
   */
  skipConvictionBand: { min: number; max: number } | null;
  /**
   * Daily loss limit in percent, zero when turned off, or null when the user
   * has never chosen and the default applies.
   */
  dailyLossLimit: number | null;
  /** Quick target on or off, or null when never chosen. */
  quickTarget: boolean | null;
  /** Dark or light, or null when the user has never chosen. */
  theme: 'dark' | 'light' | null;
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
    // A stop moved before half an R has been earned is not protection, and one
    // moved after three is not a rule anyone would follow, so anything outside
    // that reads as no preference at all.
    protectStopAtR: (() => {
      const value = readNumber(LOCAL_KEYS.protectStopAtR);
      return value !== null && value >= 0.5 && value <= 3 ? value : null;
    })(),
    dailyLossLimit: (() => {
      const value = readNumber(LOCAL_KEYS.dailyLossLimit);
      return value !== null && value >= 0 && value <= 50 ? value : null;
    })(),
    quickTarget: (() => {
      const raw = readRaw(LOCAL_KEYS.quickTarget);
      return raw === 'true' ? true : raw === 'false' ? false : null;
    })(),
    theme: (() => {
      const raw = readRaw(LOCAL_KEYS.theme);
      return raw === 'dark' || raw === 'light' ? raw : null;
    })(),
    // A stored band is checked rather than trusted: a corrupt value refuses
    // nothing, which is the behaviour the app had before the setting existed.
    skipConvictionBand: (() => {
      const raw = readRaw(LOCAL_KEYS.skipConvictionBand);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { min?: unknown; max?: unknown };
        const min = parsed?.min;
        const max = parsed?.max;
        if (typeof min !== 'number' || typeof max !== 'number') return null;
        if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
        if (min < 0 || max > 101 || max <= min) return null;
        return { min, max };
      } catch {
        return null;
      }
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

/**
 * Everything the app remembers about how a user has set it up.
 *
 * Written on every change, whether or not anyone is signed in. The old code
 * wrote to the browser *or* to the cloud, never both, so a signed-in user left
 * no local copy at all: sign out, and the screen fell back to whatever stale
 * numbers the browser still held, which looked exactly like the balance
 * resetting itself.
 */
export interface ProfileSettings {
  equity: number;
  initialEquity: number;
  isEquityLocked: boolean;
  riskPercentage: number;
  tradingStyle: TradingStyle;
  accountType: AccountType;
  selectedBroker: BrokerId;
  minConviction: number;
  protectStopAtR: number | null;
  skipConvictionBand: { min: number; max: number } | null;
  dailyLossLimit: number;
  quickTarget: boolean;
  backtestPrior: PriorWeights | null;
  theme: 'dark' | 'light';
}

/** Field names this app uses in the user's cloud document. */
export const CLOUD_FIELDS: Record<keyof ProfileSettings, string> = {
  equity: 'lockedEquity',
  initialEquity: 'initialEquity',
  isEquityLocked: 'isEquityLocked',
  riskPercentage: 'riskPercentage',
  tradingStyle: 'tradingStyle',
  accountType: 'accountType',
  selectedBroker: 'selectedBroker',
  minConviction: 'minConviction',
  protectStopAtR: 'protectStopAtR',
  skipConvictionBand: 'skipConvictionBand',
  dailyLossLimit: 'dailyLossLimit',
  quickTarget: 'quickTarget',
  backtestPrior: 'backtestPrior',
  theme: 'theme',
};

function writeRaw(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // A browser refusing storage loses the mirror, not the setting: the cloud
    // copy is written separately and is the one that survives a new device.
  }
}

/** Mirrors a settings change into this browser. Always safe to call. */
export function writeLocalSettings(patch: Partial<ProfileSettings>): void {
  if (patch.equity !== undefined) writeRaw(LOCAL_KEYS.equity, String(patch.equity));
  if (patch.initialEquity !== undefined) writeRaw(LOCAL_KEYS.initialEquity, String(patch.initialEquity));
  if (patch.isEquityLocked !== undefined) writeRaw(LOCAL_KEYS.isLocked, String(patch.isEquityLocked));
  if (patch.riskPercentage !== undefined) writeRaw(LOCAL_KEYS.riskPct, String(patch.riskPercentage));
  if (patch.tradingStyle !== undefined) writeRaw(LOCAL_KEYS.style, patch.tradingStyle);
  if (patch.accountType !== undefined) writeRaw(LOCAL_KEYS.account, patch.accountType);
  if (patch.selectedBroker !== undefined) writeRaw(LOCAL_KEYS.broker, patch.selectedBroker);
  if (patch.minConviction !== undefined) writeRaw(LOCAL_KEYS.minConviction, String(patch.minConviction));
  if (patch.protectStopAtR !== undefined) {
    writeRaw(LOCAL_KEYS.protectStopAtR, patch.protectStopAtR === null ? null : String(patch.protectStopAtR));
  }
  if (patch.skipConvictionBand !== undefined) {
    writeRaw(
      LOCAL_KEYS.skipConvictionBand,
      patch.skipConvictionBand === null ? null : JSON.stringify(patch.skipConvictionBand)
    );
  }
  if (patch.dailyLossLimit !== undefined) writeRaw(LOCAL_KEYS.dailyLossLimit, String(patch.dailyLossLimit));
  if (patch.quickTarget !== undefined) writeRaw(LOCAL_KEYS.quickTarget, String(patch.quickTarget));
  if (patch.backtestPrior !== undefined) {
    writeRaw(LOCAL_KEYS.backtestPrior, patch.backtestPrior === null ? null : JSON.stringify(patch.backtestPrior));
  }
  if (patch.theme !== undefined) writeRaw(LOCAL_KEYS.theme, patch.theme);
}

/** The same change, shaped for the cloud document. */
export function toCloudPatch(patch: Partial<ProfileSettings>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[CLOUD_FIELDS[key as keyof ProfileSettings]] = value;
  }
  return out;
}

/**
 * Settings this browser holds that the cloud document does not.
 *
 * A balance set before signing in, or set while a cloud write was failing,
 * exists only here. Carrying it up on sign-in is the difference between an
 * account that remembers and one that appears to reset itself.
 */
export function settingsMissingFromCloud(
  cloud: Record<string, unknown>,
  local: LocalProfile
): Partial<ProfileSettings> {
  const missing: Partial<ProfileSettings> = {};
  const absent = (field: string) => cloud[field] === undefined || cloud[field] === null;

  if (absent(CLOUD_FIELDS.equity) && local.equity !== null) missing.equity = local.equity;
  if (absent(CLOUD_FIELDS.initialEquity) && local.initialEquity !== null) {
    missing.initialEquity = local.initialEquity;
  }
  if (absent(CLOUD_FIELDS.isEquityLocked) && local.isEquityLocked !== null) {
    missing.isEquityLocked = local.isEquityLocked;
  }
  if (absent(CLOUD_FIELDS.riskPercentage) && local.riskPercentage !== null) {
    missing.riskPercentage = local.riskPercentage;
  }
  if (absent(CLOUD_FIELDS.tradingStyle) && local.tradingStyle !== null) {
    missing.tradingStyle = local.tradingStyle;
  }
  if (absent(CLOUD_FIELDS.accountType) && local.accountType !== null) {
    missing.accountType = local.accountType;
  }
  if (absent(CLOUD_FIELDS.selectedBroker) && local.selectedBroker !== null) {
    missing.selectedBroker = local.selectedBroker;
  }
  if (absent(CLOUD_FIELDS.minConviction) && local.minConviction !== null) {
    missing.minConviction = local.minConviction;
  }
  if (absent(CLOUD_FIELDS.protectStopAtR) && local.protectStopAtR !== null) {
    missing.protectStopAtR = local.protectStopAtR;
  }
  if (absent(CLOUD_FIELDS.skipConvictionBand) && local.skipConvictionBand !== null) {
    missing.skipConvictionBand = local.skipConvictionBand;
  }
  if (absent(CLOUD_FIELDS.dailyLossLimit) && local.dailyLossLimit !== null) {
    missing.dailyLossLimit = local.dailyLossLimit;
  }
  if (absent(CLOUD_FIELDS.quickTarget) && local.quickTarget !== null) missing.quickTarget = local.quickTarget;
  if (absent(CLOUD_FIELDS.backtestPrior) && local.backtestPrior !== null) {
    missing.backtestPrior = local.backtestPrior;
  }
  if (absent(CLOUD_FIELDS.theme) && local.theme !== null) missing.theme = local.theme;

  return missing;
}

/** Records which account the mirrored settings came from. */
export function markMirrorOwner(uid: string): void {
  writeRaw(LOCAL_KEYS.mirrorOwner, uid);
}

/**
 * Whether this browser's settings may be carried up into `uid`.
 *
 * True when the mirror is unowned, which is guest work, or when it already
 * belongs to this account. False on a browser where somebody else signed in.
 */
export function mirrorBelongsTo(uid: string): boolean {
  const owner = readRaw(LOCAL_KEYS.mirrorOwner);
  return owner === null || owner === uid;
}

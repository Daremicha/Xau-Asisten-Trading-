/**
 * The server looking for a new setup on the user's behalf, so a closed app
 * still hears about one.
 *
 * The app sends the settings an analysis needs whenever it syncs with the
 * server. The scheduled check then runs the same analysis the Run button runs,
 * every fifteen minutes while the market is open and no trade is in play, and
 * pushes the setup when one passes every rule. The setup is kept for a short
 * while, so opening the app loads the very order that was announced rather
 * than asking again at a different price.
 */

import { validateAnalyzeBody, type ValidatedAnalyzeRequest } from './request-validation';
import type { AccountType, BrokerId, InstitutionalTradingSetup, TradingStyle } from './types';

/** What the scan needs to analyse as the user would. Nothing identifies them. */
export interface ScanSettings {
  equity: number;
  riskPercentage: number;
  tradingStyle: TradingStyle;
  accountType: AccountType;
  brokerId: BrokerId;
  minConviction: number;
  dailyLossLimitPercent: number;
  protectAtR: number | null;
  /** A single target at 0.5R, when the user turned it on. */
  quickTarget: boolean;
  /** Trades closed in the last two days, for the daily loss limit. */
  recentResults: Array<{ closedAt: number; net: number }>;
  priorWeights?: unknown;
}

/** Minutes between scans. A setup is read from fifteen minute candles. */
export const SCAN_EVERY_SECONDS = 14 * 60;
/** How long an announced setup waits to be loaded by the app. */
export const OFFER_TTL_MS = 45 * 60_000;
/** The same order is not announced twice within this long. */
export const REPEAT_AFTER_MS = 4 * 3_600_000;

const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;

/** Checks what the app sent. Anything malformed means no scan, never a guess. */
export function sanitiseScanSettings(value: unknown): ScanSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Record<string, unknown>;
  const equity = num(s.equity, 0.01, 10_000_000);
  const riskPercentage = num(s.riskPercentage, 0.1, 10);
  const minConviction = num(s.minConviction, 0, 100);
  const dailyLossLimitPercent = num(s.dailyLossLimitPercent, 0, 50);
  if (equity === null || riskPercentage === null || minConviction === null || dailyLossLimitPercent === null) {
    return null;
  }
  // The analysis validator owns the list of styles, accounts and brokers.
  const probe = validateAnalyzeBody({
    equity,
    riskPercentage,
    tradingStyle: s.tradingStyle,
    accountType: s.accountType,
    brokerId: s.brokerId,
  });
  if (!probe.value) return null;
  const recent = Array.isArray(s.recentResults) ? s.recentResults.slice(-50) : [];
  return {
    equity,
    riskPercentage,
    tradingStyle: probe.value.tradingStyle,
    accountType: probe.value.accountType,
    brokerId: probe.value.brokerId,
    minConviction,
    dailyLossLimitPercent,
    protectAtR: num(s.protectAtR, 0.5, 3),
    quickTarget: s.quickTarget === true,
    recentResults: recent
      .map((r) => r as { closedAt?: unknown; net?: unknown })
      .filter((r) => num(r.closedAt, 0, 1e14) !== null && num(r.net, -1e7, 1e7) !== null)
      .map((r) => ({ closedAt: r.closedAt as number, net: r.net as number })),
    ...(typeof s.priorWeights === 'object' && s.priorWeights !== null ? { priorWeights: s.priorWeights } : {}),
  };
}

/** The analysis request the scan makes, the same shape the app posts. */
export function scanRequest(scan: ScanSettings): ValidatedAnalyzeRequest | null {
  return validateAnalyzeBody({
    equity: scan.equity,
    riskPercentage: scan.riskPercentage,
    tradingStyle: scan.tradingStyle,
    accountType: scan.accountType,
    brokerId: scan.brokerId,
    minConviction: scan.minConviction,
    dailyLossLimitPercent: scan.dailyLossLimitPercent,
    quickTarget: scan.quickTarget,
    priorWeights: scan.priorWeights,
    // Only what the daily loss limit reads: when each trade closed and what it made.
    pastLearningRecords: scan.recentResults.map((r, i) => ({
      id: `scan-${i}`,
      analysisId: `scan-${i}`,
      timestamp: new Date(r.closedAt).toISOString(),
      outcome: r.net > 0 ? 'TP' : 'SL',
      symbol: 'XAUUSD',
      orderType: 'BUY LIMIT',
      entryPrice: 0,
      exitPrice: 0,
      profitOrLossPips: 0,
      profitOrLossDollars: r.net,
      rootCauseAnalysis: { primaryFactor: '', institutionalFlowExplanation: '', liquidityBehavior: '' },
      strategyEvolutionLesson: '',
    })),
  }).value;
}

/** Identifies an order for the no-repeat rule: same side and type, entry within a dollar. */
export function offerKey(setup: Pick<InstitutionalTradingSetup, 'orderType' | 'entryPrice'>): string {
  return `${setup.orderType}|${Math.round(setup.entryPrice)}`;
}

/** True when this order was already announced recently. */
export function isRepeat(key: string, last: { key: string; at: string } | null | undefined, now: number): boolean {
  return Boolean(last && last.key === key && now - Date.parse(last.at) < REPEAT_AFTER_MS);
}

/** What the last scan did for a phone, shown in the app so a quiet scan can be told from a broken one. */
export interface ScanResult {
  at: string;
  outcome: 'announced' | 'no-setup' | 'held' | 'error';
  /** One short line, e.g. "best setup scored 25/100, needs 55". */
  note: string;
}

/** Words for an analysis that offered nothing. */
export function noSetupNote(body: Record<string, unknown>): string {
  const skipped = body.skipped as
    | { reason?: string; convictionScore?: number; threshold?: number; declinedBy?: string }
    | undefined;
  if (!skipped) return 'no setup found';
  switch (skipped.reason) {
    case 'daily-limit':
      return 'daily loss limit reached, scanning resumes with the next trading day';
    case 'feed-mismatch':
      return 'price feed unavailable for XAUUSD';
    case 'unfillable':
      return 'price had already run past the level';
    case 'dead-band':
      return `setup scored ${skipped.convictionScore}/100, a band the backtest showed loses`;
    default:
      return `best setup scored ${skipped.convictionScore}/100, needs ${skipped.threshold}${
        skipped.declinedBy === 'session' ? ' in the Asian session' : ''
      }`;
  }
}

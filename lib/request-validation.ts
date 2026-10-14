/**
 * Request validation for the API routes. Kept out of the route files so it can
 * be unit tested, and so malformed input produces a 400 with a clear message
 * instead of a 500 that leaks an internal stack message.
 */

import {
  AccountType,
  BrokerId,
  BROKER_PROFILES,
  InstitutionalTradingSetup,
  SelfLearningMemoryRecord,
  TradingStyle,
} from './types';
import { normalisePrior, type PriorWeights } from './learning-engine';

const TRADING_STYLES: TradingStyle[] = ['Scalping', 'Intraday', 'Swing'];
const ACCOUNT_TYPES: AccountType[] = ['Standard', 'Cent', 'Pro'];
const OUTCOMES = ['TP', 'SL', 'MISSED'] as const;
/**
 * Upper bound on history accepted in one request. The learning engine halves a
 * trade's weight every twenty positions back, so nothing beyond this changes
 * the result, and refusing more keeps a malformed or hostile request from
 * turning into unbounded server work.
 */
export const MAX_LEARNING_RECORDS = 500;
export type TradeOutcome = (typeof OUTCOMES)[number];

export interface ValidatedAnalyzeRequest {
  equity: number;
  riskPercentage: number;
  tradingStyle: TradingStyle;
  accountType: AccountType;
  brokerId: BrokerId;
  userId: string;
  pastLearningRecords: SelfLearningMemoryRecord[];
  /**
   * Lowest conviction the user is willing to trade, zero to one hundred. Zero
   * accepts every setup, which is how the engine behaved before the filter.
   */
  minConviction: number;
  /**
   * A conviction band the user refuses outright, because a backtest showed it
   * losing money in both halves of the period. Null when no band is refused.
   */
  skipConvictionBand: { min: number; max: number } | null;
  /** Daily loss limit in percent, or null when off. */
  dailyLossLimitPercent: number | null;
  /** A single target at 0.5R, when the user turned it on; see quick-target. */
  quickTarget: boolean;
  /** True when the user's self-learning switch is on: live trades re-tune the weights. */
  selfLearning: boolean;
  /**
   * Refuse a setup the broker's minimum lot cannot size within the risk
   * percentage. On unless the user turned it off, so a client that predates
   * the switch gets the safe answer.
   */
  riskGuard: boolean;
  /**
   * Starting parameters a backtest produced, which the live engine shrinks
   * toward instead of its own defaults. Null when the user has not adopted one.
   */
  priorWeights: PriorWeights | null;
}

export interface ValidationResult<T> {
  value: T | null;
  errors: string[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Validates an analysis request, filling sane defaults for optional fields. */
export function validateAnalyzeBody(body: unknown): ValidationResult<ValidatedAnalyzeRequest> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { value: null, errors: ['Isi permintaan harus objek JSON.'] };
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const equity = isFiniteNumber(b.equity) ? b.equity : 1000;
  if (equity <= 0) errors.push('equity harus lebih dari nol.');

  const minConviction = isFiniteNumber(b.minConviction) ? b.minConviction : 0;
  if (minConviction < 0 || minConviction > 100) {
    errors.push('minConviction harus antara 0 dan 100.');
  }

  // A band is taken only when both ends are sane and it is a band rather than
  // a floor in disguise, so a malformed value simply refuses nothing.
  let skipConvictionBand: { min: number; max: number } | null = null;
  const rawBand = b.skipConvictionBand as { min?: unknown; max?: unknown } | null | undefined;
  if (rawBand && isFiniteNumber(rawBand.min) && isFiniteNumber(rawBand.max)) {
    const min = rawBand.min;
    const max = rawBand.max;
    if (min >= 0 && max <= 101 && max > min) skipConvictionBand = { min, max };
  }

  const riskPercentage = isFiniteNumber(b.riskPercentage) ? b.riskPercentage : 1.0;
  if (riskPercentage <= 0 || riskPercentage > 100) {
    errors.push('riskPercentage harus lebih dari 0 dan maksimal 100.');
  }

  if (b.tradingStyle !== undefined && !TRADING_STYLES.includes(b.tradingStyle as TradingStyle)) {
    errors.push(`tradingStyle harus salah satu dari ${TRADING_STYLES.join(', ')}.`);
  }
  if (b.accountType !== undefined && !ACCOUNT_TYPES.includes(b.accountType as AccountType)) {
    errors.push(`accountType harus salah satu dari ${ACCOUNT_TYPES.join(', ')}.`);
  }
  if (b.brokerId !== undefined && !(typeof b.brokerId === 'string' && b.brokerId in BROKER_PROFILES)) {
    errors.push(`brokerId harus salah satu dari ${Object.keys(BROKER_PROFILES).join(', ')}.`);
  }
  if (b.pastLearningRecords !== undefined && !Array.isArray(b.pastLearningRecords)) {
    errors.push('pastLearningRecords harus berupa array kalau dikirim.');
  } else if (Array.isArray(b.pastLearningRecords) && b.pastLearningRecords.length > MAX_LEARNING_RECORDS) {
    errors.push(
      `pastLearningRecords maksimal berisi ${MAX_LEARNING_RECORDS} data; kirim yang terbaru saja.`
    );
  }

  // A prior is sanitised rather than rejected: normalisePrior rescales the
  // weights and clamps the rest, so a corrupt stored value degrades to the
  // engine defaults instead of failing the analysis.
  const priorWeights =
    typeof b.priorWeights === 'object' && b.priorWeights !== null && !Array.isArray(b.priorWeights)
      ? normalisePrior(b.priorWeights as Partial<PriorWeights>)
      : null;

  // Absent means an older client that never offered the limit: off.
  let dailyLossLimitPercent: number | null = null;
  if (b.dailyLossLimitPercent !== undefined && b.dailyLossLimitPercent !== null) {
    if (!isFiniteNumber(b.dailyLossLimitPercent) || b.dailyLossLimitPercent < 0 || b.dailyLossLimitPercent > 50) {
      errors.push('dailyLossLimitPercent harus antara 0 dan 50.');
    } else if (b.dailyLossLimitPercent > 0) {
      dailyLossLimitPercent = b.dailyLossLimitPercent;
    }
  }

  if (errors.length > 0) return { value: null, errors };

  return {
    value: {
      equity,
      riskPercentage,
      tradingStyle: (b.tradingStyle as TradingStyle) ?? 'Intraday',
      accountType: (b.accountType as AccountType) ?? 'Standard',
      brokerId: (b.brokerId as BrokerId) ?? 'EXNESS',
      userId: typeof b.userId === 'string' && b.userId.length > 0 ? b.userId : 'guest',
      pastLearningRecords: (b.pastLearningRecords as SelfLearningMemoryRecord[]) ?? [],
      minConviction,
      skipConvictionBand,
      dailyLossLimitPercent,
      quickTarget: b.quickTarget === true,
      selfLearning: b.selfLearning === true,
      riskGuard: b.riskGuard !== false,
      priorWeights,
    },
    errors: [],
  };
}

export interface ValidatedLearnRequest {
  setup: InstitutionalTradingSetup;
  outcome: TradeOutcome;
  closedPrice: number;
  /** Why a pending order ended without filling, when the engine decided it. */
  missCause?: string;
  /** True when the engine closed the order rather than the user. */
  autoResolved: boolean;
}

/** Validates a post trade evaluation request, including the fields it reads. */
export function validateLearnBody(body: unknown): ValidationResult<ValidatedLearnRequest> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { value: null, errors: ['Isi permintaan harus objek JSON.'] };
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (!OUTCOMES.includes(b.outcome as TradeOutcome)) {
    errors.push(`outcome harus salah satu dari ${OUTCOMES.join(', ')}.`);
  }
  if (!isFiniteNumber(b.closedPrice) || (b.closedPrice as number) <= 0) {
    errors.push('closedPrice harus angka positif.');
  }

  const setup = b.setup;
  if (typeof setup !== 'object' || setup === null || Array.isArray(setup)) {
    errors.push('setup harus objek setup trading dari endpoint analisis.');
    return { value: null, errors };
  }

  // Only the fields the evaluation actually reads are required.
  const s = setup as Record<string, unknown>;
  for (const field of ['id', 'entryPrice', 'stopLoss', 'orderType', 'recommendedLotSize']) {
    if (s[field] === undefined) errors.push(`setup.${field} wajib diisi.`);
  }
  for (const field of ['entryPrice', 'stopLoss', 'recommendedLotSize']) {
    if (s[field] !== undefined && !isFiniteNumber(s[field])) {
      errors.push(`setup.${field} harus berupa angka.`);
    }
  }

  if (errors.length > 0) return { value: null, errors };

  return {
    value: {
      setup: setup as unknown as InstitutionalTradingSetup,
      outcome: b.outcome as TradeOutcome,
      closedPrice: b.closedPrice as number,
      missCause: typeof b.missCause === 'string' && b.missCause.length > 0 ? b.missCause : undefined,
      autoResolved: b.autoResolved === true,
    },
    errors: [],
  };
}

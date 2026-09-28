/**
 * Each setup is reviewed once, however many times it is asked about.
 *
 * The app asks when a setup appears on the card, the scan asks before it
 * announces one, and a phone that reloads asks again. Every one of those gets
 * the same stored answer, so the models are paid for about three setups a day
 * rather than for every page load. An hourly ceiling keeps a stranger posting
 * made-up setups from running up the bill.
 */

import { reviewSetup } from './ai-review';
import type { AiReview, InstitutionalTradingSetup, OrderExecutionType, TradingStyle } from './types';
import { redis, redisConfigured } from './upstash';

/** A review is kept for as long as a setup can still be in play. */
const REVIEW_TTL_SECONDS = 60 * 60 * 24 * 3;
/** How long one caller may take to get the answer before another may try. */
const LOCK_SECONDS = 60;
/** Reviews allowed in one hour, for all callers together. */
export const REVIEWS_PER_HOUR = 20;

const ORDER_TYPES: OrderExecutionType[] = [
  'BUY INSTANT',
  'SELL INSTANT',
  'BUY LIMIT',
  'SELL LIMIT',
  'BUY STOP',
  'SELL STOP',
  'BUY STOP LIMIT',
  'SELL STOP LIMIT',
];
const STYLES: TradingStyle[] = ['Scalping', 'Intraday', 'Swing'];

const price = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1_000_000;

/**
 * Only the fields the models read, checked. A setup that is not plainly one
 * the engine could have produced is not sent anywhere.
 */
export function sanitiseReviewSetup(value: unknown): InstitutionalTradingSetup | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== 'string' || !/^[\w:.-]{1,100}$/.test(s.id)) return null;
  if (!ORDER_TYPES.includes(s.orderType as OrderExecutionType)) return null;
  for (const field of ['entryPrice', 'stopLoss', 'takeProfit1', 'takeProfit2', 'takeProfit3']) {
    if (!price(s[field])) return null;
  }
  return {
    id: s.id,
    orderType: s.orderType,
    entryPrice: s.entryPrice,
    stopLoss: s.stopLoss,
    takeProfit1: s.takeProfit1,
    takeProfit2: s.takeProfit2,
    takeProfit3: s.takeProfit3,
    convictionScore:
      typeof s.convictionScore === 'number' && Number.isFinite(s.convictionScore)
        ? Math.max(0, Math.min(100, s.convictionScore))
        : undefined,
    tradingStyle: STYLES.includes(s.tradingStyle as TradingStyle) ? s.tradingStyle : undefined,
    institutionalRationale: typeof s.institutionalRationale === 'string' ? s.institutionalRationale.slice(0, 2500) : '',
  } as unknown as InstitutionalTradingSetup;
}

export type CachedReview =
  | { status: 'done'; review: AiReview | null }
  /** Another caller is getting it; ask again shortly. */
  | { status: 'pending' }
  /** The hourly ceiling was reached. */
  | { status: 'busy' };

const key = (id: string) => `ai-review:${id}`;

export async function storedReview(id: string): Promise<AiReview | null | undefined> {
  if (!redisConfigured()) return undefined;
  const raw = await redis<string | null>('GET', key(id));
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as AiReview | null;
  } catch {
    return undefined;
  }
}

/**
 * The review of this setup, asking the models only when nobody has yet.
 * Without storage the models are asked every time, which only happens on a
 * development machine.
 */
export async function reviewOnce(setup: InstitutionalTradingSetup, marketPrice: number | null): Promise<CachedReview> {
  if (!redisConfigured()) return { status: 'done', review: await reviewSetup(setup, marketPrice) };

  const known = await storedReview(setup.id);
  if (known !== undefined) return { status: 'done', review: known };

  const claimed = (await redis<string | null>('SET', `${key(setup.id)}:lock`, Date.now(), 'NX', 'EX', LOCK_SECONDS)) === 'OK';
  if (!claimed) return { status: 'pending' };

  const hour = `ai-review:count:${Math.floor(Date.now() / 3_600_000)}`;
  const used = await redis<number>('INCR', hour);
  if (used === 1) await redis('EXPIRE', hour, 3_600);
  if (used > REVIEWS_PER_HOUR) {
    await redis('DEL', `${key(setup.id)}:lock`);
    return { status: 'busy' };
  }

  const review = await reviewSetup(setup, marketPrice);
  await redis('SET', key(setup.id), JSON.stringify(review), 'EX', REVIEW_TTL_SECONDS);
  return { status: 'done', review };
}

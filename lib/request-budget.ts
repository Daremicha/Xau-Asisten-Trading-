/**
 * How many provider calls are left today, and which ones deserve them.
 *
 * The free Twelve Data plan allows 800 requests a day. The app was asking for a
 * thousand-candle series *and* a tick on every refresh, every twenty seconds:
 * six hundred requests an hour, the whole day's allowance gone before lunch.
 * After that the feed fell to the backup provider, and the backup was quoting
 * the futures contract — which is how a trade that reached its target came to
 * be recorded as a missed entry.
 *
 * Spending less by refreshing less makes the screen worse all day to fix a
 * problem that only appears at the end of it. So the budget is a bucket
 * instead: it refills steadily at the rate the plan allows, and holds a reserve
 * that can be spent quickly when it matters. Watching a live order draws on the
 * reserve and the panel stays current; an idle tab waits for the drip and costs
 * almost nothing.
 *
 * Honest arithmetic, since it decides what the screen can promise: 800 requests
 * a day is one every hundred and eight seconds sustained. There is no schedule
 * that makes it a ten second tick around the clock. What there is, is a choice
 * about when to spend it.
 */

import { twelveDataKeys } from './twelve-data-keys';

const DAY_MS = 86_400_000;

/**
 * Requests a day the bucket plans around.
 *
 * Below the plan's real 800 on purpose: the count lives in module state, so
 * each warm serverless instance paces its own share and cannot see the others.
 * A limit reached is a feed that falls back to another instrument, which costs
 * far more than a few unspent requests.
 */
const DEFAULT_DAILY_LIMIT = 700;

/**
 * Requests that may be held in reserve.
 *
 * This is what makes the plan usable at all. The allowance arrives as a drip,
 * one request every two minutes, whether or not anyone is watching; the reserve
 * is where the drip collects during the twenty hours a day nobody is. Four
 * hundred is about fourteen hours of saving, which buys a few hours of a live
 * order updating every ten to twenty seconds instead of every two minutes.
 *
 * It is also capped by the plan's other limit: eight requests a minute. A ten
 * second tick is six a minute, so the reserve can be spent as fast as it is
 * allowed to be and no faster.
 */
const BURST_CAPACITY = 400;

/**
 * Requests held back for the candle and daily series.
 *
 * Ninety six candle downloads and twenty four daily ones is the most a day can
 * need. Reserving them means a morning spent watching a live order cannot leave
 * the afternoon without an analysis to run.
 */
const ESSENTIAL_RESERVE = 120;

let tokens = BURST_CAPACITY;
let lastRefill = 0;
let spentToday = 0;
let dayStartedAt = 0;

/** Resets the bucket. Exposed for tests. */
export function __resetBudget(now: number = Date.now()): void {
  tokens = BURST_CAPACITY;
  lastRefill = now;
  spentToday = 0;
  dayStartedAt = Math.floor(now / DAY_MS) * DAY_MS;
}

/**
 * Requests a day across every configured key. TWELVE_DATA_DAILY_LIMIT, when
 * set, is the allowance of one key; each extra key adds the same again.
 */
export function dailyLimit(): number {
  const raw = Number(process.env.TWELVE_DATA_DAILY_LIMIT);
  const perKey = !Number.isFinite(raw) || raw < 20 ? DEFAULT_DAILY_LIMIT : Math.floor(raw);
  return perKey * Math.max(1, twelveDataKeys().length);
}

/** Seconds between refills: the sustained rate the plan allows. */
export function sustainedIntervalSeconds(): number {
  return Math.max(1, Math.round(86_400 / dailyLimit()));
}

function refill(now: number): void {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  if (today !== dayStartedAt) {
    // The plan resets at midnight UTC, and so does the count.
    dayStartedAt = today;
    spentToday = 0;
    tokens = BURST_CAPACITY;
    lastRefill = now;
    return;
  }

  if (lastRefill === 0) {
    lastRefill = now;
    return;
  }

  const perMs = dailyLimit() / DAY_MS;
  const earned = (now - lastRefill) * perMs;
  if (earned <= 0) return;
  tokens = Math.min(BURST_CAPACITY, tokens + earned);
  lastRefill = now;
}

export interface BudgetState {
  /** Provider calls made since midnight UTC, as this instance saw them. */
  spent: number;
  limit: number;
  /** Whole requests available to spend right now. */
  available: number;
  /** Seconds between refills at the plan's sustained rate. */
  sustainedIntervalSeconds: number;
  /** True when a tick now has to wait for the drip rather than the reserve. */
  paced: boolean;
}

export function budgetState(now: number = Date.now()): BudgetState {
  refill(now);
  return {
    spent: spentToday,
    limit: dailyLimit(),
    available: Math.floor(tokens),
    sustainedIntervalSeconds: sustainedIntervalSeconds(),
    paced: tokens < 1 || spentToday >= dailyLimit() - ESSENTIAL_RESERVE,
  };
}

/**
 * Takes a request from the bucket, or refuses it.
 *
 * `essential` spends even when the bucket is empty: the candle series and the
 * daily series are a hundred and twenty calls a day between them, and without
 * them there is no analysis at all. The tick is not essential in that sense —
 * a slightly older price is still a price.
 */
export function takeRequest(essential = false, now: number = Date.now()): boolean {
  refill(now);
  const limit = dailyLimit();

  // The hard stop, which nothing crosses: this is what keeps the day inside the
  // plan whatever the pattern of use.
  if (spentToday >= limit) return false;

  if (essential) {
    // Structure and the daily read come before a fresher tick. They spend a
    // token when one is there and go ahead from the reserve when it is not.
    if (tokens >= 1) tokens -= 1;
    spentToday += 1;
    return true;
  }

  // Everything else stops short of the reserve, and waits for the drip once the
  // burst is spent.
  if (spentToday >= limit - ESSENTIAL_RESERVE) return false;
  if (tokens < 1) return false;
  tokens -= 1;
  spentToday += 1;
  return true;
}

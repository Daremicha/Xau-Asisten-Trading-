/**
 * Several Twelve Data keys, used one after another.
 *
 * The free plan allows 800 requests a day and 8 a minute per key. With more
 * than one key configured, a request that comes back out of credits is retried
 * at once on the next key, and the spent key is left alone until its allowance
 * returns: a minute for the per-minute limit, midnight UTC for the daily one.
 * When the last key runs out the cycle starts again from the first one that
 * has recovered.
 *
 * Keys are read from TWELVE_DATA_API_KEY, TWELVE_DATA_API_KEY_2 and
 * TWELVE_DATA_API_KEY_3, or from a comma separated TWELVE_DATA_API_KEYS.
 */

const DAY_MS = 86_400_000;
const MINUTE_BLOCK_MS = 65_000;
const INVALID_BLOCK_MS = 60 * 60_000;

/** Environment variables that may hold a key, in the order they are tried. */
export const TWELVE_DATA_KEY_VARS = [
  'TWELVE_DATA_API_KEY',
  'TWELVE_DATA_API_KEY_2',
  'TWELVE_DATA_API_KEY_3',
  'TWELVE_DATA_API_KEYS',
] as const;

export function twelveDataKeys(): string[] {
  const keys: string[] = [];
  for (const name of TWELVE_DATA_KEY_VARS) {
    for (const part of (process.env[name] ?? '').split(',')) {
      const key = part.trim();
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

export function twelveDataConfigured(): boolean {
  return twelveDataKeys().length > 0;
}

export function twelveDataBase(): string {
  return (process.env.TWELVE_DATA_BASE_URL || 'https://api.twelvedata.com').replace(/\/$/, '');
}

/** Why a key cannot be used right now, from what the provider answered. */
export function keyProblem(status: number, payload: unknown): 'minute' | 'day' | 'invalid' | null {
  const code = (payload as { code?: number } | null)?.code;
  const message = String((payload as { message?: string } | null)?.message ?? '');
  if (status === 401 || status === 403 || code === 401 || code === 403 || /api ?key.*(incorrect|invalid)/i.test(message)) {
    return 'invalid';
  }
  if (status === 429 || code === 429 || /api credits|rate limit|too many requests/i.test(message)) {
    return /for the day|daily/i.test(message) ? 'day' : 'minute';
  }
  return null;
}

const blockedUntil = new Map<string, number>();
let current = 0;

/** Clears what this instance has learned about the keys. Exposed for tests. */
export function __resetKeyRotation(): void {
  blockedUntil.clear();
  current = 0;
}

function blockKey(key: string, problem: 'minute' | 'day' | 'invalid', now: number): void {
  const until =
    problem === 'minute'
      ? now + MINUTE_BLOCK_MS
      : problem === 'day'
        ? Math.floor(now / DAY_MS) * DAY_MS + DAY_MS
        : now + INVALID_BLOCK_MS;
  blockedUntil.set(key, until);
}

export interface TwelveDataReply {
  ok: boolean;
  status: number;
  payload: unknown;
  /** True when every key is out of credits, so the caller should wait. */
  allKeysSpent: boolean;
}

/**
 * Makes one request, moving to the next key whenever the current one is out
 * of credits. Returns null when no key is configured.
 *
 * `buildUrl` receives the key so that each attempt carries its own; `fetcher`
 * is the caller's fetch with its own timeout and caching.
 */
export async function requestTwelveData(
  buildUrl: (key: string) => string,
  fetcher: (url: string) => Promise<Response>,
  now: number = Date.now()
): Promise<TwelveDataReply | null> {
  const keys = twelveDataKeys();
  if (keys.length === 0) return null;
  if (current >= keys.length) current = 0;

  let last: TwelveDataReply | null = null;
  for (let step = 0; step < keys.length; step++) {
    const index = (current + step) % keys.length;
    const key = keys[index];
    if ((blockedUntil.get(key) ?? 0) > now) continue;

    const res = await fetcher(buildUrl(key));
    const payload = await res.json().catch(() => null);
    const problem = keyProblem(res.status, payload);
    last = { ok: res.ok && !problem, status: res.status, payload, allKeysSpent: false };
    if (problem) {
      blockKey(key, problem, now);
      continue;
    }
    current = index;
    return last;
  }

  // Every key is spent or blocked. Report the last answer, or a plain rate
  // limit when no key could even be tried, so the caller backs off.
  return last
    ? { ...last, ok: false, allKeysSpent: true }
    : { ok: false, status: 429, payload: { code: 429, message: 'All Twelve Data keys are out of credits.' }, allKeysSpent: true };
}

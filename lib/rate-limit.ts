import { redis, redisConfigured } from './upstash';

type MemoryBucket = { count: number; resetAt: number };
const memory = new Map<string, MemoryBucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
}

function clientKey(request: Request, scope: string): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const real = request.headers.get('x-real-ip')?.trim();
  return `${scope}:${forwarded || real || 'unknown'}`;
}

function memoryLimit(key: string, limit: number, windowSeconds: number, now: number): RateLimitResult {
  const existing = memory.get(key);
  const resetAt = existing && existing.resetAt > now ? existing.resetAt : now + windowSeconds * 1000;
  const count = existing && existing.resetAt > now ? existing.count + 1 : 1;
  memory.set(key, { count, resetAt });
  if (memory.size > 10_000) {
    for (const [entry, bucket] of memory) if (bucket.resetAt <= now) memory.delete(entry);
  }
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    limit,
  };
}

/** Fixed-window limiter. Redis is preferred in serverless production; memory is a safe local fallback. */
export async function rateLimit(
  request: Request,
  scope: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const key = clientKey(request, scope);
  const now = Date.now();
  if (!redisConfigured()) return memoryLimit(key, limit, windowSeconds, now);

  try {
    const redisKey = `rl:${key}`;
    const count = Number(await redis<number>('INCR', redisKey));
    if (count === 1) await redis('EXPIRE', redisKey, windowSeconds);
    const ttl = Number(await redis<number>('TTL', redisKey));
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: Math.max(1, ttl > 0 ? ttl : windowSeconds),
      limit,
    };
  } catch {
    return memoryLimit(key, limit, windowSeconds, now);
  }
}

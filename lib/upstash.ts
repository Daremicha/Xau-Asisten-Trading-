/**
 * Upstash Redis over its REST API, shared by everything the server stores.
 *
 * No client library and no connection to hold open in a serverless function.
 * Vercel's Upstash integration names the variables KV_REST_API_*; a database
 * created on Upstash directly uses UPSTASH_REDIS_REST_*. Either works.
 */

function credentials(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export function redisConfigured(): boolean {
  return credentials() !== null;
}

export async function redis<T = unknown>(...args: Array<string | number>): Promise<T> {
  const creds = credentials();
  if (!creds) throw new Error('Penyimpanan belum diatur.');
  const res = await fetch(creds.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => null)) as { result?: T; error?: string } | null;
  if (!res.ok || !data || data.error) {
    throw new Error(`Storage error: ${data?.error ?? `HTTP ${res.status}`}`);
  }
  return data.result as T;
}

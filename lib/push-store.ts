/**
 * Where the server keeps the phones it alerts and the setup each one watches.
 *
 * Upstash Redis over its REST API, so no client library and no connection to
 * hold open in a serverless function. Vercel's Upstash integration names the
 * variables KV_REST_API_*; a database created on Upstash directly uses
 * UPSTASH_REDIS_REST_*. Either works.
 */

import { createHash } from 'node:crypto';
import type { StoredSubscription, WatchedSetup } from './push-watch';

export interface PushRecord {
  subscription: StoredSubscription;
  setup: WatchedSetup | null;
  /** Message keys already delivered for the current setup. */
  sent: string[];
  /**
   * True once the setup has had its last message (closed or missed). It stays
   * stored so that the app re-sending the same unresolved setup does not start
   * the alerts over.
   */
  finished?: boolean;
  updatedAt: string;
}

const WATCH_SET = 'push:watching';
/** A phone that never syncs again is forgotten after this long. */
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 30;

function credentials(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export function storeConfigured(): boolean {
  return credentials() !== null;
}

async function command<T = unknown>(...args: Array<string | number>): Promise<T> {
  const creds = credentials();
  if (!creds) throw new Error('Push storage is not configured.');
  const res = await fetch(creds.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => null)) as { result?: T; error?: string } | null;
  if (!res.ok || !data || data.error) {
    throw new Error(`Push storage error: ${data?.error ?? `HTTP ${res.status}`}`);
  }
  return data.result as T;
}

/** The endpoint is a secret URL; its hash is the record's name. */
export function recordId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 40);
}

const key = (id: string) => `push:sub:${id}`;

export async function loadRecord(id: string): Promise<PushRecord | null> {
  const raw = await command<string | null>('GET', key(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PushRecord;
  } catch {
    return null;
  }
}

export async function saveRecord(id: string, record: PushRecord): Promise<void> {
  await command('SET', key(id), JSON.stringify(record), 'EX', RECORD_TTL_SECONDS);
  if (record.setup && !record.finished) await command('SADD', WATCH_SET, id);
  else await command('SREM', WATCH_SET, id);
}

export async function deleteRecord(id: string): Promise<void> {
  await command('DEL', key(id));
  await command('SREM', WATCH_SET, id);
}

export async function watchingIds(): Promise<string[]> {
  return (await command<string[]>('SMEMBERS', WATCH_SET)) ?? [];
}

/**
 * True for the one caller that may run a check now. Two schedulers firing in
 * the same minute would otherwise both spend a quote and both send alerts.
 */
export async function claimCheck(seconds: number): Promise<boolean> {
  const result = await command<string | null>('SET', 'push:check-lock', Date.now(), 'NX', 'EX', seconds);
  return result === 'OK';
}

/**
 * Where the server keeps the phones it alerts and the setup each one watches.
 *
 * Upstash Redis, through the shared client in upstash.ts.
 */

import { createHash } from 'node:crypto';
import type { StoredSubscription, WatchedSetup } from './push-watch';
import { redis, redisConfigured } from './upstash';

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

export function storeConfigured(): boolean {
  return redisConfigured();
}

const command = redis;

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

export interface CheckHeartbeat {
  /** When the scheduler last ran a check, ISO. */
  at: string;
  watching: number;
  sent: number;
}

const HEARTBEAT_KEY = 'push:last-check';

/** Notes that a scheduled check ran, so the app can tell whether anyone is watching. */
export async function recordCheck(beat: CheckHeartbeat): Promise<void> {
  await command('SET', HEARTBEAT_KEY, JSON.stringify(beat), 'EX', 60 * 60 * 24 * 7);
}

export async function lastCheck(): Promise<CheckHeartbeat | null> {
  const raw = await command<string | null>('GET', HEARTBEAT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CheckHeartbeat;
  } catch {
    return null;
  }
}

/** True for the first test request from a phone in a minute; later ones are refused. */
export async function claimTest(id: string): Promise<boolean> {
  return (await command<string | null>('SET', `push:test:${id}`, Date.now(), 'NX', 'EX', 60)) === 'OK';
}

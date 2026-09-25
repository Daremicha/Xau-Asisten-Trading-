/**
 * What a phone should be told about a setup it is watching, when the app is
 * closed and a server is doing the watching instead.
 *
 * The verdict comes from `replayOrder`, the same rules the open app applies,
 * so a push never says something the screen would contradict. This module only
 * turns that verdict and the latest price into messages, each sent once.
 */

import type { ReplayVerdict } from './order-replay';
import type { InstitutionalTradingSetup, SignalStatus } from './types';
import { closedAlert, filledAlert, missedAlert, nearLevelAlert } from './trade-alerts';

/** Price within this many dollars of a level counts as near it: ten pips. */
export const NEAR_LEVEL_DOLLARS = 1;

/** The parts of a setup the server keeps. Nothing about the account or the user. */
export interface WatchedSetup {
  id: string;
  orderType: InstitutionalTradingSetup['orderType'];
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  timestamp: string;
  validUntil?: string;
  filledAt?: string;
  status: SignalStatus;
}

export interface PushMessage {
  /** Stable per setup and event, so an event is sent once and never repeated. */
  key: string;
  title: string;
  body: string;
  /**
   * The notification tag. Proximity alerts share the tag the open app uses for
   * the same level, so a phone that gets both shows one notification.
   */
  tag: string;
  /** True once the setup needs no more watching. */
  final: boolean;
}

const WATCHED_STATUSES: SignalStatus[] = ['PENDING', 'ACTIVE'];

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/**
 * Keeps only what the server needs, and refuses anything that is not a setup.
 * Returns null for a setup that is finished, which means "stop watching".
 */
export function sanitiseWatchedSetup(value: unknown): WatchedSetup | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== 'string' || s.id.length === 0 || s.id.length > 120) return null;
  if (typeof s.orderType !== 'string' || !/^(BUY|SELL) (LIMIT|STOP|INSTANT)/.test(s.orderType)) return null;
  if (typeof s.status !== 'string' || !WATCHED_STATUSES.includes(s.status as SignalStatus)) return null;
  const levels = [s.entryPrice, s.stopLoss, s.takeProfit1, s.takeProfit2, s.takeProfit3];
  if (!levels.every(isNum)) return null;
  if (!isDate(s.timestamp)) return null;

  return {
    id: s.id,
    orderType: s.orderType as WatchedSetup['orderType'],
    entryPrice: s.entryPrice as number,
    stopLoss: s.stopLoss as number,
    takeProfit1: s.takeProfit1 as number,
    takeProfit2: s.takeProfit2 as number,
    takeProfit3: s.takeProfit3 as number,
    timestamp: s.timestamp,
    validUntil: isDate(s.validUntil) ? s.validUntil : undefined,
    filledAt: isDate(s.filledAt) ? s.filledAt : undefined,
    status: s.status as SignalStatus,
  };
}

/** Messages the verdict and price call for, minus the ones already sent. */
export function messagesFor(
  setup: WatchedSetup,
  verdict: ReplayVerdict,
  price: number | null,
  alreadySent: ReadonlySet<string>
): PushMessage[] {
  const out: PushMessage[] = [];
  const add = (message: PushMessage) => {
    if (!alreadySent.has(message.key)) out.push(message);
  };

  if (verdict.kind === 'missed') {
    add({ key: `${setup.id}:missed`, ...missedAlert(setup, verdict.reason), final: true });
    return out;
  }

  if (verdict.kind === 'closed') {
    add({
      key: `${setup.id}:closed`,
      ...closedAlert(setup, verdict.trigger, verdict.exitPrice, verdict.fillPrice),
      final: true,
    });
    return out;
  }

  if (verdict.kind !== 'running') return out;

  add({ key: `${setup.id}:filled`, ...filledAlert(setup, verdict.fillPrice), final: false });

  if (price === null) return out;
  const isLong = setup.orderType.startsWith('BUY');
  const toStop = isLong ? price - setup.stopLoss : setup.stopLoss - price;
  const toTarget = isLong ? setup.takeProfit1 - price : price - setup.takeProfit1;

  if (toStop > 0 && toStop <= NEAR_LEVEL_DOLLARS) {
    add({ key: `${setup.id}:near-SL`, ...nearLevelAlert(setup, 'SL', price), final: false });
  }
  if (toTarget > 0 && toTarget <= NEAR_LEVEL_DOLLARS) {
    add({ key: `${setup.id}:near-TP1`, ...nearLevelAlert(setup, 'TP1', price), final: false });
  }
  return out;
}

/** Push services browsers actually use. Anything else is refused, not fetched. */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
];

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** A browser push subscription, checked before the server ever sends to it. */
export function sanitiseSubscription(value: unknown): StoredSubscription | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof s.endpoint !== 'string' || s.endpoint.length > 1000) return null;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
  const p256dh = s.keys?.p256dh;
  const auth = s.keys?.auth;
  const b64url = /^[A-Za-z0-9_-]+=*$/;
  if (typeof p256dh !== 'string' || p256dh.length > 200 || !b64url.test(p256dh)) return null;
  if (typeof auth !== 'string' || auth.length > 100 || !b64url.test(auth)) return null;
  return { endpoint: s.endpoint, keys: { p256dh, auth } };
}

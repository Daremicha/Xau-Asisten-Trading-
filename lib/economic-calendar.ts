/**
 * Scheduled economic releases.
 *
 * The previous implementation invented its entire contents: CPI, FOMC and
 * Non-Farm Payrolls were placed at fixed offsets from the current clock with
 * hardcoded forecast and previous values, and presented as a Forex Factory
 * feed. Worse, the analysis route measured the time to the next "release" from
 * those invented timestamps and widened the stop loss accordingly, so fabricated
 * news moved real orders.
 *
 * This module returns nothing unless a real provider is configured. An empty
 * calendar is honest; an invented one is not.
 */

import { ForexFactoryEvent } from './types';

export interface CalendarResult {
  events: ForexFactoryEvent[];
  /** Provider name, or null when no calendar is configured. */
  source: string | null;
  configured: boolean;
  message: string;
}

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Feed used when none is configured.
 *
 * The weekly Forex Factory calendar, published as JSON and free to read. It is
 * a real schedule of real releases, which is the only thing this module will
 * serve: if it cannot be reached the calendar stays empty and says so, exactly
 * as it did when nothing was configured at all. Override it with
 * ECONOMIC_CALENDAR_URL to use a provider of your own.
 */
export const DEFAULT_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const CACHE_TTL_MS = 15 * 60_000;

let cached: { at: number; result: CalendarResult } | null = null;

/** Resets the module cache. Exposed for tests. */
export function __resetCalendarCache() {
  cached = null;
}

const IMPACT_WORDS: Record<string, ForexFactoryEvent['impact']> = {
  high: 'High',
  '3': 'High',
  medium: 'Medium',
  moderate: 'Medium',
  '2': 'Medium',
  low: 'Low',
  '1': 'Low',
};

function normaliseImpact(value: unknown): ForexFactoryEvent['impact'] {
  const key = String(value ?? '').trim().toLowerCase();
  return IMPACT_WORDS[key] ?? 'Low';
}

const CURRENCIES: ForexFactoryEvent['currency'][] = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY'];

/**
 * Country names some feeds use where Forex Factory puts a currency code.
 *
 * Only unambiguous ones. A name that is not here reads as unknown rather than
 * being forced into the nearest guess.
 */
const COUNTRY_TO_CURRENCY: Record<string, ForexFactoryEvent['currency']> = {
  'UNITED STATES': 'USD',
  'UNITED STATES OF AMERICA': 'USD',
  US: 'USD',
  USA: 'USD',
  'EURO AREA': 'EUR',
  EUROZONE: 'EUR',
  'EURO ZONE': 'EUR',
  'EUROPEAN UNION': 'EUR',
  EU: 'EUR',
  'UNITED KINGDOM': 'GBP',
  UK: 'GBP',
  BRITAIN: 'GBP',
  JAPAN: 'JPY',
  JP: 'JPY',
  AUSTRALIA: 'AUD',
  AU: 'AUD',
  CANADA: 'CAD',
  CA: 'CAD',
  SWITZERLAND: 'CHF',
  CH: 'CHF',
  CHINA: 'CNY',
  CN: 'CNY',
};

/**
 * The currency a release belongs to.
 *
 * Anything unrecognised is 'Unknown', never USD. Defaulting to USD was quietly
 * dangerous: the dollar-only calendar is what feeds the news shield, so a
 * Japanese release from a feed that writes country names would have widened
 * the stop on a gold trade as though it were a dollar release.
 */
function normaliseCurrency(value: unknown): ForexFactoryEvent['currency'] {
  const key = String(value ?? '').trim().toUpperCase();
  if ((CURRENCIES as string[]).includes(key)) return key as ForexFactoryEvent['currency'];
  return COUNTRY_TO_CURRENCY[key] ?? 'Unknown';
}

/** Parses the several timestamp shapes calendar providers use. */
export function parseEventTime(row: Record<string, unknown>): number | null {
  const candidates = [row.timestamp, row.datetime, row.date, row.time];
  for (const raw of candidates) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      // Seconds or milliseconds since the epoch.
      return raw > 1e12 ? raw : raw * 1000;
    }
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const text = raw.trim();
      const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text.replace(' ', 'T') : `${text.replace(' ', 'T')}Z`;
      const parsed = Date.parse(withZone);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function formatWib(ms: number, withTime: boolean): string {
  const d = new Date(ms);
  return withTime
    ? d.toLocaleTimeString('en-US', {
        timeZone: 'Asia/Jakarta',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }) + ' WIB'
    : d.toLocaleDateString('en-US', {
        timeZone: 'Asia/Jakarta',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
}

/**
 * Maps a provider payload into the app's event shape. Accepts either a bare
 * array or an object with an `events`, `data` or `result` array, which covers
 * the common calendar APIs. Rows without a usable time or title are dropped
 * rather than guessed at.
 */
export function mapCalendarPayload(payload: unknown): ForexFactoryEvent[] {
  const container = payload as Record<string, unknown> | unknown[] | null;
  const rows = Array.isArray(container)
    ? container
    : (container?.['events'] ?? container?.['data'] ?? container?.['result'] ?? null);
  if (!Array.isArray(rows)) return [];

  const events: ForexFactoryEvent[] = [];
  rows.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return;
    const row = raw as Record<string, unknown>;

    const title = String(row.title ?? row.event ?? row.name ?? '').trim();
    const time = parseEventTime(row);
    if (title.length === 0 || time === null) return;

    events.push({
      id: String(row.id ?? `cal-${index}-${time}`),
      title,
      country: String(row.country ?? row.zone ?? row.region ?? 'Unknown'),
      // Forex Factory puts the currency code in `country`; others use a name
      // there, which normaliseCurrency rejects in favour of the default.
      currency: normaliseCurrency(row.currency ?? row.country_code ?? row.country),
      impact: normaliseImpact(row.impact ?? row.importance ?? row.volatility),
      date: formatWib(time, false),
      time: formatWib(time, true),
      scheduledTimestamp: new Date(time).toISOString(),
      forecast: row.forecast === undefined || row.forecast === null ? '' : String(row.forecast),
      previous: row.previous === undefined || row.previous === null ? '' : String(row.previous),
      actual: row.actual === undefined || row.actual === null ? undefined : String(row.actual),
      marketImplication: String(row.marketImplication ?? row.comment ?? '').trim(),
    });
  });

  return events.sort(
    (a, b) => new Date(a.scheduledTimestamp).getTime() - new Date(b.scheduledTimestamp).getTime()
  );
}

const NOT_CONFIGURED: CalendarResult = {
  events: [],
  source: null,
  configured: false,
  message:
    'No economic calendar is connected. Set ECONOMIC_CALENDAR_URL to a feed that returns scheduled releases as JSON. Until then the engine ignores news entirely rather than inventing a schedule.',
};

/**
 * Returns the upcoming calendar. Without a configured provider it returns
 * nothing, so no part of the app can react to an event that does not exist.
 */
export async function getEconomicCalendar(): Promise<CalendarResult> {
  const configured = process.env.ECONOMIC_CALENDAR_URL?.trim();
  // An explicitly empty variable is a deliberate "no calendar", and is obeyed.
  if (process.env.ECONOMIC_CALENDAR_URL !== undefined && !configured) return NOT_CONFIGURED;
  const url = configured || DEFAULT_CALENDAR_URL;

  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.result;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'XAUUSD-Assistant/1.0' },
      next: { revalidate: Math.floor(CACHE_TTL_MS / 1000) },
    });
    if (!res.ok) throw new Error(`calendar provider HTTP ${res.status}`);

    const events = mapCalendarPayload(await res.json());
    const result: CalendarResult = {
      events,
      source: new URL(url).hostname,
      configured: true,
      message:
        events.length > 0
          ? `Calendar from ${new URL(url).hostname}.`
          : `Connected to ${new URL(url).hostname}, which returned no upcoming releases.`,
    };
    cached = { at: Date.now(), result };
    return result;
  } catch (err) {
    console.warn('Economic calendar provider failed:', err);
    // A provider that cannot be reached is reported, never substituted.
    return {
      events: [],
      source: null,
      configured: true,
      message: `The economic calendar at ${
        (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return 'the configured address';
          }
        })()
      } could not be reached, so news is being ignored for now.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps only releases still ahead of now, soonest first. */
export function filterUpcoming(events: ForexFactoryEvent[], now: number = Date.now()): ForexFactoryEvent[] {
  return events
    .filter((e) => {
      const t = new Date(e.scheduledTimestamp).getTime();
      return Number.isFinite(t) && t > now;
    })
    .sort((a, b) => new Date(a.scheduledTimestamp).getTime() - new Date(b.scheduledTimestamp).getTime());
}

/**
 * Keeps only the releases that move gold.
 *
 * XAUUSD is an ounce of gold priced in dollars, so the dollar half of the pair
 * is what a scheduled release moves. An ECB decision or a Japanese holiday can
 * matter at the margin, but they arrive by way of the dollar rather than
 * directly, and listing them buries the releases that do move the price. Only
 * the USD side is kept, both on screen and for the news shield, so the two
 * always agree about what the engine is reacting to.
 */
export function usdOnly(events: ForexFactoryEvent[]): ForexFactoryEvent[] {
  // Strictly USD. An event whose currency could not be read is left out rather
  // than assumed to be a dollar release.
  return events.filter((e) => e.currency === 'USD');
}

/** Minutes until the next high impact release, or null when none is known. */
export function minutesToNextHighImpact(
  events: ForexFactoryEvent[],
  now: number = Date.now()
): number | null {
  const next = filterUpcoming(events, now).find((e) => e.impact === 'High');
  if (!next) return null;
  return Math.max(0, (new Date(next.scheduledTimestamp).getTime() - now) / 60000);
}

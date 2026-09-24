/**
 * Keeps every dollar release the live calendar has shown, so a later backtest
 * can react to it.
 *
 * The live feed only covers the current week, and the hand-checked history in
 * historical-calendar only covers FOMC, NFP and CPI. Each time the live
 * calendar is fetched, its USD high and medium impact releases are written to
 * a Redis hash keyed by title and time, so a release seen twice is stored
 * once and a revised forecast simply overwrites the earlier copy. Replays run
 * after this week then know about PPI, retail sales, ISM and the rest too.
 *
 * Without storage configured this does nothing, and replays fall back to the
 * historical list alone.
 */

import type { ForexFactoryEvent } from './types';
import { historicalHighImpactEvents } from './historical-calendar';
import { redis, redisConfigured } from './upstash';

const ARCHIVE_KEY = 'calendar:archive';

/** The fields a replay needs. Forecasts and actuals are not used by it. */
type ArchivedEvent = Pick<ForexFactoryEvent, 'title' | 'country' | 'currency' | 'impact' | 'scheduledTimestamp'>;

function eventKey(e: Pick<ForexFactoryEvent, 'title' | 'scheduledTimestamp'>): string {
  return `${e.title}|${e.scheduledTimestamp}`;
}

/** Hash field and value pairs for the releases worth keeping. */
export function archiveEntries(events: ForexFactoryEvent[]): Array<[string, string]> {
  return events
    .filter((e) => e.currency === 'USD' && (e.impact === 'High' || e.impact === 'Medium'))
    .filter((e) => Number.isFinite(Date.parse(e.scheduledTimestamp)))
    .map((e) => {
      const kept: ArchivedEvent = {
        title: e.title,
        country: e.country,
        currency: e.currency,
        impact: e.impact,
        scheduledTimestamp: e.scheduledTimestamp,
      };
      return [eventKey(e), JSON.stringify(kept)];
    });
}

/**
 * The live calendar is cached for fifteen minutes upstream, so writing it
 * more often than that only repeats the same rows.
 */
const ARCHIVE_EVERY_MS = 15 * 60_000;
let lastArchivedAt = 0;

/** Writes the releases to the archive. Never throws: archiving is a side job. */
export async function archiveCalendar(events: ForexFactoryEvent[], now: number = Date.now()): Promise<void> {
  if (!redisConfigured() || now - lastArchivedAt < ARCHIVE_EVERY_MS) return;
  const entries = archiveEntries(events);
  if (entries.length === 0) return;
  lastArchivedAt = now;
  try {
    await redis('HSET', ARCHIVE_KEY, ...entries.flat());
  } catch (err) {
    console.warn('Calendar archive write failed:', err);
  }
}

function fromArchived(raw: string): ForexFactoryEvent | null {
  try {
    const e = JSON.parse(raw) as ArchivedEvent;
    if (typeof e.title !== 'string' || !Number.isFinite(Date.parse(e.scheduledTimestamp))) return null;
    const at = new Date(e.scheduledTimestamp);
    return {
      id: `arch-${eventKey(e)}`,
      title: e.title,
      country: e.country,
      currency: e.currency,
      impact: e.impact,
      date: at.toISOString().slice(0, 10),
      time: at.toISOString().slice(11, 16),
      scheduledTimestamp: at.toISOString(),
      forecast: '',
      previous: '',
      marketImplication: '',
    };
  } catch {
    return null;
  }
}

/** Everything archived so far, oldest first. Empty when storage is missing. */
export async function loadArchivedEvents(): Promise<ForexFactoryEvent[]> {
  if (!redisConfigured()) return [];
  // HGETALL over REST answers with a flat [field, value, field, value] list.
  const flat = (await redis<string[] | null>('HGETALL', ARCHIVE_KEY)) ?? [];
  const events: ForexFactoryEvent[] = [];
  for (let i = 1; i < flat.length; i += 2) {
    const event = fromArchived(flat[i]);
    if (event) events.push(event);
  }
  return sortByTime(events);
}

function sortByTime(events: ForexFactoryEvent[]): ForexFactoryEvent[] {
  return events.sort((a, b) => Date.parse(a.scheduledTimestamp) - Date.parse(b.scheduledTimestamp));
}

/**
 * The checked history plus the archive, with a release both know about kept
 * once. The history wins a tie because its time was checked by hand.
 */
export function mergeCalendars(historical: ForexFactoryEvent[], archived: ForexFactoryEvent[]): ForexFactoryEvent[] {
  const seen = new Set(historical.map(eventKey));
  return sortByTime([...historical, ...archived.filter((e) => !seen.has(eventKey(e)))]);
}

/** The calendar a replay should use. */
export async function backtestCalendar(): Promise<{ events: ForexFactoryEvent[]; archived: number }> {
  const historical = historicalHighImpactEvents();
  let archived: ForexFactoryEvent[] = [];
  try {
    archived = await loadArchivedEvents();
  } catch (err) {
    console.warn('Calendar archive read failed:', err);
  }
  const events = mergeCalendars(historical, archived);
  return { events, archived: events.length - historical.length };
}

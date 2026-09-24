import { describe, expect, test } from 'bun:test';
import { CPI_RELEASES, FOMC_DECISIONS, NFP_RELEASES, historicalHighImpactEvents } from '../lib/historical-calendar';
import { isUsDaylightSaving, newYorkTime } from '../lib/market-hours';
import { archiveEntries, mergeCalendars } from '../lib/calendar-archive';
import type { ForexFactoryEvent } from '../lib/types';

const find = (title: string, date: string) =>
  historicalHighImpactEvents().find((e) => e.title === title && e.date === date);

describe('New York release times', () => {
  test('daylight saving runs from the second Sunday of March to the first Sunday of November', () => {
    expect(isUsDaylightSaving(Date.parse('2025-03-09T06:59:00Z'))).toBe(false);
    expect(isUsDaylightSaving(Date.parse('2025-03-09T07:00:00Z'))).toBe(true);
    expect(isUsDaylightSaving(Date.parse('2025-11-02T05:59:00Z'))).toBe(true);
    expect(isUsDaylightSaving(Date.parse('2025-11-02T06:00:00Z'))).toBe(false);
  });

  test('08:30 New York is 12:30 UTC in summer and 13:30 UTC in winter', () => {
    expect(new Date(newYorkTime('2025-07-03', 8, 30)).toISOString()).toBe('2025-07-03T12:30:00.000Z');
    expect(new Date(newYorkTime('2025-01-10', 8, 30)).toISOString()).toBe('2025-01-10T13:30:00.000Z');
  });
});

describe('the checked release history', () => {
  test('every date is kept, each one once', () => {
    const events = historicalHighImpactEvents();
    expect(events).toHaveLength(FOMC_DECISIONS.length + NFP_RELEASES.length + CPI_RELEASES.length);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    expect(events.every((e) => e.currency === 'USD' && e.impact === 'High')).toBe(true);
  });

  test('releases are oldest first', () => {
    const times = historicalHighImpactEvents().map((e) => Date.parse(e.scheduledTimestamp));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test('each release lands at its New York time', () => {
    expect(find('FOMC Statement', '2024-11-07')?.scheduledTimestamp).toBe('2024-11-07T19:00:00.000Z');
    expect(find('Non-Farm Employment Change', '2025-03-07')?.scheduledTimestamp).toBe('2025-03-07T13:30:00.000Z');
    // The week after the clocks change: summer time.
    expect(find('CPI m/m', '2025-03-12')?.scheduledTimestamp).toBe('2025-03-12T12:30:00.000Z');
  });

  test('the October 2025 reports cancelled by the shutdown are not invented', () => {
    expect(NFP_RELEASES.some((d) => d.startsWith('2025-10'))).toBe(false);
    expect(CPI_RELEASES).toContain('2025-10-24'); // September CPI, published late
    expect(CPI_RELEASES.some((d) => d.startsWith('2025-11'))).toBe(false);
  });
});

const live = (overrides: Partial<ForexFactoryEvent>): ForexFactoryEvent => ({
  id: 'cal-1',
  title: 'PPI m/m',
  country: 'USD',
  currency: 'USD',
  impact: 'High',
  date: '',
  time: '',
  scheduledTimestamp: '2026-10-15T12:30:00.000Z',
  forecast: '0.2%',
  previous: '0.1%',
  marketImplication: '',
  ...overrides,
});

describe('the live calendar archive', () => {
  test('keeps dollar releases of high and medium impact only', () => {
    const entries = archiveEntries([
      live({}),
      live({ title: 'Unemployment Claims', impact: 'Medium' }),
      live({ title: 'Bank Holiday', impact: 'Low' }),
      live({ title: 'ECB Press Conference', currency: 'EUR' }),
    ]);
    expect(entries.map(([key]) => key)).toEqual([
      'PPI m/m|2026-10-15T12:30:00.000Z',
      'Unemployment Claims|2026-10-15T12:30:00.000Z',
    ]);
  });

  test('a release seen again with a new forecast is stored under the same key', () => {
    const [first] = archiveEntries([live({})]);
    const [again] = archiveEntries([live({ forecast: '0.3%', id: 'cal-7' })]);
    expect(again[0]).toBe(first[0]);
  });

  test('a release both lists know about is kept once, the checked copy first', () => {
    const historical = historicalHighImpactEvents();
    const payrolls = historical.find((e) => e.title === 'Non-Farm Employment Change')!;
    const merged = mergeCalendars(historical, [{ ...payrolls, id: 'arch-dup' }, live({ id: 'arch-ppi' })]);
    expect(merged).toHaveLength(historical.length + 1);
    expect(merged.some((e) => e.id === 'arch-dup')).toBe(false);
    expect(merged.at(-1)?.id).toBe('arch-ppi');
  });
});

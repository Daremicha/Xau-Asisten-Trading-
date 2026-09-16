import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetCalendarCache,
  filterUpcoming,
  getEconomicCalendar,
  mapCalendarPayload,
  minutesToNextHighImpact,
  parseEventTime,
} from '../lib/economic-calendar';

const original = process.env.ECONOMIC_CALENDAR_URL;
afterEach(() => {
  if (original === undefined) delete process.env.ECONOMIC_CALENDAR_URL;
  else process.env.ECONOMIC_CALENDAR_URL = original;
  __resetCalendarCache();
});

describe('nothing is invented when no provider is configured', () => {
  test('an unconfigured calendar returns no events at all', async () => {
    delete process.env.ECONOMIC_CALENDAR_URL;
    const result = await getEconomicCalendar();
    expect(result.events).toHaveLength(0);
    expect(result.configured).toBe(false);
    expect(result.source).toBeNull();
  });

  test('it says why it is empty rather than implying a quiet market', async () => {
    delete process.env.ECONOMIC_CALENDAR_URL;
    expect((await getEconomicCalendar()).message).toContain('ECONOMIC_CALENDAR_URL');
  });

  test('with no events there is no news adjustment to apply', () => {
    // This is what used to widen the stop from an invented schedule.
    expect(minutesToNextHighImpact([])).toBeNull();
  });
});

describe('reading a provider payload', () => {
  const future = Date.now() + 3_600_000;

  test('a bare array of releases is accepted', () => {
    const events = mapCalendarPayload([
      { title: 'Core CPI', currency: 'USD', impact: 'High', timestamp: future, forecast: '0.3%', previous: '0.2%' },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Core CPI');
    expect(events[0].impact).toBe('High');
    expect(events[0].forecast).toBe('0.3%');
  });

  test('a wrapped payload is accepted under any of the common keys', () => {
    for (const key of ['events', 'data', 'result']) {
      const events = mapCalendarPayload({ [key]: [{ event: 'NFP', timestamp: future, importance: 'high' }] });
      expect(events).toHaveLength(1);
      expect(events[0].title).toBe('NFP');
    }
  });

  test('rows without a title or a time are dropped, never guessed at', () => {
    const events = mapCalendarPayload([
      { title: 'Good', timestamp: future },
      { title: '', timestamp: future },
      { title: 'No time' },
      null,
      'nonsense',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Good');
  });

  test('releases come back in chronological order', () => {
    const events = mapCalendarPayload([
      { title: 'Later', timestamp: future + 7_200_000 },
      { title: 'Sooner', timestamp: future },
    ]);
    expect(events.map((e) => e.title)).toEqual(['Sooner', 'Later']);
  });

  test('a malformed payload yields nothing instead of throwing', () => {
    expect(mapCalendarPayload(null)).toHaveLength(0);
    expect(mapCalendarPayload({ nope: true })).toHaveLength(0);
    expect(mapCalendarPayload('string')).toHaveLength(0);
  });

  test('an unknown impact is treated as low, not promoted to high', () => {
    expect(mapCalendarPayload([{ title: 'X', timestamp: future, impact: 'whatever' }])[0].impact).toBe('Low');
  });

  test('an unknown currency falls back rather than being passed through', () => {
    expect(mapCalendarPayload([{ title: 'X', timestamp: future, currency: 'XYZ' }])[0].currency).toBe('USD');
  });
});

describe('timestamp shapes', () => {
  test('seconds and milliseconds are both understood', () => {
    expect(parseEventTime({ timestamp: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(parseEventTime({ timestamp: 1_700_000_000_000 })).toBe(1_700_000_000_000);
  });

  test('a zoneless datetime is read as UTC', () => {
    expect(parseEventTime({ datetime: '2026-09-16 12:30:00' })).toBe(Date.UTC(2026, 8, 16, 12, 30));
  });

  test('an explicit zone is honoured', () => {
    expect(parseEventTime({ date: '2026-09-16T12:30:00Z' })).toBe(Date.UTC(2026, 8, 16, 12, 30));
  });

  test('an unusable time is reported as missing', () => {
    expect(parseEventTime({ title: 'no time here' })).toBeNull();
    expect(parseEventTime({ timestamp: 'not a date' })).toBeNull();
  });
});

describe('upcoming releases only', () => {
  const now = Date.UTC(2026, 8, 16, 12, 0, 0);
  const events = mapCalendarPayload([
    { title: 'Past', timestamp: now - 3_600_000, impact: 'high' },
    { title: 'Soon', timestamp: now + 1_800_000, impact: 'high' },
    { title: 'Later', timestamp: now + 7_200_000, impact: 'medium' },
  ]);

  test('releases already behind us are excluded', () => {
    expect(filterUpcoming(events, now).map((e) => e.title)).toEqual(['Soon', 'Later']);
  });

  test('the wait to the next high impact release is measured, not assumed', () => {
    expect(minutesToNextHighImpact(events, now)).toBeCloseTo(30, 5);
  });

  test('a medium impact release does not trigger the news adjustment', () => {
    const mediumOnly = mapCalendarPayload([{ title: 'Claims', timestamp: now + 600_000, impact: 'medium' }]);
    expect(minutesToNextHighImpact(mediumOnly, now)).toBeNull();
  });

  test('a calendar with only past releases yields no wait', () => {
    const past = mapCalendarPayload([{ title: 'Done', timestamp: now - 600_000, impact: 'high' }]);
    expect(minutesToNextHighImpact(past, now)).toBeNull();
  });
});

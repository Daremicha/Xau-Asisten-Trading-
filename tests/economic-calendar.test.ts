import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetCalendarCache,
  filterUpcoming,
  DEFAULT_CALENDAR_URL,
  getEconomicCalendar,
  usdOnly,
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
  test('an explicitly empty setting turns the calendar off entirely', async () => {
    // Deliberately blank means "no calendar", and is obeyed without a request.
    process.env.ECONOMIC_CALENDAR_URL = '';
    const result = await getEconomicCalendar();
    expect(result.events).toHaveLength(0);
    expect(result.configured).toBe(false);
    expect(result.source).toBeNull();
  });

  test('it says why it is empty rather than implying a quiet market', async () => {
    process.env.ECONOMIC_CALENDAR_URL = '';
    expect((await getEconomicCalendar()).message).toContain('ECONOMIC_CALENDAR_URL');
  });

  test('an unset variable falls back to a real published feed, never to an invented one', () => {
    // Asserted on the constant rather than by fetching it: a unit test that
    // reaches the internet is a unit test that fails on a train.
    expect(DEFAULT_CALENDAR_URL.startsWith('https://')).toBe(true);
    expect(DEFAULT_CALENDAR_URL).toContain('calendar');
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

  test('an unreadable currency is unknown, never assumed to be the dollar', () => {
    // Assuming USD would put a foreign release inside the dollar-only calendar
    // that feeds the news shield, and widen the stop on a gold trade for an
    // event that has nothing to do with it.
    expect(mapCalendarPayload([{ title: 'X', timestamp: future, currency: 'XYZ' }])[0].currency).toBe(
      'Unknown'
    );
    expect(mapCalendarPayload([{ title: 'X', timestamp: future }])[0].currency).toBe('Unknown');
  });

  test('a feed that writes country names instead of codes is still read', () => {
    const rows = [
      { title: 'Payrolls', timestamp: future, country: 'United States' },
      { title: 'BOJ', timestamp: future, country: 'Japan' },
      { title: 'CPI', timestamp: future, country: 'Euro Area' },
      { title: 'Mystery', timestamp: future, country: 'Atlantis' },
    ];
    expect(mapCalendarPayload(rows).map((e) => e.currency).sort()).toEqual([
      'EUR',
      'JPY',
      'USD',
      'Unknown',
    ]);
  });

  test('the dollar-only view keeps dollars and drops everything else', () => {
    const rows = [
      { title: 'Payrolls', timestamp: future, country: 'USD' },
      { title: 'BOJ', timestamp: future, country: 'Japan' },
      { title: 'Mystery', timestamp: future, country: 'Atlantis' },
    ];
    const kept = usdOnly(mapCalendarPayload(rows));
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe('Payrolls');
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

describe('the shape the default feed publishes', () => {
  test('a Forex Factory row maps to a usable event', () => {
    // The published weekly feed: a bare array, the currency code in `country`,
    // and an ISO timestamp carrying its own offset.
    const events = mapCalendarPayload([
      {
        title: 'ECB Press Conference',
        country: 'EUR',
        date: '2026-09-18T08:45:00-04:00',
        impact: 'High',
        forecast: '',
        previous: '',
      },
      {
        title: 'Flash Manufacturing PMI',
        country: 'USD',
        date: '2026-09-18T09:45:00-04:00',
        impact: 'Medium',
        forecast: '48.5',
        previous: '48.0',
      },
    ]);

    expect(events).toHaveLength(2);
    expect(events[0].currency).toBe('EUR');
    expect(events[0].impact).toBe('High');
    expect(events[1].currency).toBe('USD');
    expect(events[1].forecast).toBe('48.5');
    expect(events[0].scheduledTimestamp).toBe('2026-09-18T12:45:00.000Z');
  });

  test('a bank holiday row is kept at the lowest impact rather than dropped', () => {
    const events = mapCalendarPayload([
      { title: 'Bank Holiday', country: 'JPY', date: '2026-09-21T00:00:00-04:00', impact: 'Holiday' },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].impact).toBe('Low');
    expect(events[0].currency).toBe('JPY');
  });

  test('a provider that names the country in words still reads as a currency', () => {
    const events = mapCalendarPayload([
      { title: 'CPI', country: 'United States', currency: 'USD', date: '2026-09-18T12:30:00Z', impact: 'High' },
    ]);
    expect(events[0].currency).toBe('USD');
    expect(events[0].country).toBe('United States');
  });
});

describe('only the releases that move gold', () => {
  const events = mapCalendarPayload([
    { title: 'Core CPI m/m', country: 'USD', date: '2026-09-18T12:30:00Z', impact: 'High' },
    { title: 'ECB Press Conference', country: 'EUR', date: '2026-09-18T12:45:00Z', impact: 'High' },
    { title: 'Bank Holiday', country: 'JPY', date: '2026-09-18T00:00:00Z', impact: 'Low' },
    { title: 'Employment Change', country: 'AUD', date: '2026-09-18T01:30:00Z', impact: 'Medium' },
  ]);

  test('the dollar side is kept and the rest is dropped', () => {
    // An ounce of gold priced in dollars: the dollar half is what a release moves.
    const kept = usdOnly(events);
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe('Core CPI m/m');
  });

  test('the news shield reads the same list the screen shows', () => {
    const now = Date.parse('2026-09-18T11:30:00Z');
    // Without the filter the nearest high impact release would be the ECB one.
    expect(minutesToNextHighImpact(usdOnly(events), now)).toBe(60);
  });

  test('a calendar with no dollar releases is simply empty, not an error', () => {
    const nonUsd = events.filter((e) => e.currency !== 'USD');
    expect(usdOnly(nonUsd)).toEqual([]);
    expect(minutesToNextHighImpact(usdOnly(nonUsd))).toBeNull();
  });
});

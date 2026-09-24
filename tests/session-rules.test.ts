import { describe, expect, test } from 'bun:test';
import {
  ASIAN_SESSION_MIN_CONVICTION,
  effectiveConvictionFloor,
  sessionConvictionFloor,
  sessionDeclineNote,
} from '../lib/session-rules';

describe('weak setups are declined in the Asian session', () => {
  test('only the Asian session raises the floor, to 55', () => {
    expect(ASIAN_SESSION_MIN_CONVICTION).toBe(55);
    expect(sessionConvictionFloor('Asian Session')).toBe(55);
    for (const zone of ['London Open', 'New York Open', 'London Close', 'Off-Hours'] as const) {
      expect(sessionConvictionFloor(zone)).toBe(0);
    }
  });

  test('the higher of the user floor and the session floor applies', () => {
    expect(effectiveConvictionFloor(0, 'Asian Session')).toBe(55);
    expect(effectiveConvictionFloor(40, 'Asian Session')).toBe(55);
    expect(effectiveConvictionFloor(70, 'Asian Session')).toBe(70);
    expect(effectiveConvictionFloor(40, 'London Open')).toBe(40);
  });

  test('the note explains only a decline the session caused', () => {
    expect(sessionDeclineNote(40, 'Asian Session', 48)).toContain('Asian session asks for a conviction of 55');
    expect(sessionDeclineNote(40, 'Asian Session', 60)).toBeNull();
    expect(sessionDeclineNote(70, 'Asian Session', 48)).toBeNull();
    expect(sessionDeclineNote(40, 'London Open', 30)).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import {
  ASIAN_SESSION_MIN_CONVICTION,
  effectiveConvictionFloor,
  sessionConvictionFloor,
  sessionDeclineNote,
  WEAK_SETUP_BELOW,
  weakSetupDecline,
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
    expect(sessionDeclineNote(40, 'Asian Session', 48)).toContain('Sesi Asia meminta conviction minimal 55');
    expect(sessionDeclineNote(40, 'Asian Session', 60)).toBeNull();
    expect(sessionDeclineNote(70, 'Asian Session', 48)).toBeNull();
    expect(sessionDeclineNote(40, 'London Open', 30)).toBeNull();
  });
});

describe('the weakest setups need the directional bias on their side', () => {
  test('under 40, a setup is declined unless the pivot bias agrees', () => {
    expect(WEAK_SETUP_BELOW).toBe(40);
    expect(weakSetupDecline(30, { 'Pivot and directional bias': 1 })).toBeNull();
    expect(weakSetupDecline(30, { 'Pivot and directional bias': -1 })).toContain('pivot dan arah bias');
    expect(weakSetupDecline(30, {})).not.toBeNull();
    expect(weakSetupDecline(30, { 'Pivot and directional bias': 0.1 })).not.toBeNull();
  });

  test('from 40 up the bias is not required', () => {
    expect(weakSetupDecline(40, { 'Pivot and directional bias': -1 })).toBeNull();
    expect(weakSetupDecline(75, {})).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import {
  followsTestedConfiguration,
  TESTED_FLOOR,
  TESTED_PROTECT_AT_R,
  TESTED_STYLE,
  untestedSettingNote,
} from '../lib/tested-configuration';

describe('the setting that held up on real history', () => {
  test('is Intraday with a floor of 40 and the stop to entry at 1R', () => {
    expect(TESTED_STYLE).toBe('Intraday');
    expect(TESTED_FLOOR).toBe(40);
    expect(TESTED_PROTECT_AT_R).toBe(1);
  });

  test('every Intraday floor counts as following it, taking everything included', () => {
    for (const floor of [0, 40, 55, 70]) {
      expect(followsTestedConfiguration('Intraday', floor)).toBe(true);
      expect(untestedSettingNote('Intraday', floor)).toBeNull();
    }
  });

  test('another style says what the replay found', () => {
    expect(untestedSettingNote('Scalping', 70)).toContain('less than a tenth');
    expect(untestedSettingNote('Scalping', 40)).toContain('more than 30%');
    expect(untestedSettingNote('Swing', 55)).toContain('not part of that test');
  });
});

import { describe, expect, test } from 'bun:test';
import {
  followsTestedConfiguration,
  TESTED_FLOOR,
  TESTED_PROTECT_AT_R,
  TESTED_STYLE,
  untestedSettingNote,
} from '../lib/tested-configuration';

describe('the setting that held up on real history', () => {
  test('is Intraday with a floor of 55 and the stop to entry at 1R', () => {
    expect(TESTED_STYLE).toBe('Intraday');
    expect(TESTED_FLOOR).toBe(55);
    expect(TESTED_PROTECT_AT_R).toBe(1);
  });

  test('a stricter floor still counts as following it', () => {
    expect(followsTestedConfiguration('Intraday', 55)).toBe(true);
    expect(followsTestedConfiguration('Intraday', 70)).toBe(true);
    expect(untestedSettingNote('Intraday', 70)).toBeNull();
  });

  test('another style or a lower floor says what the replay found', () => {
    expect(untestedSettingNote('Intraday', 0)).toContain('fell 78%');
    expect(untestedSettingNote('Intraday', 40)).toContain('16 trades in a row');
    expect(untestedSettingNote('Scalping', 70)).toContain('an eighth as much');
    expect(untestedSettingNote('Scalping', 0)).toContain('below a floor of 70');
    expect(untestedSettingNote('Swing', 55)).toContain('not part of that test');
  });
});

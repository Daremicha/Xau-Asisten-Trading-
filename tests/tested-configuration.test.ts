import { describe, expect, test } from 'bun:test';
import { followsTestedConfiguration, TESTED_FLOOR, TESTED_STYLE } from '../lib/tested-configuration';

describe('the setting that held up on real history', () => {
  test('is Scalping with a floor of 70', () => {
    expect(TESTED_STYLE).toBe('Scalping');
    expect(TESTED_FLOOR).toBe(70);
  });

  test('a stricter floor still counts as following it', () => {
    expect(followsTestedConfiguration('Scalping', 70)).toBe(true);
    expect(followsTestedConfiguration('Scalping', 85)).toBe(true);
  });

  test('another style or a lower floor does not', () => {
    expect(followsTestedConfiguration('Intraday', 70)).toBe(false);
    expect(followsTestedConfiguration('Scalping', 55)).toBe(false);
    expect(followsTestedConfiguration('Swing', 0)).toBe(false);
  });
});

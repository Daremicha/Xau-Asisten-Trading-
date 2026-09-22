import { describe, expect, test } from 'bun:test';
import { STYLE_PROFILES, stopBandLabel, stopBandPips } from '../lib/style-profiles';
import { STYLE_PROFILES as VIA_ENGINE } from '../lib/signal-engine';
import type { TradingStyle } from '../lib/types';

const STYLES: TradingStyle[] = ['Scalping', 'Intraday', 'Swing'];

describe('the caption the selector shows', () => {
  test('is the range the engine actually enforces', () => {
    // The selector used to carry hand written bands — 15-30p, 45-80p and
    // 120-250p — and every one of them had drifted. A trader choosing Intraday
    // was promised at most eighty pips of stop and could be handed a hundred
    // and eighty.
    for (const style of STYLES) {
      const band = stopBandPips(style);
      expect(band.min).toBe(Math.round(STYLE_PROFILES[style].minStopDollars * 10));
      expect(band.max).toBe(Math.round(STYLE_PROFILES[style].maxStopDollars * 10));
    }
  });

  test('says what the engine allows today', () => {
    // Written out so a change to a profile has to change this line too, rather
    // than quietly moving what the screen promises.
    expect(stopBandLabel('Scalping')).toBe('18-70p');
    expect(stopBandLabel('Intraday')).toBe('45-180p');
    expect(stopBandLabel('Swing')).toBe('120-600p');
  });

  test('a dollar of stop is ten pips, which is what makes the conversion right', () => {
    expect(stopBandPips('Intraday').max).toBe(180);
    expect(STYLE_PROFILES.Intraday.maxStopDollars).toBe(18);
  });
});

describe('there is only one copy of these numbers', () => {
  test('the engine serves the same object the screen reads', () => {
    // Re-exported rather than redeclared, so the two cannot disagree.
    expect(VIA_ENGINE).toBe(STYLE_PROFILES);
  });

  test('every style has a band that makes sense', () => {
    for (const style of STYLES) {
      const p = STYLE_PROFILES[style];
      expect(p.minStopDollars).toBeGreaterThan(0);
      expect(p.maxStopDollars).toBeGreaterThan(p.minStopDollars);
    }
  });

  test('the styles widen in the order they are offered', () => {
    expect(STYLE_PROFILES.Scalping.maxStopDollars).toBeLessThan(STYLE_PROFILES.Intraday.maxStopDollars);
    expect(STYLE_PROFILES.Intraday.maxStopDollars).toBeLessThan(STYLE_PROFILES.Swing.maxStopDollars);
  });
});

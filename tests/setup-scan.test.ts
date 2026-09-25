import { describe, expect, test } from 'bun:test';
import { isRepeat, offerKey, REPEAT_AFTER_MS, sanitiseScanSettings, scanRequest } from '../lib/setup-scan';
import { newSetupAlert } from '../lib/trade-alerts';

const settings = {
  equity: 3.78,
  riskPercentage: 1,
  tradingStyle: 'Intraday',
  accountType: 'Cent',
  brokerId: 'EXNESS',
  minConviction: 0,
  dailyLossLimitPercent: 3,
  protectAtR: 1,
  recentResults: [{ closedAt: Date.parse('2026-09-25T02:00:00Z'), net: -0.12 }],
};

describe('scan settings from the app', () => {
  test('are kept when they describe a real account', () => {
    const clean = sanitiseScanSettings(settings);
    expect(clean?.tradingStyle).toBe('Intraday');
    expect(clean?.protectAtR).toBe(1);
    expect(clean?.recentResults).toHaveLength(1);
  });

  test('are refused when malformed, so nothing is scanned on a guess', () => {
    expect(sanitiseScanSettings({ ...settings, equity: -5 })).toBeNull();
    expect(sanitiseScanSettings({ ...settings, tradingStyle: 'Yolo' })).toBeNull();
    expect(sanitiseScanSettings(null)).toBeNull();
  });

  test('become the same analysis request the app posts, with today’s results for the daily limit', () => {
    const request = scanRequest(sanitiseScanSettings(settings)!);
    expect(request?.minConviction).toBe(0);
    expect(request?.dailyLossLimitPercent).toBe(3);
    expect(request?.pastLearningRecords[0].profitOrLossDollars).toBe(-0.12);
  });
});

describe('announcing a setup', () => {
  const setup = { id: 's1', orderType: 'SELL LIMIT' as const, entryPrice: 4280.2, stopLoss: 4298.2, takeProfit1: 4253.2, recommendedLotSize: 0.01 };

  test('says what to place, and where', () => {
    const alert = newSetupAlert(setup, 's1');
    expect(alert.title).toBe('📊 NEW SETUP: SELL LIMIT @ 4280.20');
    expect(alert.body).toContain('SL 4298.20 · TP1 4253.20 · lot 0.01');
  });

  test('the same order is not announced twice within a few hours', () => {
    const now = Date.parse('2026-09-25T10:00:00Z');
    const key = offerKey(setup);
    expect(isRepeat(key, { key, at: new Date(now - 60_000).toISOString() }, now)).toBe(true);
    expect(isRepeat(key, { key, at: new Date(now - REPEAT_AFTER_MS - 1).toISOString() }, now)).toBe(false);
    expect(isRepeat(offerKey({ ...setup, entryPrice: 4290 }), { key, at: new Date(now).toISOString() }, now)).toBe(false);
  });
});

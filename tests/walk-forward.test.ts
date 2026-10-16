import { describe, expect, test } from 'bun:test';
import { buildWalkForwardWindows, runWalkForward } from '../lib/walk-forward';
import type { Candle } from '../lib/candles';

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const price = 2000 + index * 0.1;
    return {
      time: index * 15 * 60_000,
      open: price,
      high: price + 0.2,
      low: price - 0.2,
      close: price + 0.05,
      volume: 100,
    };
  });
}

describe('walk-forward windows', () => {
  test('creates chronological non-overlapping train, validation, and test ranges', () => {
    const windows = buildWalkForwardWindows(candles(30), {
      trainBars: 10,
      validationBars: 5,
      testBars: 5,
      stepBars: 5,
    });

    expect(windows).toHaveLength(3);
    expect(windows[0]).toEqual({
      index: 0,
      train: { start: 0, end: 10 },
      validation: { start: 10, end: 15 },
      test: { start: 15, end: 20 },
    });
    expect(windows[1].train.start).toBe(5);
    expect(windows[1].validation.start).toBe(windows[1].train.end);
    expect(windows[1].test.start).toBe(windows[1].validation.end);
    expect(windows[1].test.start).toBe(20);
    expect(windows[2].test.end).toBe(30);
  });

  test('returns no window when one complete fold cannot fit', () => {
    expect(
      buildWalkForwardWindows(candles(19), {
        trainBars: 10,
        validationBars: 5,
        testBars: 5,
      })
    ).toEqual([]);
  });
});

describe('walk-forward evaluation', () => {
  test('reports insufficient data instead of inventing an out-of-sample result', () => {
    const result = runWalkForward(
      candles(19),
      {
        intervalMs: 15 * 60_000,
        tradingStyle: 'Intraday',
        accountType: 'Cent',
        brokerId: 'EXNESS',
        startingEquity: 1000,
        riskPercentage: 1,
      },
      { trainBars: 10, validationBars: 5, testBars: 5 }
    );

    expect(result.status).toBe('insufficient');
    expect(result.folds).toHaveLength(0);
    expect(result.controlStats).toBeNull();
    expect(result.frozenStats).toBeNull();
  });

  test('keeps aggregate test result separate from training and validation', () => {
    const result = runWalkForward(
      candles(30),
      {
        intervalMs: 15 * 60_000,
        tradingStyle: 'Intraday',
        accountType: 'Cent',
        brokerId: 'EXNESS',
        startingEquity: 1000,
        riskPercentage: 1,
      },
      { trainBars: 10, validationBars: 5, testBars: 5, stepBars: 5 }
    );

    expect(result.status).toBe('complete');
    expect(result.folds).toHaveLength(3);
    expect(result.testTrades.every((trade) => trade.openedAt >= 15 * 15 * 60_000)).toBe(true);
  });
});

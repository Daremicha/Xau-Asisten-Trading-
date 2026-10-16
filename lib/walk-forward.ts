import {
  runBacktest,
  warmupBars as defaultWarmupBars,
  type BacktestConfig,
  type BacktestResult,
  type BacktestTrade,
} from './backtest-engine';
import { summariseTrades, type BacktestStats } from './backtest-stats';
import type { Candle } from './candles';

export interface WalkForwardWindowOptions {
  trainBars: number;
  validationBars: number;
  testBars: number;
  stepBars?: number;
}

export interface WalkForwardWindow {
  index: number;
  train: { start: number; end: number };
  validation: { start: number; end: number };
  test: { start: number; end: number };
}

export interface WalkForwardFold {
  index: number;
  window: WalkForwardWindow;
  training: BacktestResult;
  control: BacktestResult;
  frozen: BacktestResult;
  controlStats: BacktestStats;
  frozenStats: BacktestStats;
}

export interface WalkForwardResult {
  status: 'complete' | 'insufficient';
  windows: WalkForwardWindow[];
  folds: WalkForwardFold[];
  testTrades: BacktestTrade[];
  controlStats: BacktestStats | null;
  frozenStats: BacktestStats | null;
  message: string;
}

function validSize(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** Build chronological, non-overlapping train/validation/test windows. */
export function buildWalkForwardWindows(
  candles: Candle[],
  options: WalkForwardWindowOptions
): WalkForwardWindow[] {
  const { trainBars, validationBars, testBars } = options;
  const stepBars = options.stepBars ?? testBars;
  if (![trainBars, validationBars, testBars, stepBars].every(validSize)) return [];
  if (candles.length < trainBars + validationBars + testBars) return [];

  const windows: WalkForwardWindow[] = [];
  for (
    let start = 0;
    start + trainBars + validationBars + testBars <= candles.length;
    start += stepBars
  ) {
    const trainEnd = start + trainBars;
    const validationEnd = trainEnd + validationBars;
    const testEnd = validationEnd + testBars;
    windows.push({
      index: windows.length,
      train: { start, end: trainEnd },
      validation: { start: trainEnd, end: validationEnd },
      test: { start: validationEnd, end: testEnd },
    });
  }
  return windows;
}

function sliceWindow(candles: Candle[], range: { start: number; end: number }): Candle[] {
  return candles.slice(range.start, range.end);
}

function testConfig(
  base: Omit<BacktestConfig, 'candles' | 'adaptive' | 'startingPrior' | 'warmupBars'>,
  candles: Candle[],
  warmupBars: number,
  startingPrior: BacktestConfig['startingPrior'] = null
): BacktestConfig {
  return {
    ...base,
    candles,
    adaptive: false,
    startingPrior,
    warmupBars,
  };
}

/**
 * Evaluate parameters with strict temporal separation.
 * Training can learn. Test can only consume training output.
 */
export function runWalkForward(
  candles: Candle[],
  baseConfig: Omit<BacktestConfig, 'candles' | 'adaptive' | 'startingPrior' | 'warmupBars'>,
  windowOptions: WalkForwardWindowOptions
): WalkForwardResult {
  const windows = buildWalkForwardWindows(candles, windowOptions);
  if (windows.length === 0) {
    return {
      status: 'insufficient',
      windows,
      folds: [],
      testTrades: [],
      controlStats: null,
      frozenStats: null,
      message: 'Data tidak cukup untuk satu fold train-validation-test.',
    };
  }

  const folds: WalkForwardFold[] = [];
  for (const window of windows) {
    const trainingCandles = sliceWindow(candles, window.train);
    const testCandles = sliceWindow(candles, {
      start: window.train.start,
      end: window.test.end,
    });
    const testWarmupBars = window.validation.end - window.train.start;

    const training = runBacktest({
      ...baseConfig,
      candles: trainingCandles,
      adaptive: true,
      startingPrior: null,
      warmupBars: Math.min(
        defaultWarmupBars(baseConfig.intervalMs),
        trainingCandles.length - 1
      ),
    });
    const control = runBacktest(testConfig(baseConfig, testCandles, testWarmupBars));
    const frozen = runBacktest(
      testConfig(baseConfig, testCandles, testWarmupBars, training.finalWeights)
    );

    folds.push({
      index: window.index,
      window,
      training,
      control,
      frozen,
      controlStats: summariseTrades(control.trades, baseConfig.startingEquity),
      frozenStats: summariseTrades(frozen.trades, baseConfig.startingEquity),
    });
  }

  const testTrades = folds.flatMap((fold) => fold.frozen.trades.filter((trade) => trade.filled));
  const controlTrades = folds.flatMap((fold) => fold.control.trades.filter((trade) => trade.filled));
  const controlStats = controlTrades.length
    ? summariseTrades(controlTrades, baseConfig.startingEquity)
    : null;
  const frozenStats = testTrades.length ? summariseTrades(testTrades, baseConfig.startingEquity) : null;

  return {
    status: 'complete',
    windows,
    folds,
    testTrades,
    controlStats,
    frozenStats,
    message: `${folds.length} fold out-of-sample selesai. Hanya trade test masuk agregat.`,
  };
}

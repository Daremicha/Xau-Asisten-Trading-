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
  /** Sequential test equity, carrying the prior fold's ending equity forward. */
  sequential: {
    startingEquity: number;
    finalEquity: number;
    netDollars: number;
    maxDrawdownPercent: number;
  } | null;
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
      sequential: null,
      message: 'Data tidak cukup untuk satu fold train-validation-test.',
    };
  }

  const folds: WalkForwardFold[] = [];
  const sequentialStartingEquity = baseConfig.startingEquity;
  let sequentialEquity = sequentialStartingEquity;
  let sequentialPeak = sequentialEquity;
  let sequentialMaxDrawdown = 0;
  for (const window of windows) {
    const trainingCandles = sliceWindow(candles, window.train);
    const testCandles = sliceWindow(candles, {
      start: window.train.start,
      end: window.test.end,
    });
    const testWarmupBars = window.validation.end - window.train.start;

    const foldConfig = { ...baseConfig, startingEquity: sequentialEquity };
    const training = runBacktest({
      ...foldConfig,
      candles: trainingCandles,
      adaptive: true,
      startingPrior: null,
      warmupBars: Math.min(
        defaultWarmupBars(baseConfig.intervalMs),
        trainingCandles.length - 1
      ),
    });
    const control = runBacktest(testConfig(foldConfig, testCandles, testWarmupBars));
    const frozen = runBacktest(
      testConfig(foldConfig, testCandles, testWarmupBars, training.finalWeights)
    );

    for (const trade of frozen.trades) {
      if (!trade.filled) continue;
      sequentialEquity += trade.netDollars;
      sequentialPeak = Math.max(sequentialPeak, sequentialEquity);
      if (sequentialPeak > 0) sequentialMaxDrawdown = Math.max(sequentialMaxDrawdown, ((sequentialPeak - sequentialEquity) / sequentialPeak) * 100);
    }

    folds.push({
      index: window.index,
      window,
      training,
      control,
      frozen,
      controlStats: summariseTrades(control.trades, foldConfig.startingEquity),
      frozenStats: summariseTrades(frozen.trades, foldConfig.startingEquity),
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
    sequential: {
      startingEquity: sequentialStartingEquity,
      finalEquity: sequentialEquity,
      netDollars: sequentialEquity - sequentialStartingEquity,
      maxDrawdownPercent: Number(sequentialMaxDrawdown.toFixed(2)),
    },
    message: `${folds.length} fold out-of-sample selesai. Agregat trade dan equity sequential ditampilkan terpisah; hanya trade test masuk agregat.`,
  };
}

/**
 * Runs a backtest from the browser.
 *
 * Two jobs: pull the history down a page at a time from our own API, then
 * replay it. Both happen on the client on purpose.
 *
 * The download is paged because no provider returns two years of fifteen minute
 * candles in one response, and the free Twelve Data plan allows only eight
 * requests a minute, which is longer than any serverless function may run.
 *
 * The replay is stepped rather than run in one blocking loop so the progress bar
 * actually moves. Thousands of full analyses in a single synchronous pass would
 * freeze the tab for the length of the run.
 */

import { Candle } from './candles';
import { createBacktest, type BacktestResult } from './backtest-engine';
import {
  compareRuns,
  comparePhases,
  summariseTrades,
  type LearningComparison,
  type PhaseComparison,
  type BacktestStats,
} from './backtest-stats';
import { fromWire, mergeCandles, INTERVAL_MS, type HistoryInterval } from './history-feed';
import { AccountType, BrokerId, TradingStyle } from './types';

/** Average days in a month, so "24 months" means two calendar years of data. */
const DAYS_PER_MONTH = 30.44;
/** Hard ceiling on download pages, so a misbehaving provider cannot loop forever. */
const MAX_PAGES = 30;
/** Retries per page when the provider is rate limiting. */
const MAX_RATE_LIMIT_RETRIES = 3;

export type BacktestPhase = 'download' | 'control' | 'adaptive' | 'done';

export interface BacktestProgressUpdate {
  phase: BacktestPhase;
  /** One line the user can read while they wait. */
  label: string;
  /** Zero to one hundred. */
  percent: number;
}

export interface BacktestCoverage {
  provider: string | null;
  interval: HistoryInterval;
  from: number | null;
  to: number | null;
  bars: number;
  /** Months of history actually downloaded, which may be less than requested. */
  monthsCovered: number;
  requestedMonths: number;
  /** True when the provider supplied the full period asked for. */
  complete: boolean;
  message: string;
}

export interface BacktestJobOptions {
  months: number;
  interval: HistoryInterval;
  tradingStyle: TradingStyle;
  accountType: AccountType;
  brokerId: BrokerId;
  equity: number;
  riskPercentage: number;
  /** Lowest conviction worth trading, zero to one hundred. Zero takes everything. */
  minConviction?: number;
  onProgress?: (update: BacktestProgressUpdate) => void;
  signal?: AbortSignal;
}

export interface BacktestJobResult {
  coverage: BacktestCoverage;
  control: BacktestResult;
  adaptive: BacktestResult;
  controlStats: BacktestStats;
  adaptiveStats: BacktestStats;
  comparison: LearningComparison;
  phases: PhaseComparison;
  ranAt: string;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Backtest cancelled.'));
      },
      { once: true }
    );
  });
}

/** Hands control back to the browser so the page can paint between slices. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function assertLive(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Backtest cancelled.');
}

export interface DownloadResult {
  candles: Candle[];
  coverage: BacktestCoverage;
}

/** Pulls history backwards until the requested period is covered. */
export async function downloadHistory(
  options: Pick<BacktestJobOptions, 'months' | 'interval' | 'onProgress' | 'signal'>
): Promise<DownloadResult> {
  const { months, interval, onProgress, signal } = options;
  const targetMs = Date.now() - months * DAYS_PER_MONTH * 86_400_000;

  let candles: Candle[] = [];
  let provider: string | null = null;
  let message = '';
  let before: number | null = null;
  let retries = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    assertLive(signal);

    const url = `/api/backtest/history?interval=${interval}${before === null ? '' : `&before=${before}`}`;
    const res = await fetch(url, { signal });
    const data = await res.json().catch(() => null);

    if (!res.ok || !data) {
      message = data?.error ?? `History download failed with HTTP ${res.status}.`;
      break;
    }

    if (data.retryAfterMs) {
      if (retries >= MAX_RATE_LIMIT_RETRIES) {
        message = 'The data provider kept rate limiting the download, so the run uses what arrived.';
        break;
      }
      retries += 1;
      onProgress?.({
        phase: 'download',
        label: `Provider rate limit reached. Waiting ${Math.round(
          data.retryAfterMs / 1000
        )}s for the next page (attempt ${retries} of ${MAX_RATE_LIMIT_RETRIES}).`,
        percent: Math.min(45, (candles.length / Math.max(1, months * 2000)) * 45),
      });
      await wait(data.retryAfterMs, signal);
      continue;
    }

    retries = 0;
    const page_candles = fromWire(data.candles);
    provider = data.provider ?? provider;
    message = data.message ?? message;

    if (page_candles.length === 0) break;

    const previousCount = candles.length;
    candles = mergeCandles(candles, page_candles);
    const oldest = candles[0].time;

    onProgress?.({
      phase: 'download',
      label: `Downloaded ${candles.length.toLocaleString('en-US')} candles back to ${new Date(
        oldest
      ).toISOString().slice(0, 10)}.`,
      percent: Math.min(
        45,
        ((Date.now() - oldest) / (Date.now() - targetMs)) * 45
      ),
    });

    // Nothing new arrived, or the provider says it has no more history.
    if (candles.length === previousCount || data.exhausted) break;
    if (oldest <= targetMs) break;
    before = oldest;
  }

  const from = candles.length ? candles[0].time : null;
  const to = candles.length ? candles[candles.length - 1].time : null;
  const monthsCovered =
    from !== null && to !== null ? parseFloat(((to - from) / (DAYS_PER_MONTH * 86_400_000)).toFixed(1)) : 0;

  return {
    candles,
    coverage: {
      provider,
      interval,
      from,
      to,
      bars: candles.length,
      monthsCovered,
      requestedMonths: months,
      // Half a month of slack: a provider that stops at a session boundary has
      // still covered the period for any practical purpose.
      complete: monthsCovered >= months - 0.5,
      message,
    },
  };
}

/** Replays one pass, yielding to the browser between slices. */
async function replay(
  candles: Candle[],
  options: BacktestJobOptions,
  adaptive: boolean,
  phase: BacktestPhase,
  baseline: number,
  span: number
): Promise<BacktestResult> {
  const run = createBacktest({
    candles,
    intervalMs: INTERVAL_MS[options.interval],
    tradingStyle: options.tradingStyle,
    accountType: options.accountType,
    brokerId: options.brokerId,
    startingEquity: options.equity,
    riskPercentage: options.riskPercentage,
    minConviction: options.minConviction,
    adaptive,
  });

  let guard = 0;
  for (;;) {
    assertLive(options.signal);
    const progress = run.step(20);
    if (progress.done || guard > 100_000) break;
    guard += 1;

    const share = progress.totalBars > 0 ? progress.barsProcessed / progress.totalBars : 1;
    options.onProgress?.({
      phase,
      label: `${adaptive ? 'Learning run' : 'Control run'}: ${progress.trades} trades from ${progress.decisions} analyses.`,
      percent: baseline + share * span,
    });
    await yieldToBrowser();
  }

  return run.result();
}

/**
 * The whole exercise: download the period, trade it twice, and compare.
 *
 * The control run keeps the engine's starting parameters for the entire period.
 * The learning run re-derives them after every closed trade, exactly as the
 * live app does. Same candles, same rules, one difference, so the comparison
 * measures learning rather than luck.
 */
export async function runBacktestJob(options: BacktestJobOptions): Promise<BacktestJobResult> {
  const { candles, coverage } = await downloadHistory(options);

  if (candles.length < 500) {
    throw new Error(
      coverage.message ||
        'The provider returned too little history to replay. Check the market data key and try again.'
    );
  }

  const control = await replay(candles, options, false, 'control', 45, 27);
  const adaptive = await replay(candles, options, true, 'adaptive', 72, 27);

  options.onProgress?.({ phase: 'done', label: 'Backtest complete.', percent: 100 });

  return {
    coverage,
    control,
    adaptive,
    controlStats: summariseTrades(control.trades, options.equity),
    adaptiveStats: summariseTrades(adaptive.trades, options.equity),
    comparison: compareRuns(control, adaptive),
    phases: comparePhases(adaptive),
    ranAt: new Date().toISOString(),
  };
}

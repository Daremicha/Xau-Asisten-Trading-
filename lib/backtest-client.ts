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
  assessAdoption,
  assessFloors,
  confirmFloor,
  FLOOR_CHOICES,
  type FloorCheck,
  assessProtection,
  compareRuns,
  comparePhases,
  summariseTrades,
  type AdoptionVerdict,
  type ProtectionVerdict,
  type LearningComparison,
  type PhaseComparison,
  type BacktestStats,
} from './backtest-stats';
import { normalisePrior } from './learning-engine';
import { fromWire, mergeCandles, INTERVAL_MS, type HistoryInterval } from './history-feed';
import { historicalHighImpactEvents } from './historical-calendar';
import { AccountType, BrokerId, TradingStyle, type ForexFactoryEvent } from './types';

/** Average days in a month, so "24 months" means two calendar years of data. */
const DAYS_PER_MONTH = 30.44;
/** Hard ceiling on download pages, so a misbehaving provider cannot loop forever. */
const MAX_PAGES = 30;
/**
 * How far a trade must travel in profit before its stop moves to entry.
 *
 * A full R: the trade has already paid once what it was risking, which is the
 * earliest point at which "do not let this become a loss" is a statement about
 * the trade rather than about nerves.
 */
const BREAK_EVEN_AT_R = 1;
/** Retries per page when the provider is rate limiting. */
const MAX_RATE_LIMIT_RETRIES = 3;

export type BacktestPhase = 'download' | 'control' | 'adaptive' | 'frozen' | 'protected' | 'floor' | 'done';

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
  /** A conviction band refused outright, when the user has turned one on. */
  skipConvictionBand?: { min: number; max: number } | null;
  /** The user's daily loss limit in percent, applied to every pass. Zero or null is off. */
  dailyLossLimitPercent?: number | null;
  /** A single target at 0.5R, when the user turned the quick target on. */
  quickTarget?: boolean;
  /** Releases the replay reacts to. Fetched by the job when left out. */
  economicEvents?: ForexFactoryEvent[];
  onProgress?: (update: BacktestProgressUpdate) => void;
  signal?: AbortSignal;
}

export interface BacktestJobResult {
  coverage: BacktestCoverage;
  /** What the replay knew about scheduled releases. */
  news: BacktestNews;
  control: BacktestResult;
  adaptive: BacktestResult;
  /**
   * The same period traded with the learning run's final parameters held fixed
   * from the first candle. This is what adopting them would actually have done,
   * as opposed to the path the learning run took to reach them.
   */
  frozen: BacktestResult;
  /**
   * The control's setups again, traded with the stop moved to entry once each
   * one was a full R in profit. Same decisions, one management rule, so the
   * difference measures the rule rather than a different strategy.
   */
  guarded: BacktestResult;
  controlStats: BacktestStats;
  adaptiveStats: BacktestStats;
  frozenStats: BacktestStats;
  guardedStats: BacktestStats;
  comparison: LearningComparison;
  /**
   * Whether putting the learned parameters on a live account is an improvement
   * this period supports. The adopt button is enabled only when it is.
   */
  adoption: AdoptionVerdict;
  /** Whether protecting a trade at break-even is worth doing on live setups. */
  protection: ProtectionVerdict;
  phases: PhaseComparison;
  /**
   * The recommended conviction floor, traded for real. Null when no floor
   * above the one this run used was recommended. Absent on older results.
   */
  floorCheck?: FloorCheck | null;
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

export interface BacktestNews {
  /** USD high impact releases inside the replayed period. */
  releases: number;
  /** How many of those came from the live calendar archive. */
  archived: number;
}

/**
 * The calendar for the replay. When it cannot be fetched, the checked history
 * shipped with the app is used on its own, so a run never silently has no news.
 */
async function downloadCalendar(signal?: AbortSignal): Promise<ForexFactoryEvent[]> {
  try {
    const res = await fetch('/api/backtest/calendar', { signal });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.success && Array.isArray(data.events)) return data.events as ForexFactoryEvent[];
  } catch {
    assertLive(signal);
  }
  return historicalHighImpactEvents();
}

export function describeNews(events: ForexFactoryEvent[], coverage: BacktestCoverage): BacktestNews {
  const inside = (e: ForexFactoryEvent) => {
    const t = Date.parse(e.scheduledTimestamp);
    return coverage.from !== null && coverage.to !== null && t >= coverage.from && t <= coverage.to;
  };
  const high = events.filter((e) => e.currency === 'USD' && e.impact === 'High' && inside(e));
  return { releases: high.length, archived: high.filter((e) => e.id.startsWith('arch-')).length };
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
  span: number,
  startingPrior: Parameters<typeof createBacktest>[0]['startingPrior'] = null,
  breakEvenAtR: number | null = null
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
    skipConvictionBand: options.skipConvictionBand ?? null,
    adaptive,
    startingPrior,
    breakEvenAtR,
    economicEvents: options.economicEvents,
    dailyLossLimitPercent: options.dailyLossLimitPercent ?? null,
    // The live app trades it for Intraday when the balance allows, so the
    // replay does too.
    londonBreakout: true,
    quickTarget: options.quickTarget ?? false,
  });

  let guard = 0;
  for (;;) {
    assertLive(options.signal);
    const progress = run.step(20);
    if (progress.done || guard > 100_000) break;
    guard += 1;

    const share = progress.totalBars > 0 ? progress.barsProcessed / progress.totalBars : 1;
    const name =
      phase === 'frozen'
        ? 'Testing the learned parameters'
        : phase === 'protected'
          ? 'Testing the break-even stop'
          : phase === 'floor'
            ? 'Testing the recommended floor'
          : adaptive
            ? 'Learning run'
            : 'Control run';
    options.onProgress?.({
      phase,
      label: `${name}: ${progress.trades} trades from ${progress.decisions} analyses.`,
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

  options = { ...options, economicEvents: options.economicEvents ?? (await downloadCalendar(options.signal)) };
  const news = describeNews(options.economicEvents ?? [], coverage);

  const control = await replay(candles, options, false, 'control', 40, 15);
  const adaptive = await replay(candles, options, true, 'adaptive', 55, 15);

  // A third pass, so the adopt button rests on evidence rather than on the
  // endpoint of a path that was never traded as a configuration.
  const frozen = await replay(
    candles,
    options,
    false,
    'frozen',
    70,
    15,
    normalisePrior(adaptive.finalWeights)
  );

  // A fourth pass over the control's own setups, managed differently: the stop
  // moves to entry once the trade is a full R up. It answers the question a run
  // of stop outs always raises, with this period's own trades.
  const guarded = await replay(candles, options, false, 'protected', 85, 7, null, BREAK_EVEN_AT_R);

  // A fifth pass, only when a stricter floor is recommended: the estimate
  // drops trades from this run, but a run with the floor takes different ones,
  // and only trading it says whether the recommendation is real.
  const verdict = assessFloors(control.trades, options.equity, FLOOR_CHOICES, options.accountType);
  const estimate = verdict.floors.find((f) => f.floor === verdict.recommended);
  let floorCheck: FloorCheck | null = null;
  if (estimate && verdict.recommended > (options.minConviction ?? 0)) {
    const floorRun = await replay(
      candles,
      { ...options, minConviction: verdict.recommended },
      false,
      'floor',
      92,
      7
    );
    floorCheck = confirmFloor(estimate, floorRun);
  }

  options.onProgress?.({ phase: 'done', label: 'Backtest complete.', percent: 100 });

  return {
    coverage,
    news,
    control,
    adaptive,
    frozen,
    guarded,
    controlStats: summariseTrades(control.trades, options.equity),
    adaptiveStats: summariseTrades(adaptive.trades, options.equity),
    frozenStats: summariseTrades(frozen.trades, options.equity),
    guardedStats: summariseTrades(guarded.trades, options.equity),
    comparison: compareRuns(control, adaptive),
    adoption: assessAdoption(control, frozen),
    protection: assessProtection(control, guarded),
    phases: comparePhases(adaptive),
    floorCheck,
    ranAt: new Date().toISOString(),
  };
}

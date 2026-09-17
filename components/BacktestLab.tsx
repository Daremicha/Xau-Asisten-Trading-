'use client';

import React, { useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  History,
  Loader2,
  Play,
  Square,
  TrendingDown,
  TrendingUp,
  Sparkles,
} from 'lucide-react';
import { runBacktestJob, type BacktestJobResult, type BacktestProgressUpdate } from '@/lib/backtest-client';
import type { HistoryInterval } from '@/lib/history-feed';
import { formatAccountMoney } from '@/lib/account-display';
import {
  assessAdoption,
  convictionBreakdown,
  netAboveThreshold,
  rollingWinRate,
} from '@/lib/backtest-stats';
import { normalisePrior, type PriorWeights } from '@/lib/learning-engine';
import { AccountType, BrokerId, TradingStyle } from '@/lib/types';

interface BacktestLabProps {
  tradingStyle: TradingStyle;
  accountType: AccountType;
  brokerId: BrokerId;
  equity: number;
  riskPercentage: number;
  /** The last run, held by the page so it survives a tab switch. */
  result: BacktestJobResult | null;
  onResult: (result: BacktestJobResult | null) => void;
  /** Parameters currently adopted from a backtest, if any. */
  adoptedPrior: PriorWeights | null;
  onAdoptPrior: (weights: PriorWeights | null) => void;
  theme?: 'dark' | 'light';
}

const MONTH_CHOICES = [6, 12, 24];
/** Conviction floors offered: off, then the three band boundaries. */
const QUALITY_CHOICES = [0, 40, 55, 70];

function formatDate(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

export default function BacktestLab({
  tradingStyle,
  accountType,
  brokerId,
  equity,
  riskPercentage,
  result,
  onResult,
  adoptedPrior,
  onAdoptPrior,
  theme = 'dark',
}: BacktestLabProps) {
  const isDark = theme === 'dark';
  const [months, setMonths] = useState<number>(24);
  const [interval, setInterval] = useState<HistoryInterval>('15min');
  const [minConviction, setMinConviction] = useState<number>(0);
  const [progress, setProgress] = useState<BacktestProgressUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleRun = async () => {
    setError(null);
    setRunning(true);
    setProgress({ phase: 'download', label: 'Requesting history from the data provider…', percent: 2 });
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const job = await runBacktestJob({
        months,
        interval,
        tradingStyle,
        accountType,
        brokerId,
        equity,
        riskPercentage,
        minConviction,
        signal: controller.signal,
        onProgress: setProgress,
      });
      onResult(job);
    } catch (err) {
      onResult(null);
      setError(err instanceof Error ? err.message : 'The backtest could not be completed.');
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setProgress(null);
  };

  /**
   * Both balances on a shared calendar axis.
   *
   * Plotting them against trade number would compare different dates to each
   * other: the two runs do not take the same number of trades. Each series
   * carries its last balance forward until its next trade closes, so any point
   * on the chart compares the two accounts on the same day.
   */
  const curveData = useMemo(() => {
    if (!result) return [];
    const controlCurve = result.control.equityCurve;
    const learningCurveData = result.adaptive.equityCurve;
    const frozenCurve = result.frozen.equityCurve;
    const times = Array.from(
      new Set([
        ...controlCurve.map((p) => p.time),
        ...learningCurveData.map((p) => p.time),
        ...frozenCurve.map((p) => p.time),
      ])
    ).sort((a, b) => a - b);

    let ci = 0;
    let ai = 0;
    let fi = 0;
    let controlEquity = result.control.summary.startingEquity;
    let learningEquity = result.adaptive.summary.startingEquity;
    let frozenEquity = result.frozen.summary.startingEquity;

    return times.map((time) => {
      while (ci < controlCurve.length && controlCurve[ci].time <= time) {
        controlEquity = controlCurve[ci].equity;
        ci += 1;
      }
      while (ai < learningCurveData.length && learningCurveData[ai].time <= time) {
        learningEquity = learningCurveData[ai].equity;
        ai += 1;
      }
      while (fi < frozenCurve.length && frozenCurve[fi].time <= time) {
        frozenEquity = frozenCurve[fi].equity;
        fi += 1;
      }
      return { time, control: controlEquity, learning: learningEquity, frozen: frozenEquity };
    });
  }, [result]);

  const learningCurve = useMemo(
    () => (result ? rollingWinRate(result.adaptive.trades, 20) : []),
    [result]
  );

  /**
   * Which conviction bands paid for themselves, measured on the fixed
   * parameter run because that is the configuration a live account would use.
   */
  const quality = useMemo(() => {
    if (!result) return null;
    const buckets = convictionBreakdown(result.control.trades);
    const floors = QUALITY_CHOICES.map((floor) => ({
      floor,
      net: netAboveThreshold(result.control.trades, floor),
      trades: result.control.trades.filter((t) => t.filled && t.convictionScore >= floor).length,
    }));
    const best = floors.reduce((a, b) => (b.net > a.net ? b : a), floors[0]);
    return { buckets, floors, best };
  }, [result]);

  const money = (value: number, signed = false) => formatAccountMoney(value, accountType, { signed });

  /**
   * The single decision behind the adopt button: is putting these parameters on
   * a live account an improvement this period actually supports? The button is
   * enabled only when the answer is yes, so being able to press it means
   * something rather than inviting a judgement call.
   */
  const adoption = useMemo(
    () => (result ? assessAdoption(result.control, result.frozen) : null),
    [result]
  );

  const panel = isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const strong = isDark ? 'text-slate-100' : 'text-slate-900';

  return (
    <div
      id="backtest-lab-card"
      className={`${
        isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-sm'
      } border rounded-2xl p-5 transition-colors`}
    >
      <div
        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b ${
          isDark ? 'border-slate-800' : 'border-slate-100'
        } pb-4 mb-4`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 shrink-0">
            <FlaskConical className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className={`text-base font-bold flex items-center gap-2 flex-wrap ${strong}`}>
              Strategy Backtest Lab
              {adoptedPrior && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                  Backtested parameters live
                </span>
              )}
            </h2>
            <p className={`text-xs ${muted}`}>
              Replays the live engine over real history, trades it twice, and measures whether learning
              from each result made the later signals better.
            </p>
          </div>
        </div>
      </div>

      {/* Run configuration */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div className={`border rounded-xl p-3 ${panel}`}>
          <div className={`text-[11px] mb-1.5 ${muted}`}>History to replay</div>
          <div className="flex gap-1.5">
            {MONTH_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                id={`backtest-months-${choice}`}
                disabled={running}
                onClick={() => setMonths(choice)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold border transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                  months === choice
                    ? 'bg-sky-500/15 border-sky-500/60 text-sky-400'
                    : isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900'
                }`}
              >
                {choice} mo
              </button>
            ))}
          </div>
        </div>

        <div className={`border rounded-xl p-3 ${panel}`}>
          <div className={`text-[11px] mb-1.5 ${muted}`}>Execution timeframe</div>
          <div className="flex gap-1.5">
            {(['15min', '1h'] as HistoryInterval[]).map((choice) => (
              <button
                key={choice}
                type="button"
                id={`backtest-interval-${choice}`}
                disabled={running}
                onClick={() => setInterval(choice)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold border transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                  interval === choice
                    ? 'bg-sky-500/15 border-sky-500/60 text-sky-400'
                    : isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900'
                }`}
              >
                {choice === '15min' ? 'M15 base' : 'H1 base'}
              </button>
            ))}
          </div>
          <p className={`text-[10px] mt-1.5 ${muted}`}>
            Structure is always read M15 → H1 → H4 → D1. This is the candle fills and exits are measured on.
          </p>
        </div>

        <div className={`border rounded-xl p-3 ${panel}`}>
          <div className={`text-[11px] mb-1.5 ${muted}`}>Only trade conviction above</div>
          <div className="flex gap-1.5">
            {QUALITY_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                id={`backtest-quality-${choice}`}
                disabled={running}
                onClick={() => setMinConviction(choice)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold border transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                  minConviction === choice
                    ? 'bg-sky-500/15 border-sky-500/60 text-sky-400'
                    : isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900'
                }`}
              >
                {choice === 0 ? 'All' : choice}
              </button>
            ))}
          </div>
          <p className={`text-[10px] mt-1.5 ${muted}`}>
            Skipping a weak setup costs nothing. The breakdown below shows which bands paid.
          </p>
        </div>

        <div className={`border rounded-xl p-3 flex flex-col justify-between ${panel}`}>
          <div className={`text-[11px] ${muted}`}>
            {tradingStyle} • {accountType} • {money(equity)} • {riskPercentage}% risk
          </div>
          {running ? (
            <button
              type="button"
              id="backtest-cancel-btn"
              onClick={handleCancel}
              className="mt-2 w-full flex items-center justify-center gap-1.5 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs px-3 py-2 rounded-xl transition-all active:scale-95 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              id="run-backtest-btn"
              onClick={handleRun}
              className="mt-2 w-full flex items-center justify-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs px-3 py-2 rounded-xl transition-all active:scale-95 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Run {months} month backtest</span>
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      {running && progress && (
        <div className={`border rounded-xl p-3 mb-4 ${panel}`}>
          <div className={`flex items-center gap-2 text-xs ${strong}`}>
            <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
            <span className="truncate">{progress.label}</span>
          </div>
          <div className={`mt-2 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
            <div
              className="h-full bg-sky-500 rounded-full transition-all"
              style={{ width: `${Math.max(2, Math.min(100, progress.percent))}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="border border-rose-500/40 bg-rose-500/10 text-rose-400 rounded-xl p-3 mb-4 text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {!result && !running && !error && (
        <div className={`border rounded-xl p-6 text-center text-xs ${panel} ${muted}`}>
          Nothing has been replayed yet. A 24 month run downloads real XAUUSD candles, produces a setup
          the same way the live engine does at every decision point, and settles each one against the
          candles that actually followed it.
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {/* Coverage */}
          <div className={`border rounded-xl p-3 text-xs ${panel}`}>
            <div className="flex items-center gap-1.5 mb-1">
              <History className={`w-3.5 h-3.5 ${muted}`} />
              <span className={strong}>
                {formatDate(result.coverage.from)} → {formatDate(result.coverage.to)} •{' '}
                {result.coverage.bars.toLocaleString('en-US')} candles • {result.coverage.monthsCovered} months
              </span>
            </div>
            <p className={muted}>
              {result.control.summary.minConviction > 0 &&
                `Only setups scoring ${result.control.summary.minConviction} or above were traded; ${result.control.summary.belowConviction.toLocaleString(
                  'en-US'
                )} were refused. `}
              Source: {result.coverage.provider ?? 'unknown'}.{' '}
              {result.coverage.complete
                ? 'The provider supplied the whole period requested.'
                : `The provider stopped short of the ${result.coverage.requestedMonths} months requested, so the result covers ${result.coverage.monthsCovered} months.`}
              {!result.coverage.complete &&
                result.coverage.interval === '15min' &&
                ' Yahoo only serves sixty days of fifteen minute candles. For a longer replay, set a Twelve Data key or switch to the H1 base.'}
            </p>
          </div>

          {/* The verdict */}
          <div
            className={`border rounded-xl p-4 ${
              result.comparison.verdict === 'better'
                ? 'border-emerald-500/40 bg-emerald-500/10'
                : result.comparison.verdict === 'worse'
                ? 'border-rose-500/40 bg-rose-500/10'
                : isDark
                ? 'border-slate-800 bg-slate-950'
                : 'border-slate-200 bg-slate-50'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              {result.comparison.verdict === 'better' ? (
                <TrendingUp className="w-4 h-4 text-emerald-400" />
              ) : result.comparison.verdict === 'worse' ? (
                <TrendingDown className="w-4 h-4 text-rose-400" />
              ) : (
                <Activity className={`w-4 h-4 ${muted}`} />
              )}
              <h3 className={`text-sm font-bold ${strong}`}>
                {result.comparison.verdict === 'better'
                  ? 'Learning improved the results'
                  : result.comparison.verdict === 'worse'
                  ? 'Learning did not pay over this period'
                  : 'Learning made no measurable difference'}
              </h3>
            </div>
            <p className={`text-xs ${muted}`}>
              <span className={strong}>Against the control: </span>
              {result.comparison.explanation}
            </p>
            <p className={`text-xs mt-1 ${muted}`}>
              <span className={strong}>Within the learning run: </span>
              {result.phases.explanation}
            </p>
            <p className={`text-xs mt-1 ${muted}`}>
              <span className={strong}>If you adopt its parameters: </span>
              {adoption?.reason}
            </p>
          </div>

          {/* Side by side */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={muted}>
                  <th className="text-left font-medium py-1.5">Measure</th>
                  <th className="text-right font-medium py-1.5">Fixed parameters</th>
                  <th className="text-right font-medium py-1.5">Learning from results</th>
                  <th className="text-right font-medium py-1.5">Learned, held fixed</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {[
                  {
                    label: 'Signals produced',
                    control: result.controlStats.totalSignals.toString(),
                    adaptive: result.adaptiveStats.totalSignals.toString(),
                    frozen: result.frozenStats.totalSignals.toString(),
                  },
                  {
                    label: 'Orders filled',
                    control: `${result.controlStats.filled} (${result.controlStats.missRate ?? 0}% missed)`,
                    adaptive: `${result.adaptiveStats.filled} (${result.adaptiveStats.missRate ?? 0}% missed)`,
                    frozen: `${result.frozenStats.filled} (${result.frozenStats.missRate ?? 0}% missed)`,
                  },
                  {
                    label: 'Win rate',
                    control: result.controlStats.winRate === null ? '—' : `${result.controlStats.winRate}%`,
                    adaptive: result.adaptiveStats.winRate === null ? '—' : `${result.adaptiveStats.winRate}%`,
                    frozen: result.frozenStats.winRate === null ? '—' : `${result.frozenStats.winRate}%`,
                  },
                  {
                    label: 'Net result',
                    control: money(result.controlStats.netDollars, true),
                    adaptive: money(result.adaptiveStats.netDollars, true),
                    frozen: money(result.frozenStats.netDollars, true),
                  },
                  {
                    label: 'Return on balance',
                    control: `${result.controlStats.returnPercent}%`,
                    adaptive: `${result.adaptiveStats.returnPercent}%`,
                    frozen: `${result.frozenStats.returnPercent}%`,
                  },
                  {
                    label: 'Profit factor',
                    control: result.controlStats.profitFactor?.toFixed(2) ?? '—',
                    adaptive: result.adaptiveStats.profitFactor?.toFixed(2) ?? '—',
                    frozen: result.frozenStats.profitFactor?.toFixed(2) ?? '—',
                  },
                  {
                    label: 'Average per trade',
                    control:
                      result.controlStats.expectancyDollars === null
                        ? '—'
                        : money(result.controlStats.expectancyDollars, true),
                    adaptive:
                      result.adaptiveStats.expectancyDollars === null
                        ? '—'
                        : money(result.adaptiveStats.expectancyDollars, true),
                    frozen:
                      result.frozenStats.expectancyDollars === null
                        ? '—'
                        : money(result.frozenStats.expectancyDollars, true),
                  },
                  {
                    label: 'Worst drawdown',
                    control: `${result.controlStats.maxDrawdownPercent}%`,
                    adaptive: `${result.adaptiveStats.maxDrawdownPercent}%`,
                    frozen: `${result.frozenStats.maxDrawdownPercent}%`,
                  },
                  {
                    label: 'Longest losing run',
                    control: `${result.controlStats.worstLosingStreak}`,
                    adaptive: `${result.adaptiveStats.worstLosingStreak}`,
                    frozen: `${result.frozenStats.worstLosingStreak}`,
                  },
                ].map((row) => (
                  <tr key={row.label} className={isDark ? 'border-t border-slate-800' : 'border-t border-slate-100'}>
                    <td className={`py-1.5 font-sans ${muted}`}>{row.label}</td>
                    <td className={`py-1.5 text-right ${strong}`}>{row.control}</td>
                    <td className="py-1.5 text-right font-bold text-sky-400">{row.adaptive}</td>
                    <td className="py-1.5 text-right font-bold text-amber-400">{row.frozen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Equity curves */}
          {curveData.length > 1 && (
            <div className={`border rounded-xl p-3 ${panel}`}>
              <div className={`text-xs mb-2 ${strong}`}>
                Balance through the period, all three runs on the same dates
              </div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={curveData} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="btLearning" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#1e293b' : '#e2e8f0'} />
                    <XAxis
                      dataKey="time"
                      type="number"
                      scale="time"
                      domain={['dataMin', 'dataMax']}
                      stroke={isDark ? '#64748b' : '#94a3b8'}
                      fontSize={10}
                      tickLine={false}
                      minTickGap={48}
                      tickFormatter={(value: number) => formatDate(value)}
                    />
                    <YAxis
                      stroke={isDark ? '#64748b' : '#94a3b8'}
                      fontSize={10}
                      tickLine={false}
                      domain={['auto', 'auto']}
                      tickFormatter={(value: number) => formatAccountMoney(value, accountType, { decimals: 0 })}
                    />
                    <Tooltip
                      contentStyle={{
                        background: isDark ? '#0f172a' : '#ffffff',
                        border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
                        borderRadius: 12,
                        fontSize: 11,
                      }}
                      labelFormatter={(value) => formatDate(Number(value))}
                      formatter={(value) =>
                        typeof value === 'number' ? formatAccountMoney(value, accountType) : '—'
                      }
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Area
                      type="monotone"
                      dataKey="control"
                      name="Fixed parameters"
                      stroke={isDark ? '#94a3b8' : '#64748b'}
                      strokeWidth={1.8}
                      fill="none"
                      dot={false}
                      connectNulls
                    />
                    <Area
                      type="monotone"
                      dataKey="learning"
                      name="Learning from results"
                      stroke="#0ea5e9"
                      strokeWidth={2.2}
                      fill="url(#btLearning)"
                      dot={false}
                      connectNulls
                    />
                    <Area
                      type="monotone"
                      dataKey="frozen"
                      name="Learned, held fixed"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      strokeDasharray="4 3"
                      fill="none"
                      dot={false}
                      connectNulls
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Did the later half trade better */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className={`border rounded-xl p-3 text-xs ${panel}`}>
              <div className={`mb-2 ${strong}`}>First half of the learning run</div>
              <div className={`font-mono ${muted}`}>
                {result.phases.firstHalf.filled} filled • {result.phases.firstHalf.winRate ?? '—'}% won •{' '}
                {result.phases.firstHalf.expectancyDollars === null
                  ? '—'
                  : money(result.phases.firstHalf.expectancyDollars, true)}{' '}
                per trade
              </div>
            </div>
            <div className={`border rounded-xl p-3 text-xs ${panel}`}>
              <div className={`mb-2 ${strong}`}>Second half, after learning from the first</div>
              <div className="font-mono text-sky-400">
                {result.phases.secondHalf.filled} filled • {result.phases.secondHalf.winRate ?? '—'}% won •{' '}
                {result.phases.secondHalf.expectancyDollars === null
                  ? '—'
                  : money(result.phases.secondHalf.expectancyDollars, true)}{' '}
                per trade
              </div>
            </div>
          </div>

          {learningCurve.length > 2 && (
            <div className={`border rounded-xl p-3 ${panel}`}>
              <div className={`text-xs mb-2 ${strong}`}>Strike rate over the last twenty trades</div>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={learningCurve} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#1e293b' : '#e2e8f0'} />
                    <XAxis
                      dataKey="sequence"
                      stroke={isDark ? '#64748b' : '#94a3b8'}
                      fontSize={10}
                      tickLine={false}
                      minTickGap={40}
                    />
                    <YAxis
                      stroke={isDark ? '#64748b' : '#94a3b8'}
                      fontSize={10}
                      tickLine={false}
                      domain={[0, 100]}
                      tickFormatter={(v: number) => `${v}%`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: isDark ? '#0f172a' : '#ffffff',
                        border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
                        borderRadius: 12,
                        fontSize: 11,
                      }}
                      formatter={(value) => `${value ?? '—'}%`}
                    />
                    <Area type="monotone" dataKey="winRate" stroke="#10b981" strokeWidth={2} fill="none" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Which setups were worth taking */}
          {quality && (
            <div className={`border rounded-xl p-3 ${panel}`}>
              <div className={`text-xs mb-2 ${strong}`}>
                Which conviction bands paid, on the fixed parameter run
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className={muted}>
                      <th className="text-left font-medium py-1">Conviction</th>
                      <th className="text-right font-medium py-1">Signals</th>
                      <th className="text-right font-medium py-1">Filled</th>
                      <th className="text-right font-medium py-1">Won</th>
                      <th className="text-right font-medium py-1">Per trade</th>
                      <th className="text-right font-medium py-1">Net</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {quality.buckets.map((bucket) => (
                      <tr
                        key={bucket.label}
                        className={isDark ? 'border-t border-slate-800' : 'border-t border-slate-100'}
                      >
                        <td className={`py-1 font-sans ${muted}`}>{bucket.label}</td>
                        <td className={`py-1 text-right ${muted}`}>{bucket.signals}</td>
                        <td className={`py-1 text-right ${muted}`}>{bucket.filled}</td>
                        <td className={`py-1 text-right ${strong}`}>
                          {bucket.winRate === null ? '—' : `${bucket.winRate}%`}
                        </td>
                        <td
                          className={`py-1 text-right ${
                            bucket.expectancyDollars === null
                              ? muted
                              : bucket.expectancyDollars > 0
                              ? 'text-emerald-400'
                              : 'text-rose-400'
                          }`}
                        >
                          {bucket.expectancyDollars === null ? '—' : money(bucket.expectancyDollars, true)}
                        </td>
                        <td
                          className={`py-1 text-right font-bold ${
                            bucket.netDollars > 0 ? 'text-emerald-400' : bucket.netDollars < 0 ? 'text-rose-400' : muted
                          }`}
                        >
                          {money(bucket.netDollars, true)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className={`mt-2 text-[11px] leading-relaxed ${muted}`}>
                Refusing everything below a floor would have left:{' '}
                {quality.floors.map((f, i) => (
                  <span key={f.floor}>
                    {i > 0 && ' • '}
                    <span className={f.floor === quality.best.floor ? 'text-emerald-400 font-bold' : ''}>
                      {f.floor === 0 ? 'all setups' : `${f.floor}+`} {money(f.net, true)} from {f.trades} trades
                    </span>
                  </span>
                ))}
                .{' '}
                {quality.best.floor === 0
                  ? 'Taking everything was the best of these over this period, so a floor would not have helped.'
                  : `A floor of ${quality.best.floor} was the best of these over this period. Set it above and re-run to trade it properly, with compounding and position sizing applied.`}
              </div>
            </div>
          )}

          {/* What the run learned, and adopting it */}
          <div className={`border rounded-xl p-3 ${panel}`}>
            <div className={`text-xs mb-2 flex items-center gap-1.5 ${strong}`}>
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              Parameters the learning run ended on
            </div>
            <div className={`grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-[11px] ${muted}`}>
              <div>Order block: <span className={strong}>{result.adaptive.finalWeights.orderBlockWeight}</span></div>
              <div>Fair value gap: <span className={strong}>{result.adaptive.finalWeights.fairValueGapWeight}</span></div>
              <div>Liquidity: <span className={strong}>{result.adaptive.finalWeights.liquiditySweepWeight}</span></div>
              <div>News shield: <span className={strong}>{result.adaptive.finalWeights.newsImpactWeight}</span></div>
              <div>Indicators: <span className={strong}>{result.adaptive.finalWeights.indicatorConfluenceWeight}</span></div>
              <div>Stop buffer: <span className={strong}>{result.adaptive.finalWeights.atrBufferFactor}× ATR</span></div>
              <div>Entry pulled closer: <span className={strong}>{result.adaptive.finalWeights.entryBufferPips ?? 0} pips</span></div>
            </div>

            <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
              <button
                type="button"
                id="adopt-backtest-prior-btn"
                onClick={() => onAdoptPrior(normalisePrior(result.adaptive.finalWeights))}
                disabled={!adoption?.worthAdopting}
                className="flex items-center justify-center gap-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-bold text-xs px-3 py-2 rounded-xl transition-all active:scale-95 cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Use these as the live starting parameters</span>
              </button>
              {adoptedPrior && (
                <button
                  type="button"
                  id="clear-backtest-prior-btn"
                  onClick={() => onAdoptPrior(null)}
                  className={`text-xs px-3 py-2 rounded-xl border transition-all cursor-pointer ${
                    isDark
                      ? 'border-slate-800 text-slate-400 hover:text-slate-200'
                      : 'border-slate-200 text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Back to engine defaults
                </button>
              )}
            </div>
            <p
              className={`text-[11px] mt-2 ${
                adoption?.worthAdopting ? 'text-emerald-400' : muted
              }`}
            >
              {adoption?.reason}
            </p>
            <p className={`text-[11px] mt-1 ${muted}`}>
              The button is enabled only when adopting is an improvement this period supports, so if
              you can press it, pressing it is the right call. Otherwise your current settings are
              already the better ones.
            </p>
            {adoptedPrior && (
              <p className="text-[11px] mt-2 text-emerald-400">
                Live analysis is starting from backtested parameters and keeps learning from your real
                trades on top of them.
              </p>
            )}
          </div>

          {/* Last trades */}
          {result.adaptive.trades.length > 0 && (
            <div className={`border rounded-xl p-3 ${panel}`}>
              <div className={`text-xs mb-2 ${strong}`}>Last ten trades of the learning run</div>
              <div className="space-y-1 font-mono text-[11px]">
                {result.adaptive.trades.slice(-10).reverse().map((trade) => (
                  <div
                    key={trade.sequence}
                    className={`flex items-center justify-between gap-2 py-1 ${
                      isDark ? 'border-b border-slate-800/60' : 'border-b border-slate-100'
                    }`}
                  >
                    <span className={muted}>{formatDate(trade.openedAt)}</span>
                    <span className={strong}>{trade.orderType}</span>
                    <span className={muted}>
                      {trade.entryPrice.toFixed(2)} → {trade.filled ? trade.exitPrice.toFixed(2) : 'no fill'}
                    </span>
                    <span
                      className={
                        !trade.filled ? 'text-amber-400' : trade.netDollars > 0 ? 'text-emerald-400' : 'text-rose-400'
                      }
                    >
                      {trade.filled ? money(trade.netDollars, true) : 'missed'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* What this test does and does not prove */}
          <div className={`border rounded-xl p-3 text-[11px] leading-relaxed ${panel} ${muted}`}>
            <span className={strong}>How to read this.</span> Every decision saw only the candles that had
            printed at that moment. When one candle contained both the stop and the target the stop was
            taken, because the order inside a bar cannot be recovered from its open, high, low and close.
            Spread is charged on every fill, and commission where the account charges it. Historical
            economic releases are not available to the app, so the news shield was inactive for the whole
            replay. Slippage, weekend gaps in execution and swap are not modelled. Position size is a
            fixed percentage of the running balance, so a winning stretch compounds and the later trades
            dominate the total. Past results are evidence about parameters, not a promise about the next
            trade. The third column freezes the learning run&apos;s final parameters from the first candle,
            because the weights it ended on are the end of a path rather than a configuration that was ever
            traded as such. When that column does win and the adopt button opens, a period is still a single
            sample: running the same test at 12 months, or on the other base timeframe, and seeing it win
            there too is what separates a real improvement from a fit to one stretch of chart.
          </div>
        </div>
      )}
    </div>
  );
}

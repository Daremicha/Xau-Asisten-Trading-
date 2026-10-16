'use client';

import { factorLabel } from '@/lib/factor-labels';
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
  ShieldCheck,
  Ban,
} from 'lucide-react';
import {
  runBacktestJob,
  runWalkForwardJob,
  type BacktestJobResult,
  type BacktestProgressUpdate,
} from '@/lib/backtest-client';
import type { HistoryInterval } from '@/lib/history-feed';
import { formatAccountMoney } from '@/lib/account-display';
import {
  assessAdoption,
  assessDeadBand,
  assessProtection,
  assessRiskFloor,
  convictionBreakdown,
  assessFloors,
  FLOOR_CHOICES,
  rollingWinRate,
} from '@/lib/backtest-stats';
import { normalisePrior, type PriorWeights } from '@/lib/learning-engine';
import { factorReliability, NOISE_BAR_STANDARD_ERRORS } from '@/lib/factor-learning';
import { AccountType, BrokerId, TradingStyle } from '@/lib/types';
import RobustnessCard from '@/components/RobustnessCard';
import type { RResult } from '@/lib/robustness';
import type { WalkForwardResult } from '@/lib/walk-forward';
import { stressCostScenarios, type CostStressReport } from '@/lib/cost-stress';

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
  /**
   * Multiple of risk at which live setups say to move the stop to entry, or
   * null when trades are left to run to the target or the stop as quoted.
   */
  protectStopAtR: number | null;
  onProtectStop: (atR: number | null) => void;
  /** A conviction band live analysis refuses outright, or null when none is. */
  skipConvictionBand: { min: number; max: number } | null;
  /** The daily loss limit live analysis applies, in percent; zero is off. */
  dailyLossLimit: number;
  /** A single target at 0.5R, as the live setups use when it is on. */
  quickTarget?: boolean;
  /** Refuse setups the minimum lot cannot size within the risk, as live analysis does. */
  riskGuard?: boolean;
  onSkipBand: (band: { min: number; max: number } | null) => void;
  theme?: 'dark' | 'light';
}

const MONTH_CHOICES = [6, 12, 24];

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
  protectStopAtR,
  onProtectStop,
  skipConvictionBand,
  dailyLossLimit,
  quickTarget = false,
  riskGuard = false,
  onSkipBand,
  theme = 'dark',
}: BacktestLabProps) {
  const isDark = theme === 'dark';
  const [months, setMonths] = useState<number>(24);
  // Named for what it is rather than `setInterval`, which shadowed the global
  // timer function inside this component and would have turned any future
  // scheduling here into a silent no-op.
  const [executionInterval, setExecutionInterval] = useState<HistoryInterval>('15min');
  const [minConviction, setMinConviction] = useState<number>(0);
  const [progress, setProgress] = useState<BacktestProgressUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [walkRunning, setWalkRunning] = useState(false);
  const [walkProgress, setWalkProgress] = useState<BacktestProgressUpdate | null>(null);
  const [walkResult, setWalkResult] = useState<WalkForwardResult | null>(null);
  const [walkError, setWalkError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleRun = async () => {
    setError(null);
    setRunning(true);
    setProgress({ phase: 'download', label: 'Meminta data historis dari provider…', percent: 2 });
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const job = await runBacktestJob({
        months,
        interval: executionInterval,
        tradingStyle,
        accountType,
        brokerId,
        equity,
        riskPercentage,
        minConviction,
        skipConvictionBand,
        dailyLossLimitPercent: dailyLossLimit,
        quickTarget,
        riskGuard,
        signal: controller.signal,
        onProgress: setProgress,
      });
      onResult(job);
    } catch (err) {
      onResult(null);
      setError(err instanceof Error ? err.message : 'Backtest tidak bisa diselesaikan.');
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setProgress(null);
    setWalkProgress(null);
  };

  const handleWalkForward = async () => {
    setWalkError(null);
    setWalkResult(null);
    setWalkRunning(true);
    setWalkProgress({ phase: 'download', label: 'Meminta data historis untuk walk-forward…', percent: 2 });
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const walk = await runWalkForwardJob({
        months,
        interval: executionInterval,
        tradingStyle,
        accountType,
        brokerId,
        equity,
        riskPercentage,
        minConviction,
        skipConvictionBand,
        dailyLossLimitPercent: dailyLossLimit,
        quickTarget,
        riskGuard,
        signal: controller.signal,
        onProgress: setWalkProgress,
      });
      setWalkResult(walk);
    } catch (err) {
      setWalkError(err instanceof Error ? err.message : 'Validasi walk-forward gagal.');
    } finally {
      setWalkRunning(false);
      abortRef.current = null;
    }
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
    // Judged on return per point of drawdown, not on money alone: on a small
    // account every extra trade is another minimum-lot bet.
    const verdict = assessFloors(
      result.control.trades,
      result.control.summary.startingEquity,
      FLOOR_CHOICES,
      result.control.summary.accountType
    );
    return { buckets, verdict };
  }, [result]);

  /**
   * Each factor over the whole replay, evenly weighted, on the run whose
   * weights never moved, so the votes are the engine's own and not the
   * product of what it had already learned.
   */
  const factorTable = useMemo(
    () =>
      result
        ? factorReliability(result.control.records, Number.POSITIVE_INFINITY).filter(
            (factor) => factor.agreedSamples > 0 && factor.opposedSamples > 0
          )
        : [],
    [result]
  );

  const money = (value: number, signed = false) => formatAccountMoney(value, accountType, { signed });
  const robustResults = useMemo<RResult[]>(
    () =>
      (result?.control.trades ?? [])
        .filter((t) => t.filled)
        .map((t) => ({ openedAt: t.openedAt, rMultiple: t.rMultiple, riskDistance: Math.abs(t.fillPrice - t.stopLoss) })),
    [result]
  );
  const costStress = useMemo<CostStressReport[]>(
    () =>
      result
        ? stressCostScenarios(
            result.control.trades,
            result.control.summary.startingEquity,
            undefined,
            result.economicEvents
          )
        : [],
    [result]
  );

  /**
   * How a switch's button should look and read.
   *
   * A button has three states and only two of them used to be visible: on, and
   * off. A rule already in use rendered exactly like a rule the period refused
   * — both greyed out — so "nothing is lit" meant either "there is nothing to
   * do" or "you already did it", and the user had no way to tell which. The
   * button promises that pressing it is the right call; it has to say as
   * plainly when pressing it is no longer needed.
   */
  const adoptionStress = useMemo<CostStressReport[]>(
    () =>
      result
        ? stressCostScenarios(
            result.frozen.trades,
            result.frozen.summary.startingEquity,
            undefined,
            result.economicEvents
          )
        : [],
    [result]
  );
  const switchState = (inUse: boolean, supported: boolean, colour: 'sky' | 'amber' | 'rose') => {
    if (inUse) {
      return {
        disabled: true,
        label: 'Sudah dipakai di setup live',
        className:
          'flex items-center justify-center gap-1.5 bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 font-bold text-xs px-3 py-2 rounded-xl cursor-default',
      };
    }
    const palette = {
      sky: 'bg-sky-500 hover:bg-sky-400',
      amber: 'bg-amber-500 hover:bg-amber-400',
      rose: 'bg-rose-500 hover:bg-rose-400',
    }[colour];
    return {
      disabled: !supported,
      label: null,
      className: `flex items-center justify-center gap-1.5 ${palette} disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-bold text-xs px-3 py-2 rounded-xl transition-all active:scale-95 cursor-pointer`,
    };
  };

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
  const adoptionGate = useMemo(() => {
    if (!adoption?.worthAdopting) {
      return { allowed: false, reason: 'Backtest penuh belum mendukung adopsi parameter ini.' };
    }
    if (walkResult?.status !== 'complete' || !walkResult.frozenStats) {
      return { allowed: false, reason: 'Jalankan validasi walk-forward sebelum mengadopsi parameter.' };
    }
    if (walkResult.frozenStats.netDollars <= 0) {
      return { allowed: false, reason: 'Parameter kandidat gagal menghasilkan net positif pada test out-of-sample.' };
    }
    const realistic = adoptionStress.find((report) => report.scenario.id === 'realistic-extra-cost');
    const stress = adoptionStress.find((report) => report.scenario.id === 'stress-extra-cost');
    if (!realistic?.profitable || !stress?.profitable) {
      return { allowed: false, reason: 'Parameter kandidat gagal stress cost realistic atau stress.' };
    }
    return { allowed: true, reason: 'Gate lulus: frozen test out-of-sample dan dua stress cost tetap profitable.' };
  }, [adoption, adoptionStress, walkResult]);

  /**
   * The same promise for the management rule: the button turns on only when
   * this period's own trades say moving the stop to entry was the better way to
   * hold them.
   */
  const protection = useMemo(
    () => (result ? assessProtection(result.control, result.guarded) : null),
    [result]
  );

  /**
   * Whether the risk percentage meant anything on this balance. On a small
   * account the broker's minimum lot can sit above it, and then two different
   * risk settings produce the same trades, which is worth saying out loud.
   */
  const riskFloor = useMemo(() => (result ? assessRiskFloor(result.control) : null), [result]);

  /**
   * Whether one conviction band is bad enough to refuse outright. A floor
   * assumes the score is a ladder; on this engine it is not, so the narrower
   * instrument is the honest one — guarded by the band having lost in both
   * halves of the period rather than in one bad stretch.
   */
  const deadBand = useMemo(() => (result ? assessDeadBand(result.control) : null), [result]);

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
              Lab Backtest Strategi
              {adoptedPrior && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                  Parameter hasil backtest aktif
                </span>
              )}
            </h2>
            <p className={`text-xs ${muted}`}>
              Menjalankan ulang engine live di data historis asli, men-trade-nya dua kali, dan mengukur apakah belajar dari setiap hasil membuat sinyal berikutnya lebih baik.
            </p>
          </div>
        </div>
      </div>

      {/* Run configuration */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div className={`border rounded-xl p-3 ${panel}`}>
          <div className={`text-[11px] mb-1.5 ${muted}`}>Panjang data yang diuji</div>
          <div className="flex gap-1.5">
            {MONTH_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                id={`backtest-months-${choice}`}
                disabled={running || walkRunning}
                onClick={() => setMonths(choice)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold border transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                  months === choice
                    ? 'bg-sky-500/15 border-sky-500/60 text-sky-400'
                    : isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900'
                }`}
              >
                {choice} bln
              </button>
            ))}
          </div>
        </div>

        <div className={`border rounded-xl p-3 ${panel}`}>
          <div className={`text-[11px] mb-1.5 ${muted}`}>Timeframe eksekusi</div>
          <div className="flex gap-1.5">
            {(['15min', '1h'] as HistoryInterval[]).map((choice) => (
              <button
                key={choice}
                type="button"
                id={`backtest-interval-${choice}`}
                disabled={running || walkRunning}
                onClick={() => setExecutionInterval(choice)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold border transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                  executionInterval === choice
                    ? 'bg-sky-500/15 border-sky-500/60 text-sky-400'
                    : isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900'
                }`}
              >
                {choice === '15min' ? 'Basis M15' : 'Basis H1'}
              </button>
            ))}
          </div>
          <p className={`text-[10px] mt-1.5 ${muted}`}>
            Struktur selalu dibaca M15 → H1 → H4 → D1. Ini candle yang dipakai untuk mengukur fill dan exit.
          </p>
        </div>

        <div className={`border rounded-xl p-3 ${panel}`}>
          <div className={`text-[11px] mb-1.5 ${muted}`}>Hanya ambil conviction di atas</div>
          <div className="flex gap-1.5">
            {FLOOR_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                id={`backtest-quality-${choice}`}
                disabled={running || walkRunning}
                onClick={() => setMinConviction(choice)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold border transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                  minConviction === choice
                    ? 'bg-sky-500/15 border-sky-500/60 text-sky-400'
                    : isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900'
                }`}
              >
                {choice === 0 ? 'Semua' : choice}
              </button>
            ))}
          </div>
          <p className={`text-[10px] mt-1.5 ${muted}`}>
            Melewatkan setup lemah tidak ada ruginya. Rincian di bawah menunjukkan rentang mana yang untung.
          </p>
        </div>

        <div className={`border rounded-xl p-3 flex flex-col justify-between ${panel}`}>
          <div className={`text-[11px] ${muted}`}>
            {tradingStyle} • {accountType} • {money(equity)} • {riskPercentage}% risiko
          </div>
          {running || walkRunning ? (
            <button
              type="button"
              id="backtest-cancel-btn"
              onClick={handleCancel}
              className="mt-2 w-full flex items-center justify-center gap-1.5 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs px-3 py-2 rounded-xl transition-all active:scale-95 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Hentikan</span>
            </button>
          ) : (
            <div className="mt-2 space-y-1.5">
              <button
                type="button"
                id="run-backtest-btn"
                onClick={handleRun}
                className="w-full flex items-center justify-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs px-3 py-2 rounded-xl transition-all active:scale-95 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Backtest biasa {months} bulan</span>
              </button>
              <button
                type="button"
                id="run-walk-forward-btn"
                onClick={handleWalkForward}
                className="w-full flex items-center justify-center gap-1.5 bg-violet-600 hover:bg-violet-500 text-white font-bold text-xs px-3 py-2 rounded-xl transition-all active:scale-95 cursor-pointer"
              >
                <FlaskConical className="w-3.5 h-3.5" />
                <span>Validasi walk-forward</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* What live analysis is actually using, so it never has to be inferred
          from which buttons happen to be lit. */}
      <div
        id="live-settings-strip"
        className={`border rounded-xl px-3 py-2 mb-4 text-[11px] leading-relaxed ${panel} ${muted}`}
      >
        <span className={strong}>Analisis live sedang memakai:</span>{' '}
        {[
          adoptedPrior ? 'parameter awal hasil backtest' : 'setelan bawaan engine',
          protectStopAtR !== null
            ? `stop dipindah ke entry di ${protectStopAtR}R`
            : 'stop dibiarkan di tempat yang ditentukan engine',
          skipConvictionBand !== null
            ? `tidak ada setup dengan skor ${skipConvictionBand.min} sampai ${skipConvictionBand.max - 1}`
            : 'semua rentang conviction',
        ].join(' • ')}
        .
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

      {walkRunning && walkProgress && (
        <div className={`border border-violet-500/30 rounded-xl p-3 mb-4 ${panel}`}>
          <div className={`flex items-center gap-2 text-xs ${strong}`}>
            <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" />
            <span className="truncate">{walkProgress.label}</span>
          </div>
          <div className={`mt-2 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
            <div
              className="h-full bg-violet-500 rounded-full transition-all"
              style={{ width: `${Math.max(2, Math.min(100, walkProgress.percent))}%` }}
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

      {walkError && (
        <div className="border border-rose-500/40 bg-rose-500/10 text-rose-400 rounded-xl p-3 mb-4 text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{walkError}</span>
        </div>
      )}

      {!result && !running && !error && (
        <div className={`border rounded-xl p-6 text-center text-xs ${panel} ${muted}`}>
          Belum ada yang diuji ulang. Uji 24 bulan akan mengunduh candle XAUUSD asli, membuat setup dengan cara yang sama seperti engine live di setiap titik keputusan, lalu menentukan hasil masing-masing dari candle yang benar-benar terjadi sesudahnya.
        </div>
      )}

      {walkResult && (
        <div className={`border border-violet-500/30 rounded-xl p-4 mb-4 ${panel}`}>
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-4 h-4 text-violet-400" />
            <h3 className={`text-sm font-bold ${strong}`}>Validasi walk-forward</h3>
          </div>
          <p className={`text-xs ${muted} mb-3`}>
            {walkResult.message} Training tidak masuk statistik test. Parameter frozen hanya berasal dari training tiap fold.
          </p>
          {walkResult.status === 'insufficient' ? (
            <p className="text-xs text-amber-400">Data belum cukup untuk satu fold lengkap.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className={muted}>
                    <th className="text-left font-medium py-1.5">Ukuran test</th>
                    <th className="text-right font-medium py-1.5">Control</th>
                    <th className="text-right font-medium py-1.5">Frozen dari training</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {[
                    {
                      label: 'Fold selesai',
                      control: walkResult.folds.length.toString(),
                      frozen: walkResult.folds.length.toString(),
                    },
                    {
                      label: 'Trade test',
                      control: walkResult.controlStats?.filled.toString() ?? '—',
                      frozen: walkResult.frozenStats?.filled.toString() ?? '—',
                    },
                    {
                      label: 'Hasil bersih',
                      control: walkResult.controlStats ? money(walkResult.controlStats.netDollars, true) : '—',
                      frozen: walkResult.frozenStats ? money(walkResult.frozenStats.netDollars, true) : '—',
                    },
                    {
                      label: 'Profit factor',
                      control: walkResult.controlStats?.profitFactor?.toFixed(2) ?? '—',
                      frozen: walkResult.frozenStats?.profitFactor?.toFixed(2) ?? '—',
                    },
                    {
                      label: 'Max drawdown',
                      control: walkResult.controlStats ? `${walkResult.controlStats.maxDrawdownPercent}%` : '—',
                      frozen: walkResult.frozenStats ? `${walkResult.frozenStats.maxDrawdownPercent}%` : '—',
                    },
                  ].map((row) => (
                    <tr key={row.label} className="border-t border-slate-800/60">
                      <td className={`py-1.5 ${muted}`}>{row.label}</td>
                      <td className={`text-right py-1.5 ${strong}`}>{row.control}</td>
                      <td className={`text-right py-1.5 ${strong}`}>{row.frozen}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
                {result.coverage.bars.toLocaleString('en-US')} candle • {result.coverage.monthsCovered} bulan
              </span>
            </div>
            <p className={muted}>
              {result.control.summary.minConviction > 0 &&
                `Hanya setup dengan skor ${result.control.summary.minConviction} ke atas yang diambil; ${result.control.summary.belowConviction.toLocaleString(
                  'en-US'
                )} ditolak. `}
              Sumber: {result.coverage.provider ?? 'unknown'}.{' '}
              {result.coverage.complete
                ? 'Provider menyediakan seluruh periode yang diminta.'
                : `Provider berhenti sebelum ${result.coverage.requestedMonths} bulan yang diminta, jadi hasilnya mencakup ${result.coverage.monthsCovered} bulan.`}
              {!result.coverage.complete &&
                result.coverage.interval === '15min' &&
                ' Yahoo hanya menyediakan enam puluh hari candle 15 menit. Untuk uji lebih panjang, pasang key Twelve Data atau ganti ke basis H1.'}
              {(result.control.summary.dailyLimitSkips ?? 0) > 0 &&
                ` Batas rugi harian menghentikan trading untuk sisa hari itu sebanyak ${result.control.summary.dailyLimitSkips} kali.`}
              {(result.control.summary.riskCapSkips ?? 0) > 0 &&
                ` Penjaga risiko menolak ${(result.control.summary.riskCapSkips ?? 0).toLocaleString(
                  'en-US'
                )} setup karena lot terkecil akan rugi lebih dari ${riskPercentage}% saldo saat itu. Matikan penjaga di Akun untuk menguji ulang setup itu dengan lot terkecil.`}
              {result.news &&
                ` Berita: ${result.news.releases} rilis dolar berdampak tinggi di periode ini${
                  result.news.archived > 0 ? `, ${result.news.archived} di antaranya dari arsip kalender live` : ''
                }.`}
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
                  ? 'Belajar membuat hasil lebih baik'
                  : result.comparison.verdict === 'worse'
                  ? 'Belajar tidak menguntungkan di periode ini'
                  : 'Belajar tidak membuat perbedaan yang terukur'}
              </h3>
            </div>
            <p className={`text-xs ${muted}`}>
              <span className={strong}>Dibanding kontrol: </span>
              {result.comparison.explanation}
            </p>
            <p className={`text-xs mt-1 ${muted}`}>
              <span className={strong}>Di dalam run belajar: </span>
              {result.phases.explanation}
            </p>
            <p className={`text-xs mt-1 ${muted}`}>
              <span className={strong}>Kalau parameternya dipakai: </span>
              {adoption?.reason}
            </p>
          </div>

          {/* The fixed run pushed harder: by quarter, with a range, with worse costs. */}
          <RobustnessCard results={robustResults} theme={theme} />

          <div className={`border rounded-xl p-4 ${panel}`}>
            <div className="flex items-center gap-2 mb-1">
              <ShieldCheck className="w-4 h-4 text-amber-400" />
              <h3 className={`text-sm font-bold ${strong}`}>Stress biaya eksekusi</h3>
            </div>
            <p className={`text-[11px] ${muted} mb-3`}>
              Biaya di tabel ini adalah tambahan di atas baseline replay. Nilai realistic dan stress adalah asumsi, bukan data historis broker.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className={muted}>
                    <th className="text-left font-medium py-1.5">Skenario</th>
                    <th className="text-right font-medium py-1.5">Trade terdampak</th>
                    <th className="text-right font-medium py-1.5">Net</th>
                    <th className="text-right font-medium py-1.5">PF</th>
                    <th className="text-right font-medium py-1.5">Max DD</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {costStress.map((stress) => (
                    <tr key={stress.scenario.id} className="border-t border-slate-800/60">
                      <td className={`py-1.5 ${muted}`}>{stress.scenario.label}</td>
                      <td className={`text-right py-1.5 ${muted}`}>{stress.adjustedTrades}</td>
                      <td className={`text-right py-1.5 ${stress.profitable ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {money(stress.netDollars, true)}
                      </td>
                      <td className={`text-right py-1.5 ${strong}`}>{stress.profitFactor?.toFixed(2) ?? '—'}</td>
                      <td className={`text-right py-1.5 ${strong}`}>{stress.maxDrawdownPercent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Side by side */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className={muted}>
                  <th className="text-left font-medium py-1.5">Ukuran</th>
                  <th className="text-right font-medium py-1.5">Parameter tetap</th>
                  <th className="text-right font-medium py-1.5">Belajar dari hasil</th>
                  <th className="text-right font-medium py-1.5">Hasil belajar, dibekukan</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {[
                  {
                    label: 'Sinyal dihasilkan',
                    control: result.controlStats.totalSignals.toString(),
                    adaptive: result.adaptiveStats.totalSignals.toString(),
                    frozen: result.frozenStats.totalSignals.toString(),
                  },
                  {
                    label: 'Order terisi',
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
                    label: 'Hasil bersih',
                    control: money(result.controlStats.netDollars, true),
                    adaptive: money(result.adaptiveStats.netDollars, true),
                    frozen: money(result.frozenStats.netDollars, true),
                  },
                  {
                    label: 'Return dari saldo',
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
                    label: 'Rata-rata per trade',
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
                    label: 'Drawdown terburuk',
                    control: `${result.controlStats.maxDrawdownPercent}%`,
                    adaptive: `${result.adaptiveStats.maxDrawdownPercent}%`,
                    frozen: `${result.frozenStats.maxDrawdownPercent}%`,
                  },
                  {
                    label: 'Rugi beruntun terpanjang',
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
                Saldo sepanjang periode, ketiga run di tanggal yang sama
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
              <div className={`mb-2 ${strong}`}>Paruh pertama run belajar</div>
              <div className={`font-mono ${muted}`}>
                {result.phases.firstHalf.filled} terisi • {result.phases.firstHalf.winRate ?? '—'}% menang •{' '}
                {result.phases.firstHalf.expectancyDollars === null
                  ? '—'
                  : money(result.phases.firstHalf.expectancyDollars, true)}{' '}
                per trade
              </div>
            </div>
            <div className={`border rounded-xl p-3 text-xs ${panel}`}>
              <div className={`mb-2 ${strong}`}>Paruh kedua, setelah belajar dari paruh pertama</div>
              <div className="font-mono text-sky-400">
                {result.phases.secondHalf.filled} terisi • {result.phases.secondHalf.winRate ?? '—'}% menang •{' '}
                {result.phases.secondHalf.expectancyDollars === null
                  ? '—'
                  : money(result.phases.secondHalf.expectancyDollars, true)}{' '}
                per trade
              </div>
            </div>
          </div>

          {learningCurve.length > 2 && (
            <div className={`border rounded-xl p-3 ${panel}`}>
              <div className={`text-xs mb-2 ${strong}`}>Tingkat menang 20 trade terakhir</div>
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
                Rentang conviction mana yang untung, di run parameter tetap
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className={muted}>
                      <th className="text-left font-medium py-1">Conviction</th>
                      <th className="text-right font-medium py-1">Sinyal</th>
                      <th className="text-right font-medium py-1">Terisi</th>
                      <th className="text-right font-medium py-1">Menang</th>
                      <th className="text-right font-medium py-1">Per trade</th>
                      <th className="text-right font-medium py-1">Paruh 1</th>
                      <th className="text-right font-medium py-1">Paruh 2</th>
                      <th className="text-right font-medium py-1">Bersih</th>
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
                        {[bucket.firstHalfPerTrade, bucket.secondHalfPerTrade].map((half, i) => (
                          <td
                            key={i}
                            className={`py-1 text-right ${
                              half === null ? muted : half > 0 ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {half === null ? '—' : money(half, true)}
                          </td>
                        ))}
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
                Kalau semua setup di bawah batas ditolak, hasilnya:{' '}
                {quality.verdict.floors.map((f, i) => (
                  <span key={f.floor} id={`backtest-floor-${f.floor}`}>
                    {i > 0 && ' • '}
                    <span className={f.floor === quality.verdict.recommended ? 'text-emerald-400 font-bold' : ''}>
                      {f.floor === 0 ? 'semua setup' : `${f.floor}+`} {money(f.netDollars, true)} dari {f.trades} trade,{' '}
                      drawdown terburuk {f.maxDrawdownPercent}%{f.consistent ? '' : ' (tidak untung di kedua paruh)'}
                    </span>
                  </span>
                ))}
                .{' '}
                <span id="backtest-floor-verdict">{quality.verdict.reason}</span>
              </div>

              {result.floorCheck && (
                <div
                  id="backtest-floor-check"
                  className={`mt-2 p-2.5 rounded-lg border text-[11px] leading-relaxed ${
                    result.floorCheck.held
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                  }`}
                >
                  <span className="font-bold">
                    {result.floorCheck.held ? 'Dicek: batas ini bertahan. ' : 'Dicek: batas ini tidak bertahan. '}
                  </span>
                  {result.floorCheck.reason}
                </div>
              )}
            </div>
          )}

          {/* What the run learned, and adopting it */}
          <div className={`border rounded-xl p-3 ${panel}`}>
            <div className={`text-xs mb-2 flex items-center gap-1.5 ${strong}`}>
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              Parameter akhir run belajar
            </div>
            <div className={`grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-[11px] ${muted}`}>
              <div>Order block: <span className={strong}>{result.adaptive.finalWeights.orderBlockWeight}</span></div>
              <div>Fair value gap: <span className={strong}>{result.adaptive.finalWeights.fairValueGapWeight}</span></div>
              <div>Likuiditas: <span className={strong}>{result.adaptive.finalWeights.liquiditySweepWeight}</span></div>
              <div>Pelindung berita: <span className={strong}>{result.adaptive.finalWeights.newsImpactWeight}</span></div>
              <div>Indikator: <span className={strong}>{result.adaptive.finalWeights.indicatorConfluenceWeight}</span></div>
              <div>Jarak aman stop: <span className={strong}>{result.adaptive.finalWeights.atrBufferFactor}× ATR</span></div>
              <div>Entry ditarik lebih dekat: <span className={strong}>{result.adaptive.finalWeights.entryBufferPips ?? 0} pips</span></div>
            </div>
            {/* Which factors the run found it could trust, over enough trades to judge them. */}
            {(() => {
              const moved = Object.entries(result.adaptive.finalWeights.factorMultipliers ?? {});
              return (
                <div id="backtest-factor-multipliers" className={`mt-2 text-[11px] ${muted}`}>
                  {moved.length === 0 ? (
                    'Run belajar berakhir dengan semua faktor tetap berbobot penuh: tidak ada yang terbukti selalu benar atau salah.'
                  ) : (
                    <>
                      Kepercayaan faktor di akhir run belajar:{' '}
                      {moved.map(([name, value], i) => (
                        <span key={name}>
                          {i > 0 ? ', ' : ''}
                          {factorLabel(name)}{' '}
                          <span className={`font-mono font-bold ${value < 1 ? 'text-rose-400' : 'text-emerald-400'}`}>
                            {value}x
                          </span>
                        </span>
                      ))}
                      . Kalau dipakai, nilai ini ikut ke analisis live.
                    </>
                  )}
                </div>
              );
            })()}
            {factorTable.length > 0 && (
              <div id="backtest-factor-table" className="mt-3 overflow-x-auto">
                <div className={`text-[11px] font-semibold mb-1 ${strong}`}>
                  Semua faktor selama seluruh periode, di run parameter tetap
                </div>
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className={muted}>
                      <th className="text-left font-medium py-1">Faktor</th>
                      <th className="text-right font-medium py-1">Saat setuju</th>
                      <th className="text-right font-medium py-1">Saat kalah suara</th>
                      <th className="text-right font-medium py-1">Selisih</th>
                      <th className="text-right font-medium py-1">Melebihi noise</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {factorTable.map((factor) => {
                      const real = factor.strength !== null && Math.abs(factor.strength) >= NOISE_BAR_STANDARD_ERRORS;
                      return (
                        <tr key={factor.name} className={isDark ? 'border-t border-slate-800' : 'border-t border-slate-100'}>
                          <td className={`py-1 font-sans ${muted}`}>{factorLabel(factor.name)}</td>
                          <td className={`py-1 text-right ${muted}`}>
                            {factor.agreedR === null ? '—' : `${factor.agreedR > 0 ? '+' : ''}${factor.agreedR}R`} ({factor.agreedSamples})
                          </td>
                          <td className={`py-1 text-right ${muted}`}>
                            {factor.opposedR === null ? '—' : `${factor.opposedR > 0 ? '+' : ''}${factor.opposedR}R`} ({factor.opposedSamples})
                          </td>
                          <td
                            className={`py-1 text-right font-bold ${
                              !real ? muted : (factor.edge ?? 0) > 0 ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {factor.edge === null ? '—' : `${factor.edge > 0 ? '+' : ''}${factor.edge}R`}
                          </td>
                          <td className={`py-1 text-right ${real ? strong : muted}`}>
                            {factor.strength === null ? '—' : `${Math.abs(factor.strength).toFixed(1)}×`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className={`text-[10px] mt-1 ${muted}`}>
                  Selisih adalah hasil trade yang didukung sebuah faktor dikurangi hasil trade yang ditentangnya. Faktor yang layak didengar punya selisih positif; selisih negatif berarti pasar terus melakukan hal yang ditentang faktor itu. Hanya selisih minimal {NOISE_BAR_STANDARD_ERRORS}× noise-nya sendiri yang diberi warna, dan hanya itu yang bisa menggeser engine.
                </p>
              </div>
            )}

            <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
              {(() => {
                const state = switchState(adoptedPrior !== null, adoptionGate.allowed, 'amber');
                return (
                  <button
                    type="button"
                    id="adopt-backtest-prior-btn"
                    onClick={() => onAdoptPrior(normalisePrior(result.adaptive.finalWeights))}
                    disabled={state.disabled}
                    className={state.className}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{state.label ?? 'Pakai ini sebagai parameter awal live'}</span>
                  </button>
                );
              })()}
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
                  Kembali ke setelan bawaan engine
                </button>
              )}
            </div>
            <p
              className={`text-[11px] mt-2 ${
                adoptionGate.allowed ? 'text-emerald-400' : muted
              }`}
            >
              {adoption?.reason}
            </p>
            <p className={`text-[11px] mt-1 ${adoptionGate.allowed ? 'text-emerald-400' : 'text-amber-400'}`}>
              Adoption gate: {adoptionGate.reason}
            </p>
            <p className={`text-[11px] mt-1 ${muted}`}>
              Tombol hanya aktif kalau memakai parameter ini memang perbaikan yang didukung periode ini, jadi kalau bisa ditekan, menekannya adalah pilihan yang benar. Kalau tidak, setelanmu sekarang sudah lebih baik.
            </p>
            {adoptedPrior && (
              <p className="text-[11px] mt-2 text-emerald-400">
                Analisis live mulai dari parameter hasil backtest dan tetap belajar dari trade aslimu di atasnya.
              </p>
            )}
          </div>

          {/* When the minimum lot is larger than the risk setting */}
          {riskFloor?.forced && (
            <div
              id="risk-floor-notice"
              className={`border rounded-xl p-3 flex items-start gap-2 ${
                isDark ? 'bg-amber-500/5 border-amber-500/30' : 'bg-amber-50 border-amber-200'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <div>
                <div className={`text-xs mb-1 ${strong}`}>Setelan risiko berbeda dari yang diuji</div>
                <p className={`text-[11px] leading-relaxed ${muted}`}>{riskFloor.message}</p>
              </div>
            </div>
          )}

          {/* Protecting a trade once it has paid, and whether it is worth it */}
          {protection && (
            <div className={`border rounded-xl p-3 ${panel}`}>
              <div className={`text-xs mb-2 flex items-center gap-1.5 ${strong}`}>
                <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
                Memindah stop ke entry setelah trade untung 1R
              </div>
              <div className={`grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px] ${muted}`}>
                <div>
                  Bersih<br />
                  <span className={strong}>{money(result.guardedStats.netDollars, true)}</span>
                </div>
                <div>
                  Dibanding<br />
                  <span className={strong}>{money(result.controlStats.netDollars, true)}</span>
                </div>
                <div>
                  Drawdown terburuk<br />
                  <span className={strong}>{result.guardedStats.maxDrawdownPercent}%</span>
                </div>
                <div>
                  Trade terselamatkan<br />
                  <span className={strong}>{protection.savedTrades}</span>
                </div>
              </div>

              <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
                {(() => {
                  const state = switchState(protectStopAtR !== null, protection.worthUsing, 'sky');
                  return (
                    <button
                      type="button"
                      id="adopt-break-even-btn"
                      onClick={() => onProtectStop(1)}
                      disabled={state.disabled}
                      className={state.className}
                    >
                      {state.label ? (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      ) : (
                        <ShieldCheck className="w-3.5 h-3.5" />
                      )}
                      <span>{state.label ?? 'Pakai aturan ini di setup live'}</span>
                    </button>
                  );
                })()}
                {protectStopAtR !== null && (
                  <button
                    type="button"
                    id="clear-break-even-btn"
                    onClick={() => onProtectStop(null)}
                    className={`text-xs px-3 py-2 rounded-xl border transition-all cursor-pointer ${
                      isDark
                        ? 'border-slate-800 text-slate-400 hover:text-slate-200'
                        : 'border-slate-200 text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Biarkan stop di tempat yang ditentukan engine
                  </button>
                )}
              </div>
              <p className={`text-[11px] mt-2 ${protection.worthUsing ? 'text-emerald-400' : muted}`}>
                {protection.reason}
              </p>
              <p className={`text-[11px] mt-1 ${muted}`}>
                Keluar impas dihitung kalah di win rate di atas, karena memang bukan menang. Tapi itu bukan kena stop penuh, dan itulah inti aturan ini.
              </p>
              {protectStopAtR !== null && (
                <p className="text-[11px] mt-2 text-emerald-400">
                  Setup live sekarang membawa instruksi untuk memindah stop ke entry setelah trade untung
                  {' '}{protectStopAtR}R.
                </p>
              )}
            </div>
          )}

          {/* One band refused outright, when the period supports it */}
          {deadBand && (
            <div className={`border rounded-xl p-3 ${panel}`}>
              <div className={`text-xs mb-2 flex items-center gap-1.5 ${strong}`}>
                <Ban className="w-3.5 h-3.5 text-rose-400" />
                Menolak satu rentang conviction sepenuhnya
              </div>
              <p className={`text-[11px] leading-relaxed ${deadBand.worthSkipping ? strong : muted}`}>
                {deadBand.reason}
              </p>

              <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
                {(() => {
                  const state = switchState(skipConvictionBand !== null, deadBand.worthSkipping, 'rose');
                  return (
                    <button
                      type="button"
                      id="adopt-dead-band-btn"
                      onClick={() => deadBand.band && onSkipBand({ min: deadBand.band.min, max: deadBand.band.max })}
                      disabled={state.disabled}
                      className={state.className}
                    >
                      {state.label ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                      <span>
                        {state.label ??
                          (deadBand.band
                            ? `Tolak ${deadBand.band.label.toLowerCase()} di setup live`
                            : 'Tolak rentang ini di setup live')}
                      </span>
                    </button>
                  );
                })()}
                {skipConvictionBand !== null && (
                  <button
                    type="button"
                    id="clear-dead-band-btn"
                    onClick={() => onSkipBand(null)}
                    className={`text-xs px-3 py-2 rounded-xl border transition-all cursor-pointer ${
                      isDark
                        ? 'border-slate-800 text-slate-400 hover:text-slate-200'
                        : 'border-slate-200 text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Ambil semua rentang lagi
                  </button>
                )}
              </div>
              <p className={`text-[11px] mt-2 ${muted}`}>
                Keuntungan di atas adalah jumlah trade run ini kalau rentang itu dibuang. Nyalakan lalu jalankan ulang untuk menguji periode ini dengan benar, lengkap dengan ukuran lot dan pertumbuhan saldo.
              </p>
              {skipConvictionBand !== null && (
                <p className="text-[11px] mt-2 text-emerald-400">
                  Analisis live menolak setup dengan skor {skipConvictionBand.min} sampai{' '}
                  {skipConvictionBand.max - 1} dan memberitahukannya, bukan menawarkannya.
                </p>
              )}
            </div>
          )}

          {/* Last trades */}
          {result.adaptive.trades.length > 0 && (
            <div className={`border rounded-xl p-3 ${panel}`}>
              <div className={`text-xs mb-2 ${strong}`}>Sepuluh trade terakhir run belajar</div>
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
                      {trade.entryPrice.toFixed(2)} → {trade.filled ? trade.exitPrice.toFixed(2) : 'tidak terisi'}
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
            <span className={strong}>Cara membaca ini.</span> Setiap keputusan hanya melihat candle yang sudah terbentuk saat itu. Kalau satu candle menyentuh stop dan target sekaligus, yang diambil stop, karena urutan di dalam candle tidak bisa diketahui dari open, high, low, dan close-nya. Spread dibebankan di setiap fill, begitu juga komisi kalau akun mengenakannya. Pelindung berita bereaksi pada setiap keputusan FOMC, NFP, dan rilis CPI di periode ini, ditambah rilis dolar lain yang pernah tampil di kalender live sejak arsip dimulai. Rilis lama di luar tiga itu tidak diketahui uji ulang, jadi stop yang diperlebar lebih sedikit daripada di analisis live. Fill market, stop, dan penutupan karena batas waktu kena slippage dua pip, dan stop yang terlewati gap di open candle terisi di open itu. Swap tidak dihitung. Ukuran posisi adalah persentase tetap dari saldo berjalan, jadi periode menang ikut memperbesar hasil dan trade belakangan paling berpengaruh ke total. Hasil masa lalu adalah bukti tentang parameter, bukan janji tentang trade berikutnya. Kolom ketiga membekukan parameter akhir run belajar sejak candle pertama, karena bobot akhirnya adalah ujung sebuah perjalanan, bukan setelan yang pernah di-trade seperti itu. Kalau kolom itu menang dan tombol pakai terbuka, satu periode tetap hanya satu sampel: menjalankan uji yang sama di 12 bulan, atau di basis timeframe lain, lalu melihatnya menang juga di sana, itulah yang membedakan perbaikan nyata dari kecocokan kebetulan dengan satu potongan grafik.
          </div>
        </div>
      )}
    </div>
  );
}

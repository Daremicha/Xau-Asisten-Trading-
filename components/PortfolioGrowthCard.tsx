'use client';

import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Award,
  BarChart3,
  ArrowUpRight,
  ArrowDownRight,
  ShieldCheck,
  RefreshCw,
  Clock,
  Layers,
  History,
  Info,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { AccountType, SelfLearningMemoryRecord, InstitutionalTradingSetup } from '@/lib/types';
import { formatAccountMoney, formatAccountTick, formatAxisNumber } from '@/lib/account-display';
import { computeTradeResult, roundMoney } from '@/lib/trade-result';
import { chronological } from '@/lib/learning-engine';

interface PortfolioGrowthCardProps {
  currentEquity: number;
  initialEquity: number;
  isEquityLocked: boolean;
  learningRecords: SelfLearningMemoryRecord[];
  activeSetup: InstitutionalTradingSetup | null;
  /** Denomination of the user's account, so figures read like their terminal. */
  accountType?: AccountType;
  onResetBaseline?: () => void;
  /**
   * Sets the balance to what the recorded trades add up to.
   *
   * Offered only when the two have drifted apart, and only on the user's click:
   * the ledger is the auditable side, so moving the balance to meet it is the
   * safe direction, but it is still their money and their call.
   */
  onReconcileToLedger?: (ledgerBalance: number) => void;
  theme?: 'dark' | 'light';
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: {
      index: number;
      label: string;
      time: string;
      fullTime: string;
      equity: number;
      pnl: number;
      pnlFormatted: string;
      pnlPercent: number;
      outcome: string;
      symbol: string;
      orderType: string;
      pips: number;
    };
  }>;
  isDark?: boolean;
  accountType?: AccountType;
}

function CustomTooltip({ active, payload, isDark = true, accountType = 'Standard' }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const data = payload[0].payload;
  const isWin = data.outcome === 'TP';
  const isLoss = data.outcome === 'SL';
  const isBase = data.outcome === 'INITIAL';

  return (
    <div
      className={`border rounded-xl p-3 shadow-xl backdrop-blur-md text-xs font-mono min-w-[200px] ${
        isDark ? 'bg-slate-900/95 border-slate-700 text-white' : 'bg-white/95 border-slate-200 text-slate-900'
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b pb-1.5 mb-2 border-slate-700/40">
        <div className="flex items-center gap-1.5 font-bold">
          <Clock className="w-3.5 h-3.5 text-amber-400" />
          <span>{data.label} &bull; {data.time}</span>
        </div>
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
            isWin
              ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
              : isLoss
              ? 'bg-rose-500/20 text-rose-400 border-rose-500/30'
              : isBase
              ? 'bg-sky-500/20 text-sky-400 border-sky-500/30'
              : 'bg-amber-500/20 text-amber-400 border-amber-500/30'
          }`}
        >
          {isWin ? 'TP HIT' : isLoss ? 'SL HIT' : isBase ? 'DEPOSIT' : 'MISSED'}
        </span>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between items-center">
          <span className="opacity-70">Saldo / Equity:</span>
          <span className="font-bold text-sm text-amber-400">
            {formatAccountMoney(data.equity, accountType)}
          </span>
        </div>

        {!isBase && (
          <>
            <div className="flex justify-between items-center">
              <span className="opacity-70">Laba/Rugi Terealisasi:</span>
              <span className={`font-bold ${data.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {data.pnlFormatted} ({data.pnlPercent >= 0 ? '+' : ''}{data.pnlPercent}%)
              </span>
            </div>
            <div className="flex justify-between items-center text-[11px] opacity-75">
              <span>Detail Setup:</span>
              <span>{data.symbol} &bull; {data.orderType}</span>
            </div>
            <div className="flex justify-between items-center text-[11px] opacity-75">
              <span>Jarak:</span>
              <span>{data.pips >= 0 ? `+${data.pips}` : data.pips} pips</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function PortfolioGrowthCard({
  currentEquity,
  initialEquity,
  learningRecords,
  activeSetup,
  accountType = 'Standard',
  onResetBaseline,
  onReconcileToLedger,
  theme = 'dark',
}: PortfolioGrowthCardProps) {
  const isDark = theme === 'dark';
  const [activeTab, setActiveTab] = useState<'chart' | 'ledger'>('chart');

  // Format helper in WIB (UTC+7 Asia/Jakarta)
  const formatTimeWib = (isoString?: string) => {
    if (!isoString) return 'Sekarang';
    try {
      return (
        new Date(isoString).toLocaleTimeString('en-US', {
          timeZone: 'Asia/Jakarta',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }) + ' WIB'
      );
    } catch {
      return 'WIB';
    }
  };


  // Whole-unit figures (baselines, peaks, axis ticks) in the account's own unit.
  const formatUnitsSimple = (val: number) => formatAccountTick(val, accountType);

  /**
   * Oldest first. The curve below replays the balance trade by trade, so the
   * order is the whole meaning of the chart, and the ledger reads back from the
   * same list rather than trusting whatever order the caller happened to pass.
   */
  const orderedRecords = useMemo(() => chronological(learningRecords), [learningRecords]);

  // Reconstruct equity trajectory point-by-point from trade outcomes
  const { chartData, totalPnLDollars, winRate, totalWins, totalLosses, profitFactor, maxDrawdownPercent, peakEquity } =
    useMemo(() => {
      // Start with base capital point
      const base = initialEquity > 0 ? initialEquity : 5000;
      let runningEquity = base;
      let peak = base;
      let maxDd = 0;
      let grossProfit = 0;
      let grossLoss = 0;
      let wins = 0;
      let losses = 0;

      const points: Array<{
        index: number;
        label: string;
        time: string;
        fullTime: string;
        equity: number;
        pnl: number;
        pnlFormatted: string;
        pnlPercent: number;
        outcome: 'INITIAL' | 'TP' | 'SL' | 'MISSED';
        symbol: string;
        orderType: string;
        pips: number;
      }> = [
        {
          index: 0,
          label: 'Awal',
          time: 'Modal awal',
          fullTime: 'Modal Awal',
          equity: roundMoney(base),
          pnl: 0,
          pnlFormatted: formatAccountMoney(0, accountType),
          pnlPercent: 0,
          outcome: 'INITIAL',
          symbol: 'XAUUSD',
          orderType: 'Deposit',
          pips: 0,
        },
      ];

      orderedRecords.forEach((record, idx) => {
        const pnl = record.profitOrLossDollars || 0;
        // Four decimals, as everywhere else money is added up: rounding the
        // balance to two at every step throws away most of a cent account's
        // precision and the error compounds down the curve.
        runningEquity = Math.max(0, roundMoney(runningEquity + pnl));

        if (pnl > 0) {
          grossProfit += pnl;
          wins += 1;
        } else if (pnl < 0) {
          grossLoss += Math.abs(pnl);
          losses += 1;
        }

        if (runningEquity > peak) {
          peak = runningEquity;
        } else if (peak > 0) {
          const dd = ((peak - runningEquity) / peak) * 100;
          if (dd > maxDd) maxDd = dd;
        }

        const pct = base > 0 ? (pnl / base) * 100 : 0;

        points.push({
          index: idx + 1,
          label: `#${idx + 1}`,
          time: formatTimeWib(record.timestamp),
          fullTime: formatTimeWib(record.timestamp),
          equity: runningEquity,
          pnl,
          pnlFormatted: formatAccountMoney(pnl, accountType, { signed: true }),
          pnlPercent: parseFloat(pct.toFixed(2)),
          outcome: record.outcome,
          symbol: record.symbol || 'XAUUSD',
          orderType: record.orderType || 'Trade',
          pips: record.profitOrLossPips || 0,
        });
      });

      // Synchronize latest point with currentEquity if there's any discrepancy
      if (points.length === 1 && currentEquity !== base) {
        points[0].equity = currentEquity;
        runningEquity = currentEquity;
      }

      const netPnL = runningEquity - base;
      const rate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;
      const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

      return {
        chartData: points,
        totalPnLDollars: roundMoney(netPnL),
        winRate: parseFloat(rate.toFixed(1)),
        totalWins: wins,
        totalLosses: losses,
        profitFactor: parseFloat(pf.toFixed(2)),
        maxDrawdownPercent: parseFloat(maxDd.toFixed(1)),
        peakEquity: roundMoney(peak),
      };
    }, [orderedRecords, initialEquity, currentEquity, accountType]);

  /**
   * How much width one trade gets on the curve.
   *
   * Wide enough for the label under it to stay at full size however many trades
   * accumulate, which is the whole reason the chart scrolls instead of fitting.
   */
  const POINT_WIDTH = 52;
  /** Room for the scale panel that stays put while the plot scrolls. */
  const AXIS_WIDTH = 68;
  /** Shared bottom margin, so the two halves align to the pixel. */
  const CHART_BOTTOM = 5;
  /** And a shared x axis height, for the same reason. */
  const X_AXIS_HEIGHT = 30;
  /** Beyond this many points the curve is scrolling, and says so. */
  const VISIBLE_POINTS = 12;

  const plotWidth = Math.max(240, chartData.length * POINT_WIDTH);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canScrollBack, setCanScrollBack] = useState(false);
  const [canScrollForward, setCanScrollForward] = useState(false);
  /** The point whose details show under the curve; the latest trade until one is tapped. */
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const shownPoint = chartData[selectedPoint ?? chartData.length - 1] ?? chartData[chartData.length - 1];

  const updateScrollEdges = () => {
    const el = scrollerRef.current;
    if (!el) return;
    setCanScrollBack(el.scrollLeft > 1);
    setCanScrollForward(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  // Open on the latest trade: that is the one the user just recorded, and on a
  // phone only a handful of trades fit, so starting at the first would hide it.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || activeTab !== 'chart') return;
    el.scrollLeft = el.scrollWidth;
    updateScrollEdges();
    setSelectedPoint(null);
  }, [chartData.length, activeTab]);

  const scrollCurve = (direction: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  /**
   * One vertical scale for both halves of the chart.
   *
   * Recharts would otherwise pick a domain per chart, and the fixed axis would
   * quietly describe a different scale from the curve beside it.
   */
  const equityDomain = useMemo((): [number, number] => {
    const values = chartData.map((point) => point.equity);
    const baseline = initialEquity > 0 ? initialEquity : 5000;
    const low = Math.min(baseline, ...values);
    const high = Math.max(baseline, ...values);
    const pad = Math.max((high - low) * 0.08, Math.abs(high) * 0.002, 0.01);
    return [low - pad, high + pad];
  }, [chartData, initialEquity]);

  /** Change of the balance actually on screen, against the baseline beside it. */
  const balanceChangePercent =
    initialEquity > 0
      ? parseFloat((((currentEquity - initialEquity) / initialEquity) * 100).toFixed(2))
      : 0;

  /** Where the recorded trades alone would put the balance. */
  const ledgerBalance = roundMoney(initialEquity + totalPnLDollars);
  /**
   * The gap between the two, or null when they agree.
   *
   * Half a cent of tolerance, because the balance is rounded for display and a
   * rounding difference is not a disagreement worth a warning.
   */
  const ledgerGap =
    Math.abs(currentEquity - ledgerBalance) > 0.005 ? roundMoney(currentEquity - ledgerBalance) : null;

  const isNetPositive = totalPnLDollars >= 0;

  return (
    <div
      id="portfolio-equity-growth-panel"
      className={`border rounded-2xl p-5 transition-all ${
        isDark
          ? 'bg-slate-900/90 border-slate-800 text-white shadow-lg'
          : 'bg-white border-slate-200 text-slate-900 shadow-sm'
      }`}
    >
      {/* Top Header: Title, Live Sync Status, and Tabs */}
      <div
        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b pb-4 mb-4 ${
          isDark ? 'border-slate-800' : 'border-slate-100'
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center border shadow-inner ${
              isNetPositive
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
            }`}
          >
            {isNetPositive ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold tracking-tight">
                Pertumbuhan Portofolio & Equity
              </h2>
              <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Sinkron TP/SL
              </span>
            </div>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Kurva pertumbuhan saldo yang diperbarui setiap kali Take Profit atau Stop Loss tercatat.
            </p>
          </div>
        </div>

        {/* Action Controls & Tab Switcher */}
        <div className="flex items-center gap-2">
          <div
            className={`flex items-center p-0.5 rounded-xl border text-xs font-semibold ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-100 border-slate-200'
            }`}
          >
            <button
              type="button"
              onClick={() => setActiveTab('chart')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                activeTab === 'chart'
                  ? isDark
                    ? 'bg-slate-800 text-white shadow'
                    : 'bg-white text-slate-900 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5 text-amber-400" />
              <span>Kurva Equity</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('ledger')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                activeTab === 'ledger'
                  ? isDark
                    ? 'bg-slate-800 text-white shadow'
                    : 'bg-white text-slate-900 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <History className="w-3.5 h-3.5 text-sky-400" />
              <span>Catatan Hasil ({learningRecords.length})</span>
            </button>
          </div>

          {onResetBaseline && (
            <button
              type="button"
              onClick={onResetBaseline}
              title="Atur Ulang Modal Awal"
              className={`p-2 rounded-xl border text-xs transition-all cursor-pointer ${
                isDark
                  ? 'bg-slate-950 hover:bg-slate-800 border-slate-800 text-slate-400 hover:text-white'
                  : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-600'
              }`}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* KPI Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {/* Card 1: Live Balance */}
        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between text-[11px] mb-1 opacity-70">
            <span>Saldo Sekarang</span>
            <DollarSign className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="text-lg font-mono font-bold tracking-tight text-amber-400">
            {formatAccountMoney(currentEquity, accountType)}
          </div>
          <div className="flex items-center gap-1 text-[10px] mt-1">
            {/* Measured from the balance actually shown above it, so the two
                numbers on this tile can never contradict each other. The
                ledger's own total lives on the next tile. */}
            <span
              className={`font-semibold flex items-center ${
                balanceChangePercent >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {balanceChangePercent >= 0 ? (
                <ArrowUpRight className="w-3 h-3" />
              ) : (
                <ArrowDownRight className="w-3 h-3" />
              )}
              {balanceChangePercent >= 0 ? `+${balanceChangePercent}%` : `${balanceChangePercent}%`}
            </span>
            <span className="opacity-50" suppressHydrationWarning>dari {formatUnitsSimple(initialEquity)}</span>
          </div>
        </div>

        {/* Card 2: Net Realized P&L */}
        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between text-[11px] mb-1 opacity-70">
            <span>Laba/Rugi Bersih</span>
            <Layers className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <div
            suppressHydrationWarning
            className={`text-lg font-mono font-bold tracking-tight ${
              totalPnLDollars >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {formatAccountMoney(totalPnLDollars, accountType, { signed: true })}
          </div>
          <div className="text-[10px] opacity-60 mt-1">
            {learningRecords.length} trade selesai{learningRecords.length === 1 ? '' : 's'}
          </div>
          {/* The balance and the ledger are kept by different paths: one is the
              number the account carries, the other is what the recorded trades
              add up to. When they drift apart, saying so beats quietly showing
              two figures that cannot both be right. */}
          {ledgerGap !== null && (
            <div id="ledger-balance-gap" className="text-[10px] mt-1 text-amber-500 leading-snug">
              Catatan dan saldo berbeda {formatAccountMoney(Math.abs(ledgerGap), accountType)}: menurut
              catatan trade, saldo seharusnya {formatUnitsSimple(ledgerBalance)}.
              {onReconcileToLedger && (
                <button
                  id="reconcile-to-ledger-btn"
                  type="button"
                  onClick={() => onReconcileToLedger(ledgerBalance)}
                  className="ml-1 underline underline-offset-2 hover:no-underline cursor-pointer font-semibold"
                >
                  Pakai angka dari catatan
                </button>
              )}
            </div>
          )}
        </div>

        {/* Card 3: Win Rate */}
        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between text-[11px] mb-1 opacity-70">
            <span>Win Rate</span>
            <Award className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="text-lg font-mono font-bold tracking-tight text-emerald-400" suppressHydrationWarning>
            {winRate}%
          </div>
          <div className="text-[10px] opacity-60 mt-1">
            {totalWins} kena TP &bull; {totalLosses} kena SL
          </div>
        </div>

        {/* Card 4: Profit Factor & Peak */}
        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between text-[11px] mb-1 opacity-70">
            <span>Profit Factor</span>
            <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
          </div>
          <div className="text-lg font-mono font-bold tracking-tight text-indigo-400" suppressHydrationWarning>
            {profitFactor > 0 ? profitFactor.toFixed(2) : '--'}
          </div>
          <div className="text-[10px] opacity-60 mt-1" suppressHydrationWarning>
            DD Maks: {maxDrawdownPercent}% &bull; Puncak: {formatUnitsSimple(peakEquity)}
          </div>
        </div>
      </div>

      {/* Main Tab View: Interactive Equity Curve Chart */}
      {activeTab === 'chart' && (
        <div
          className={`border rounded-xl p-4 ${
            isDark ? 'bg-slate-950/90 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-amber-400 uppercase tracking-wider font-mono">
                Lintasan Kurva Equity
              </span>
              <span className="text-[10px] font-mono opacity-60">
                {accountType === 'Cent' ? 'Cent' : 'USD'} &bull; Waktu WIB
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono">
              <span className="flex items-center gap-1 text-emerald-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
                Kena TP (+Untung)
              </span>
              <span className="flex items-center gap-1 text-rose-400">
                <span className="w-2 h-2 rounded-full bg-rose-400 inline-block" />
                Kena SL (-Rugi)
              </span>
              <span className="flex items-center gap-1 text-slate-400">
                <span className="w-2 h-2 rounded-full bg-slate-500 inline-block" />
                Missed
              </span>
            </div>
          </div>

          {/* The curve scrolls sideways rather than squeezing.
              Every trade keeps the same width, so a hundred of them read as
              easily as ten instead of collapsing the labels into a grey smear.
              The scale stays put in its own panel on the left, because a chart
              you can scroll away from its own axis is a chart of nothing. */}
          <div className="flex mt-2">
            <div className="shrink-0 h-56" style={{ width: AXIS_WIDTH }} aria-hidden>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 0, left: 10, bottom: CHART_BOTTOM }}>
                  <YAxis
                    stroke={isDark ? '#64748b' : '#94a3b8'}
                    fontSize={12}
                    width={AXIS_WIDTH - 12}
                    tickLine={false}
                    axisLine={{ stroke: isDark ? '#334155' : '#cbd5e1' }}
                    tickFormatter={(val) => formatAxisNumber(val, accountType)}
                    domain={equityDomain}
                  />
                  {/* The x axis and series are invisible, and both have to be
                      here: Recharts lays an axis out against a plot, and with
                      nothing to plot it draws no ticks at all. They also give
                      this panel the same inner height as the curve, which is
                      what keeps the two aligned. */}
                  <XAxis dataKey="label" hide height={X_AXIS_HEIGHT} />
                  <Area dataKey="equity" stroke="none" fill="none" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div
              id="equity-curve-scroller"
              ref={scrollerRef}
              onScroll={updateScrollEdges}
              className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden [&_*:focus]:outline-none"
              style={{ scrollbarWidth: 'thin', touchAction: 'pan-x pan-y' }}
            >
              <div className="h-56" style={{ width: plotWidth, minWidth: '100%' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={chartData}
                    margin={{ top: 10, right: 20, left: 14, bottom: CHART_BOTTOM }}
                    onClick={(state) => {
                      const index = Number(state?.activeTooltipIndex);
                      if (Number.isInteger(index) && index >= 0 && index < chartData.length) {
                        setSelectedPoint(index);
                      }
                    }}
                  >
                <defs>
                  <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="5%"
                      stopColor={isNetPositive ? '#10b981' : '#f43f5e'}
                      stopOpacity={0.4}
                    />
                    <stop
                      offset="95%"
                      stopColor={isNetPositive ? '#10b981' : '#f43f5e'}
                      stopOpacity={0.0}
                    />
                  </linearGradient>
                </defs>

                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={isDark ? '#1e293b' : '#e2e8f0'}
                  vertical={false}
                />

                <XAxis
                  dataKey="label"
                  stroke={isDark ? '#64748b' : '#94a3b8'}
                  fontSize={12}
                  interval={0}
                  height={X_AXIS_HEIGHT}
                  tickLine={false}
                  axisLine={{ stroke: isDark ? '#334155' : '#cbd5e1' }}
                />

                {/* Hidden here, drawn once in the fixed panel, sharing a domain
                    so the two halves line up exactly. */}
                <YAxis hide domain={equityDomain} />

                {/* Tap to pick a trade; its details show under the curve. A
                    floating tooltip would open on every swipe and be cut off by
                    the edge of the scroll area. */}
                <Tooltip trigger="click" content={() => null} />

                <ReferenceLine
                  y={initialEquity > 0 ? initialEquity : 5000}
                  stroke={isDark ? '#64748b' : '#94a3b8'}
                  strokeDasharray="3 3"
                  label={{
                    value: `Modal awal: ${formatUnitsSimple(initialEquity)}`,
                    position: 'insideBottomRight',
                    fill: isDark ? '#94a3b8' : '#64748b',
                    fontSize: 10,
                  }}
                />

                <Area
                  type="monotone"
                  dataKey="equity"
                  stroke={isNetPositive ? '#10b981' : '#f43f5e'}
                  strokeWidth={2.5}
                  fillOpacity={1}
                  fill="url(#equityGradient)"
                  // Each point is coloured by its own trade, as the legend says,
                  // not by whether the account is up overall.
                  dot={(props: { cx?: number; cy?: number; index?: number; payload?: { outcome?: string } }) => {
                    const { cx, cy, index, payload } = props;
                    if (typeof cx !== 'number' || typeof cy !== 'number') return <g key={`dot-${index}`} />;
                    const outcome = payload?.outcome;
                    const fill =
                      outcome === 'TP' ? '#10b981' : outcome === 'SL' ? '#f43f5e' : outcome === 'MISSED' ? '#64748b' : '#f59e0b';
                    return (
                      <circle
                        key={`dot-${index}`}
                        cx={cx}
                        cy={cy}
                        r={4}
                        fill={fill}
                        stroke={isDark ? '#0f172a' : '#ffffff'}
                        strokeWidth={2}
                      />
                    );
                  }}
                  activeDot={{
                    r: 6,
                    fill: '#f59e0b',
                    stroke: '#ffffff',
                    strokeWidth: 2,
                  }}
                />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {shownPoint && shownPoint.outcome !== 'INITIAL' && (
            <div className="mt-2 [&>div]:w-full [&>div]:max-w-none">
              <CustomTooltip
                active
                payload={[{ payload: shownPoint }]}
                isDark={isDark}
                accountType={accountType}
              />
            </div>
          )}

          {chartData.length > VISIBLE_POINTS && (
            <div className="flex items-center justify-between gap-2 mt-2">
              <button
                type="button"
                onClick={() => scrollCurve(-1)}
                disabled={!canScrollBack}
                aria-label="Trade sebelumnya"
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs font-mono disabled:opacity-30 ${
                  isDark ? 'border-slate-700 text-slate-300' : 'border-slate-300 text-slate-600'
                }`}
              >
                <ChevronLeft className="w-4 h-4" /> Sebelumnya
              </button>
              <span className="text-[11px] text-center text-slate-500">
                {chartData.length - 1} trade. Geser kurvanya atau pakai tombol; ketuk satu titik untuk melihat detailnya.
              </span>
              <button
                type="button"
                onClick={() => scrollCurve(1)}
                disabled={!canScrollForward}
                aria-label="Trade berikutnya"
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs font-mono disabled:opacity-30 ${
                  isDark ? 'border-slate-700 text-slate-300' : 'border-slate-300 text-slate-600'
                }`}
              >
                Berikutnya <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {learningRecords.length === 0 && (
            <div className="mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs flex items-center gap-2">
              <Info className="w-4 h-4 shrink-0 text-amber-400" />
              <span>
                Saldo awal dimulai dari <strong suppressHydrationWarning>{formatUnitsSimple(initialEquity)}</strong>. Jalankan sinyal atau tekan &quot;Price Hit TP&quot; / &quot;Price Hit SL&quot; di kartu sinyal untuk mencatat pertumbuhan equity.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Alternative View: Real-time Outcome Ledger */}
      {activeTab === 'ledger' && (
        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950/90 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between mb-3 px-1">
            <span className="text-xs font-bold uppercase tracking-wider font-mono text-amber-400">
              Catatan Dampak Trade Selesai
            </span>
            <span className="text-[11px] opacity-60">
              {learningRecords.length} Catatan Tersimpan
            </span>
          </div>

          {learningRecords.length === 0 ? (
            <div className="py-8 text-center text-xs opacity-60 space-y-1">
              <p>Belum ada hasil trade yang tercatat.</p>
              <p className="text-[11px] opacity-40">
                Catat TP atau SL dari sinyal aktif untuk mengisi catatanmu.
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {/* Newest first: a ledger is read from the top. */}
              {[...orderedRecords].reverse().map((rec, i) => {
                const isTp = rec.outcome === 'TP';
                const isSl = rec.outcome === 'SL';
                const pnl = rec.profitOrLossDollars || 0;

                return (
                  <div
                    key={rec.id || i}
                    className={`border rounded-xl p-2.5 flex items-center justify-between gap-3 text-xs font-mono transition-all ${
                      isTp
                        ? isDark
                          ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300'
                          : 'bg-emerald-50 border-emerald-200 text-emerald-900'
                        : isSl
                        ? isDark
                          ? 'bg-rose-950/20 border-rose-500/30 text-rose-300'
                          : 'bg-rose-50 border-rose-200 text-rose-900'
                        : isDark
                        ? 'bg-amber-950/20 border-amber-500/30 text-amber-300'
                        : 'bg-amber-50 border-amber-200 text-amber-900'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase ${
                          isTp
                            ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                            : isSl
                            ? 'bg-rose-500/20 border-rose-500/40 text-rose-400'
                            : 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                        }`}
                      >
                        {isTp ? 'TP HIT' : isSl ? 'SL HIT' : 'MISSED'}
                      </span>
                      <div>
                        <div className="font-bold flex items-center gap-1.5">
                          <span>{rec.symbol} &bull; {rec.orderType}</span>
                        </div>
                        <div className="text-[10px] opacity-70 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <span>{formatTimeWib(rec.timestamp)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className={`font-bold text-sm ${pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {formatAccountMoney(pnl, accountType, { signed: true })}
                      </div>
                      <div className="text-[10px] opacity-75">
                        {rec.profitOrLossPips >= 0 ? `+${rec.profitOrLossPips}` : rec.profitOrLossPips} pips
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Active Setup Risk-to-Reward Projection */}
      {activeSetup && activeSetup.status === 'ACTIVE' && (
        <div
          className={`mt-4 border rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs ${
            isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="opacity-80">Proyeksi Hasil Setup Aktif:</span>
            <span className="font-bold font-mono text-amber-400">
              {activeSetup.orderType} @ ${activeSetup.entryPrice.toFixed(2)}
            </span>
          </div>

          <div className="flex items-center gap-3 font-mono text-[11px]">
            <span className="text-emerald-400 font-bold">
              TP1:{' '}
              {formatAccountMoney(
                computeTradeResult(activeSetup, activeSetup.takeProfit1, 'TP').dollars,
                activeSetup.accountType ?? accountType,
                { signed: true }
              )}
            </span>
            <span className="opacity-40">&bull;</span>
            <span className="text-rose-400 font-bold">
              SL:{' '}
              {formatAccountMoney(
                computeTradeResult(activeSetup, activeSetup.stopLoss, 'SL').dollars,
                activeSetup.accountType ?? accountType,
                { signed: true }
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

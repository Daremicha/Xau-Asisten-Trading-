'use client';

import React, { useState, useMemo } from 'react';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Percent,
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
import { SelfLearningMemoryRecord, InstitutionalTradingSetup } from '@/lib/types';

interface PortfolioGrowthCardProps {
  currentEquity: number;
  initialEquity: number;
  isEquityLocked: boolean;
  learningRecords: SelfLearningMemoryRecord[];
  activeSetup: InstitutionalTradingSetup | null;
  onResetBaseline?: () => void;
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
}

function CustomTooltip({ active, payload, isDark = true }: CustomTooltipProps) {
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
          <span className="opacity-70">Balance / Equity:</span>
          <span className="font-bold text-sm text-amber-400">
            ${data.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>

        {!isBase && (
          <>
            <div className="flex justify-between items-center">
              <span className="opacity-70">Realized P&L:</span>
              <span className={`font-bold ${data.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {data.pnlFormatted} ({data.pnlPercent >= 0 ? '+' : ''}{data.pnlPercent}%)
              </span>
            </div>
            <div className="flex justify-between items-center text-[11px] opacity-75">
              <span>Setup Spec:</span>
              <span>{data.symbol} &bull; {data.orderType}</span>
            </div>
            <div className="flex justify-between items-center text-[11px] opacity-75">
              <span>Distance:</span>
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
  isEquityLocked,
  learningRecords,
  activeSetup,
  onResetBaseline,
  theme = 'dark',
}: PortfolioGrowthCardProps) {
  const isDark = theme === 'dark';
  const [activeTab, setActiveTab] = useState<'chart' | 'ledger'>('chart');

  // Format helper in WIB (UTC+7 Asia/Jakarta)
  const formatTimeWib = (isoString?: string) => {
    if (!isoString) return 'Current';
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

  const formatUSD = (val: number) =>
    val.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const formatUSDSimple = (val: number) =>
    val.toLocaleString('en-US', {
      maximumFractionDigits: 0,
    });

  // Reconstruct equity trajectory point-by-point from trade outcomes
  const { chartData, totalPnLDollars, totalPnLPercent, winRate, totalWins, totalLosses, profitFactor, maxDrawdownPercent, peakEquity } =
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
          label: 'Start',
          time: 'Baseline',
          fullTime: 'Initial Capital',
          equity: parseFloat(base.toFixed(2)),
          pnl: 0,
          pnlFormatted: '$0.00',
          pnlPercent: 0,
          outcome: 'INITIAL',
          symbol: 'XAUUSD',
          orderType: 'Deposit',
          pips: 0,
        },
      ];

      learningRecords.forEach((record, idx) => {
        const pnl = record.profitOrLossDollars || 0;
        runningEquity = Math.max(0, parseFloat((runningEquity + pnl).toFixed(2)));

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
          pnlFormatted: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
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
      const netPct = base > 0 ? (netPnL / base) * 100 : 0;
      const rate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;
      const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

      return {
        chartData: points,
        totalPnLDollars: parseFloat(netPnL.toFixed(2)),
        totalPnLPercent: parseFloat(netPct.toFixed(2)),
        winRate: parseFloat(rate.toFixed(1)),
        totalWins: wins,
        totalLosses: losses,
        profitFactor: parseFloat(pf.toFixed(2)),
        maxDrawdownPercent: parseFloat(maxDd.toFixed(1)),
        peakEquity: parseFloat(peak.toFixed(2)),
      };
    }, [learningRecords, initialEquity, currentEquity]);

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
                Portfolio & Equity Growth
              </h2>
              <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                TP/SL Synced
              </span>
            </div>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Account balance growth curve updating dynamically with every Take Profit and Stop Loss outcome.
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
              <span>Equity Curve</span>
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
              <span>Outcome Ledger ({learningRecords.length})</span>
            </button>
          </div>

          {onResetBaseline && (
            <button
              type="button"
              onClick={onResetBaseline}
              title="Reset Baseline Capital"
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
            <span>Current Balance</span>
            <DollarSign className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="text-lg font-mono font-bold tracking-tight text-amber-400">
            ${currentEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="flex items-center gap-1 text-[10px] mt-1">
            <span
              className={`font-semibold flex items-center ${
                totalPnLDollars >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {totalPnLDollars >= 0 ? (
                <ArrowUpRight className="w-3 h-3" />
              ) : (
                <ArrowDownRight className="w-3 h-3" />
              )}
              {totalPnLPercent >= 0 ? `+${totalPnLPercent}%` : `${totalPnLPercent}%`}
            </span>
            <span className="opacity-50" suppressHydrationWarning>from ${formatUSDSimple(initialEquity)}</span>
          </div>
        </div>

        {/* Card 2: Net Realized P&L */}
        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between text-[11px] mb-1 opacity-70">
            <span>Net Realized P&L</span>
            <Layers className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <div
            suppressHydrationWarning
            className={`text-lg font-mono font-bold tracking-tight ${
              totalPnLDollars >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {totalPnLDollars >= 0 ? `+$${totalPnLDollars.toFixed(2)}` : `-$${Math.abs(totalPnLDollars).toFixed(2)}`}
          </div>
          <div className="text-[10px] opacity-60 mt-1">
            {learningRecords.length} resolved trade{learningRecords.length === 1 ? '' : 's'}
          </div>
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
            {totalWins} TP hit &bull; {totalLosses} SL hit
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
            Max DD: {maxDrawdownPercent}% &bull; Peak: ${formatUSDSimple(peakEquity)}
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
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-amber-400 uppercase tracking-wider font-mono">
                Equity Curve Trajectory
              </span>
              <span className="text-[10px] font-mono opacity-60">
                WIB Timezone Synchronized
              </span>
            </div>

            <div className="flex items-center gap-3 text-[11px] font-mono">
              <span className="flex items-center gap-1 text-emerald-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
                TP Hit (+Gain)
              </span>
              <span className="flex items-center gap-1 text-rose-400">
                <span className="w-2 h-2 rounded-full bg-rose-400 inline-block" />
                SL Hit (-Loss)
              </span>
            </div>
          </div>

          {/* Recharts Area Curve */}
          <div className="w-full h-56 mt-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 15, left: 10, bottom: 5 }}>
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
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: isDark ? '#334155' : '#cbd5e1' }}
                />

                <YAxis
                  stroke={isDark ? '#64748b' : '#94a3b8'}
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: isDark ? '#334155' : '#cbd5e1' }}
                  tickFormatter={(val) => `$${val}`}
                  domain={['auto', 'auto']}
                />

                <Tooltip content={<CustomTooltip isDark={isDark} />} />

                <ReferenceLine
                  y={initialEquity > 0 ? initialEquity : 5000}
                  stroke={isDark ? '#64748b' : '#94a3b8'}
                  strokeDasharray="3 3"
                  label={{
                    value: `Baseline: $${formatUSDSimple(initialEquity)}`,
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
                  dot={{
                    r: 4,
                    fill: isNetPositive ? '#10b981' : '#f43f5e',
                    stroke: isDark ? '#0f172a' : '#ffffff',
                    strokeWidth: 2,
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

          {learningRecords.length === 0 && (
            <div className="mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs flex items-center gap-2">
              <Info className="w-4 h-4 shrink-0 text-amber-400" />
              <span>
                Baseline balance initialized at <strong suppressHydrationWarning>${formatUSDSimple(initialEquity)}</strong>. Execute signals or click &quot;Price Hit TP&quot; / &quot;Price Hit SL&quot; on the Institutional Signal card to record live equity growth.
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
              Resolved Trades Impact Log
            </span>
            <span className="text-[11px] opacity-60">
              {learningRecords.length} Records Recorded
            </span>
          </div>

          {learningRecords.length === 0 ? (
            <div className="py-8 text-center text-xs opacity-60 space-y-1">
              <p>No completed trade outcomes logged yet.</p>
              <p className="text-[11px] opacity-40">
                Trigger TP or SL on active signals to build your ledger.
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {[...learningRecords].reverse().map((rec, i) => {
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
                        {pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`}
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
            <span className="opacity-80">Active Setup Outcome Projection:</span>
            <span className="font-bold font-mono text-amber-400">
              {activeSetup.orderType} @ ${activeSetup.entryPrice.toFixed(2)}
            </span>
          </div>

          <div className="flex items-center gap-3 font-mono text-[11px]">
            <span className="text-emerald-400 font-bold">
              TP1: +${(
                activeSetup.recommendedLotSize *
                (activeSetup.accountType === 'Cent' ? 1 : 100) *
                Math.abs(activeSetup.takeProfit1 - activeSetup.entryPrice)
              ).toFixed(2)}
            </span>
            <span className="opacity-40">&bull;</span>
            <span className="text-rose-400 font-bold">
              SL: -${activeSetup.riskDollarAmount.toFixed(2)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import { LIVE_LEARNING } from '@/lib/tested-configuration';
import React, { useState } from 'react';
import { formatTimeLeft } from '@/lib/order-validity';
import { formatAccountMoney } from '@/lib/account-display';
import { computeTradeResult } from '@/lib/trade-result';
import {
  ClosedTrade,
  InstitutionalTradingSetup,
  SkippedSetup,
  OrderExecutionType,
  TradingStyle,
  AccountType,
  EngineGenerationMetadata,
} from '@/lib/types';
import {
  Play,
  RotateCcw,
  Copy,
  Check,
  Target,
  ShieldAlert,
  TrendingUp,
  Cpu,
  HelpCircle,
  Sparkles,
  Zap,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Filter,
  Info,
  Layers,
} from 'lucide-react';

interface SignalCardProps {
  setup: InstitutionalTradingSetup | null;
  /** The trade that just closed, shown once the setup itself has left the card. */
  lastOutcome?: ClosedTrade | null;
  /** Set when the engine declined to offer a setup at the user's quality floor. */
  skipped?: SkippedSetup | null;
  /** Unit the balance is denominated in, so money reads like the terminal does. */
  accountType?: AccountType;
  isAnalyzing: boolean;
  onRunAnalysis: () => void;
  onSimulateOutcome: (outcome: 'TP' | 'SL' | 'MISSED', tpLevel?: 1 | 2 | 3) => void;
  onConvertToMarketOrder?: (newEntryPrice: number) => void;
  isEvaluatingOutcome: boolean;
  userEquity: number;
  currentPrice: number | null;
  /**
   * Multiple of risk at which the stop should be moved to entry, or null when
   * the trade is held exactly as quoted. Set from the backtest lab, and only
   * when a run over real history supported it.
   */
  protectStopAtR?: number | null;
  theme?: 'dark' | 'light';
}

/**
 * A time written the way the rest of this app writes times.
 *
 * The engine works in UTC. Every clock on screen — the header, the session
 * panel, the calendar — is stated in WIB, so a time that appeared here in the
 * device's own zone would be the one number on the page that meant something
 * different from all the others.
 */
function formatLocalTime(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '—';
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  const time = `${at.toLocaleTimeString('en-US', options)} WIB`;
  const dayOf = (value: Date) =>
    value.toLocaleDateString('en-US', { timeZone: 'Asia/Jakarta', day: 'numeric' });
  return dayOf(at) === dayOf(new Date())
    ? time
    : `${at.toLocaleDateString('en-US', { timeZone: 'Asia/Jakarta', weekday: 'short' })} ${time}`;
}

export default function SignalCard({
  setup,
  lastOutcome = null,
  skipped = null,
  accountType = 'Standard',
  isAnalyzing,
  onRunAnalysis,
  onSimulateOutcome,
  onConvertToMarketOrder,
  isEvaluatingOutcome,
  currentPrice,
  protectStopAtR = null,
  theme = 'dark',
}: SignalCardProps) {
  const isDark = theme === 'dark';
  const [copied, setCopied] = useState(false);
  const [showMissHelp, setShowMissHelp] = useState(false);

  const getOrderBadgeColor = (type: OrderExecutionType) => {
    if (type.includes('BUY')) {
      return isDark
        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
        : 'bg-emerald-100 text-emerald-800 border-emerald-300';
    }
    return isDark
      ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
      : 'bg-rose-100 text-rose-800 border-rose-300';
  };

  const getStyleBadge = (style?: TradingStyle) => {
    switch (style) {
      case 'Scalping':
        return {
          bg: isDark
            ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
            : 'bg-amber-100 text-amber-800 border-amber-300',
          label: 'Scalp Setup (M15/M5)',
        };
      case 'Swing':
        return {
          bg: isDark
            ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
            : 'bg-purple-100 text-purple-800 border-purple-300',
          label: 'Swing Setup (D1/H4)',
        };
      case 'Intraday':
      default:
        return {
          bg: isDark
            ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
            : 'bg-sky-100 text-sky-800 border-sky-300',
          label: 'Intraday Setup (H1/M15)',
        };
    }
  };

  const getAccountBadge = (acc?: AccountType) => {
    switch (acc) {
      case 'Cent':
        return {
          bg: isDark
            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
            : 'bg-emerald-50 text-emerald-700 border-emerald-200',
          label: 'Cent Account (1 Oz Contract)',
        };
      case 'Pro':
        return {
          bg: isDark
            ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
            : 'bg-blue-50 text-blue-700 border-blue-200',
          label: 'Pro ECN (~0.3p Raw Spread)',
        };
      case 'Standard':
      default:
        return {
          bg: isDark
            ? 'bg-slate-800 text-slate-300 border-slate-700'
            : 'bg-slate-100 text-slate-700 border-slate-300',
          label: 'Standard Account (100 Oz)',
        };
    }
  };

  const getProviderBadge = (metadata?: EngineGenerationMetadata) => {
    if (!metadata) {
      return {
        bg: isDark
          ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
          : 'bg-amber-50 text-amber-800 border-amber-200',
        label: 'SMC/ICT Algorithmic Engine',
        isFallback: false,
      };
    }

    switch (metadata.provider) {
      case 'gemini':
        return {
          bg: isDark
            ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
            : 'bg-blue-50 text-blue-700 border-blue-200',
          label: `Google Gemini (${metadata.model})`,
          isFallback: false,
        };
      case 'openai':
        return {
          bg: isDark
            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
            : 'bg-emerald-50 text-emerald-700 border-emerald-200',
          label: `ChatGPT (${metadata.model})`,
          isFallback: true,
        };
      case 'claude':
        return {
          bg: isDark
            ? 'bg-orange-500/15 text-orange-300 border-orange-500/30'
            : 'bg-orange-50 text-orange-700 border-orange-200',
          label: `Claude Sonnet (${metadata.model})`,
          isFallback: true,
        };
      case 'algorithmic':
      default:
        return {
          bg: isDark
            ? 'bg-purple-500/15 text-purple-300 border-purple-500/30'
            : 'bg-purple-50 text-purple-700 border-purple-200',
          label: 'Structural SMC/ICT engine',
          isFallback: metadata.isFallback,
        };
    }
  };

  const copyToClipboard = () => {
    if (!setup) return;
    const text = `XAUUSD INSTITUTIONAL SIGNAL
Trading Style: ${setup.tradingStyle || 'Intraday'}
Account Type: ${setup.accountType || 'Standard'} (${setup.contractSpecs?.lotUnit || 'Standard Lots'})
Order Type: ${setup.orderType}
Entry Price: ${setup.entryPrice.toFixed(2)}
Stop Loss (SL): ${setup.stopLoss.toFixed(2)} (${setup.stopLossPips} pips)
Take Profit 1: ${setup.takeProfit1.toFixed(2)}
Take Profit 2: ${setup.takeProfit2.toFixed(2)}
Take Profit 3: ${setup.takeProfit3.toFixed(2)}
Recommended Lot Size: ${setup.recommendedLotSize.toFixed(2)} ${setup.contractSpecs?.lotUnit || 'Lots'} (Risk: $${setup.riskDollarAmount.toFixed(2)})
Risk/Reward: ${setup.riskRewardRatio}
Ready for direct execution in MetaTrader 5.`;

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  // Calculate distance between current live price and pending entry
  const distancePips = setup && currentPrice !== null ? parseFloat((Math.abs(currentPrice - setup.entryPrice) * 10).toFixed(1)) : 0;

  // Determine if price has run away towards TP without filling limit order
  // A ticking clock, so the countdown below is derived rather than stored.
  // Storing it would mean writing state from inside an effect on every tick.
  const [nowMs, setNowMs] = React.useState<number | null>(null);
  React.useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30000);
    // Set once after mount so the server and client render the same first pass.
    const first = setTimeout(() => setNowMs(Date.now()), 0);
    return () => {
      clearInterval(id);
      clearTimeout(first);
    };
  }, []);

  const pendingMinutesLeft = (() => {
    if (!setup?.validUntil || nowMs === null) return null;
    const deadline = new Date(setup.validUntil).getTime();
    return Number.isFinite(deadline) ? (deadline - nowMs) / 60000 : null;
  })();

  // The price at which the stop may be moved to entry, when the rule is on.
  const breakEvenTrigger = (() => {
    if (!setup || protectStopAtR === null) return null;
    const risk = Math.abs(setup.entryPrice - setup.stopLoss);
    if (risk <= 0) return null;
    const isLong = setup.orderType.includes('BUY');
    return setup.entryPrice + (isLong ? 1 : -1) * risk * protectStopAtR;
  })();

  const priceRanPastTarget =
    currentPrice !== null &&
    ((setup?.orderType.includes('BUY') && currentPrice >= setup.takeProfit1) ||
      (setup?.orderType.includes('SELL') && currentPrice <= setup.takeProfit1));

  const isFrontRunOrMissed =
    setup && setup.status === 'PENDING' && (priceRanPastTarget || distancePips > 65);

  const formatLocalTimestamp = (iso?: string) => {
    if (!iso) return '';
    try {
      return (
        new Date(iso).toLocaleTimeString('en-US', {
          timeZone: 'Asia/Jakarta',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }) + ' WIB'
      );
    } catch {
      return '';
    }
  };

  return (
    <div
      id="institutional-signal-card"
      className={`${
        isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-sm'
      } border rounded-2xl p-5 flex flex-col justify-between transition-colors`}
    >
      <div>
        {/* Header & Main Trigger */}
        <div
          className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b ${
            isDark ? 'border-slate-800' : 'border-slate-100'
          } pb-4 mb-4`}
        >
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <h2
                className={`text-base font-bold flex items-center gap-2 ${
                  isDark ? 'text-slate-100' : 'text-slate-900'
                }`}
              >
                Institutional Signal & MetaTrader 5 Execution
              </h2>
            </div>
            <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Multi-timeframe synthesis (D1 &rarr; H4 &rarr; H1 &rarr; M15) &bull; Lot size calibrated to locked capital.
            </p>

            {/* Multi-Provider Failover Pipeline Indicator */}
            <div
              id="failover-pipeline-indicator"
              className={`mt-2 inline-flex flex-wrap items-center gap-1.5 py-1 px-2.5 rounded-lg border text-[11px] ${
                isDark ? 'bg-slate-950/70 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-600'
              }`}
            >
              {/* Prices come from the deterministic engine. The language models
                  only write the narrative, so the label says exactly that. */}
              <span className="font-semibold text-slate-300">Price levels:</span>
              <span className="flex items-center gap-1 text-purple-400 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                Structural SMC/ICT engine
              </span>
              <span className="text-slate-600">&bull;</span>
              <span className="font-semibold text-slate-300">Narrative:</span>
              <span className="flex items-center gap-1 text-blue-400 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                Gemini &rarr; ChatGPT &rarr; Claude, optional
              </span>
            </div>
          </div>

          <button
            id="run-analysis-btn"
            type="button"
            disabled={isAnalyzing}
            onClick={onRunAnalysis}
            className="flex items-center justify-center gap-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 disabled:opacity-50 text-slate-950 font-black px-5 py-2.5 rounded-xl text-sm shadow-md transition-all active:scale-95 cursor-pointer"
          >
            {isAnalyzing ? (
              <>
                <RotateCcw className="w-4 h-4 animate-spin text-slate-950" />
                <span>Synthesizing Market Structure...</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-slate-950 text-slate-950" />
                <span>Run XAUUSD Analysis</span>
              </>
            )}
          </button>
        </div>

        {/* Signal Body */}
        {setup ? (
          <div className="space-y-4">
            {/* Top Status & Copy Actions */}
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`text-xs font-black tracking-wide px-3 py-1 rounded-xl border ${getOrderBadgeColor(
                    setup.orderType
                  )}`}
                >
                  {setup.orderType}
                </span>

                <span
                  className={`text-xs font-bold px-3 py-1 rounded-xl border ${
                    getStyleBadge(setup.tradingStyle).bg
                  }`}
                >
                  {getStyleBadge(setup.tradingStyle).label}
                </span>

                <span
                  className={`text-xs font-medium px-3 py-1 rounded-xl border ${
                    getAccountBadge(setup.accountType).bg
                  }`}
                >
                  {getAccountBadge(setup.accountType).label}
                </span>

                {/* Broker & Spread Calibration Badge */}
                {setup.contractSpecs?.brokerName && (
                  <span
                    id="setup-broker-badge"
                    className={`text-xs font-semibold px-3 py-1 rounded-xl border flex items-center gap-1.5 ${
                      isDark
                        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                        : 'bg-amber-50 text-amber-900 border-amber-200'
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                    <span>{setup.contractSpecs.brokerName}</span>
                    <span className="text-[11px] opacity-75 font-mono">
                      ({setup.contractSpecs.typicalSpreadPips} pips spread)
                    </span>
                  </span>
                )}

                {/* Local Generation Time */}
                {setup.timestamp && (
                  <span
                    className={`text-[11px] font-mono px-2.5 py-1 rounded-xl border flex items-center gap-1 ${
                      isDark ? 'bg-slate-950 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}
                  >
                    <Clock className="w-3 h-3 text-amber-400" />
                    <span>{formatLocalTimestamp(setup.timestamp)}</span>
                  </span>
                )}

                {/* Active Generation Engine Badge */}
                {setup.engineMetadata && (
                  <span
                    id="active-engine-badge"
                    className={`text-[11px] font-semibold px-2.5 py-1 rounded-xl border flex items-center gap-1.5 ${
                      getProviderBadge(setup.engineMetadata).bg
                    }`}
                    title={setup.engineMetadata.switchReason || 'Active market analysis engine'}
                  >
                    <Cpu className="w-3 h-3" />
                    <span>{getProviderBadge(setup.engineMetadata).label}</span>
                    {setup.engineMetadata.isFallback && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold">
                        Failover Active
                      </span>
                    )}
                  </span>
                )}

                {/* Whether a language model proposal was used or thrown out.
                    A rejection is worth seeing: it means the model tried to
                    quote something the market structure does not support. */}
                {setup.modelProposal?.attempted && (
                  <span
                    className={`text-[11px] font-semibold px-2.5 py-1 rounded-xl border flex items-center gap-1.5 ${
                      setup.modelProposal.accepted
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                        : 'bg-slate-500/15 text-slate-400 border-slate-500/30'
                    }`}
                    title={
                      setup.modelProposal.accepted
                        ? `Model proposal validated against ${setup.modelProposal.anchoredTo ?? 'measured structure'}.`
                        : `Model proposal rejected: ${setup.modelProposal.reasons.join(' ')}`
                    }
                  >
                    <ShieldAlert className="w-3 h-3" />
                    <span>
                      {setup.modelProposal.accepted
                        ? 'Model proposal validated'
                        : 'Model proposal rejected, engine levels used'}
                    </span>
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  id="help-missed-order-btn"
                  onClick={() => setShowMissHelp(!showMissHelp)}
                  className={`text-xs flex items-center gap-1 px-2.5 py-1 rounded-lg border transition-colors ${
                    isDark
                      ? 'bg-slate-950 border-slate-800 text-slate-300 hover:text-amber-400'
                      : 'bg-slate-50 border-slate-200 text-slate-700 hover:text-amber-600'
                  }`}
                >
                  <Info className="w-3.5 h-3.5 text-amber-400" />
                  <span>Miss Protection</span>
                </button>

                <button
                  type="button"
                  id="copy-signal-btn"
                  onClick={copyToClipboard}
                  className={`flex items-center gap-1.5 px-3 py-1 border rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                    isDark
                      ? 'bg-slate-950 hover:bg-slate-800 border-slate-800 text-slate-200'
                      : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-800'
                  }`}
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied to Clipboard</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-amber-400" />
                      <span>Copy Signal for MT5</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Pending Order Missed / Distance Monitor Banner */}
            {setup.status === 'PENDING' && (
              <div
                className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                  isFrontRunOrMissed
                    ? isDark
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                      : 'bg-amber-50 border-amber-300 text-amber-900'
                    : isDark
                    ? 'bg-slate-950 border-slate-800 text-slate-300'
                    : 'bg-slate-50 border-slate-200 text-slate-700'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <AlertTriangle
                    className={`w-4 h-4 shrink-0 mt-0.5 ${
                      isFrontRunOrMissed ? 'text-amber-400' : 'text-sky-400'
                    }`}
                  />
                  <div>
                    <div className="text-xs font-bold font-mono flex items-center gap-2">
                      <span>
                        {isFrontRunOrMissed
                          ? '⚠️ Pending Order Front-Run / Miss Alert'
                          : 'Live Pending Order Tracking'}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold">
                        {distancePips} pips from limit
                      </span>
                    </div>
                    <p className={`text-[11px] mt-0.5 leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                      {isFrontRunOrMissed
                        ? `Market price reached $${(currentPrice ?? 0).toFixed(2)} without dipping to your pending limit at $${setup.entryPrice.toFixed(2)}. If smart money already hit TP1 or moved away, mark it as missed or convert to market execution.`
                        : `Current Price ($${(currentPrice ?? 0).toFixed(2)}) is approaching the institutional Entry Block ($${setup.entryPrice.toFixed(2)}).`}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {onConvertToMarketOrder && (
                    <button
                      type="button"
                      id="convert-to-market-btn"
                      onClick={() => currentPrice !== null && onConvertToMarketOrder(currentPrice)}
                      className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition-all cursor-pointer"
                    >
                      Instant Market Fill ($${(currentPrice ?? 0).toFixed(2)})
                    </button>
                  )}
                  <button
                    type="button"
                    id="mark-as-missed-btn"
                    disabled={isEvaluatingOutcome}
                    onClick={() => onSimulateOutcome('MISSED')}
                    className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 border border-amber-500/30 transition-all cursor-pointer"
                  >
                    Mark Missed & Adapt
                  </button>
                </div>
              </div>
            )}

            {/* Miss Protection Explanation Collapsible */}
            {showMissHelp && (
              <div
                className={`p-3.5 rounded-xl border text-xs leading-relaxed space-y-2 ${
                  isDark ? 'bg-slate-950 border-amber-500/20 text-slate-300' : 'bg-amber-50/50 border-amber-200 text-slate-800'
                }`}
              >
                <div className="font-bold text-amber-400 flex items-center gap-1.5">
                  <HelpCircle className="w-4 h-4" />
                  <span>What happens if market price misses your pending order?</span>
                </div>
                <div className="space-y-1.5 text-[11px]">
                  <p>
                    <strong>1. Why orders miss:</strong> Large institutions often enter early at the 50% Fair Value Gap mean threshold (Consequent Encroachment) rather than waiting to fill 100% of an unmitigated Order Block.
                  </p>
                  <p>
                    <strong>2. What a miss changes:</strong> {LIVE_LEARNING
                      ? <>When you click <em>&quot;Mark Missed &amp; Adapt&quot;</em>, the engine registers that the limit buffer was too conservative. It automatically increases the Fair Value Gap priority weight and relaxes entry distance buffers on subsequent setups.</>
                      : <>The miss is recorded for your statistics. The engine&apos;s weights stay on the tested setup, because re-tuning them after each live trade did worse in the 24 month replay.</>}
                  </p>
                  <p>
                    <strong>3. Instant Market Execution:</strong> If the setup has not reached TP1 and the multi-timeframe trend remains intact, you can click <em>&quot;Instant Market Fill&quot;</em> to recalibrate your entry at the live market price without increasing your dollar risk.
                  </p>
                </div>
              </div>
            )}

            {/* Core Price Levels: Entry, Stop Loss, TP1 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {/* Entry Price */}
              <div
                className={`border rounded-xl p-3 ${
                  isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div className={`text-[11px] font-medium mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Entry Price
                </div>
                <div className={`text-lg font-black font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  ${setup.entryPrice.toFixed(2)}
                </div>
                <div className="text-[10px] text-amber-400 font-mono mt-0.5">
                  {setup.orderType}
                </div>
                {/* How far price must travel to fill this order. Without it, a
                    level far from market looks the same as one about to fill. */}
                {currentPrice !== null && !setup.orderType.includes('INSTANT') && (
                  <>
                    <div
                      className={`text-[10px] font-mono mt-1 ${
                        distancePips > 150 ? 'text-rose-400' : isDark ? 'text-slate-500' : 'text-slate-500'
                      }`}
                    >
                      {distancePips} pips from market
                      {distancePips > 150 ? ' • may not fill today' : ''}
                    </div>
                    {/* A pending order is not valid forever. This is the point
                        past which the structure it reads no longer describes
                        the market. */}
                    {setup.validUntil && setup.status === 'PENDING' && (
                      <div
                        className={`text-[10px] font-mono mt-0.5 ${
                          pendingMinutesLeft !== null && pendingMinutesLeft <= 0
                            ? 'text-rose-400'
                            : 'text-amber-400'
                        }`}
                        title={setup.validityBasis}
                      >
                        {pendingMinutesLeft === null ? '' : formatTimeLeft(pendingMinutesLeft)}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Stop Loss */}
              <div
                className={`border rounded-xl p-3 ${
                  isDark ? 'bg-slate-950 border-rose-500/20' : 'bg-rose-50/50 border-rose-200'
                }`}
              >
                <div className="text-[11px] text-rose-400 font-medium mb-1 flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" /> Stop Loss
                </div>
                <div className="text-lg font-black font-mono text-rose-400">
                  ${setup.stopLoss.toFixed(2)}
                </div>
                <div className="text-[10px] text-rose-400 font-mono mt-0.5">
                  Risk: {setup.stopLossPips} pips
                </div>
              </div>

              {/* Take Profit 1 */}
              <div
                className={`border rounded-xl p-3 ${
                  isDark ? 'bg-slate-950 border-emerald-500/20' : 'bg-emerald-50/50 border-emerald-200'
                }`}
              >
                <div className="text-[11px] text-emerald-400 font-medium mb-1 flex items-center gap-1">
                  <Target className="w-3 h-3" /> Take Profit 1
                </div>
                <div className="text-lg font-black font-mono text-emerald-400">
                  ${setup.takeProfit1.toFixed(2)}
                </div>
                <div className="text-[10px] text-emerald-400 font-mono mt-0.5">
                  Primary TP target
                </div>
              </div>

              {/* Take Profit 2 & 3 */}
              <div
                className={`border rounded-xl p-3 ${
                  isDark ? 'bg-slate-950 border-emerald-500/20' : 'bg-emerald-50/50 border-emerald-200'
                }`}
              >
                <div className="text-[11px] text-emerald-400 font-medium mb-1 flex items-center gap-1">
                  <Target className="w-3 h-3" /> TP2 & TP3 Targets
                </div>
                <div className="text-base font-black font-mono text-emerald-400">
                  TP2: ${setup.takeProfit2.toFixed(2)}
                </div>
                <div className="text-[10px] text-emerald-400 font-mono mt-0.5">
                  TP3: ${setup.takeProfit3.toFixed(2)}
                </div>
              </div>
            </div>

            {/* How to hold the trade, when the rule is on. A stop that has been
                moved to entry is the difference between a run of stop outs and
                a run of scratches, and the level is spelled out so there is
                nothing to work out in the moment. */}
            {protectStopAtR !== null && (
              <div
                id="break-even-instruction"
                className={`border rounded-xl p-3 flex items-start gap-2 ${
                  isDark ? 'bg-sky-500/5 border-sky-500/25' : 'bg-sky-50 border-sky-200'
                }`}
              >
                <ShieldAlert className="w-3.5 h-3.5 text-sky-400 mt-0.5 shrink-0" />
                <p className={`text-[11px] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  <span className="font-bold">Once price reaches ${breakEvenTrigger?.toFixed(2)}</span>, move the
                  stop to your entry at ${setup.entryPrice.toFixed(2)}. From that point the trade can
                  cost you the spread but not the stop, and the targets are unchanged.
                </p>
              </div>
            )}

            {/* Precision Lot Size & Risk Calibration Banner */}
            <div
              className={`border rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                isDark ? 'bg-slate-950 border-amber-500/30' : 'bg-amber-50/50 border-amber-300 shadow-2xs'
              }`}
            >
              <div>
                <div className="text-xs text-amber-500 font-bold flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5" />
                  <span>MetaTrader 5 Recommended Volume</span>
                </div>
                <div
                  className={`text-2xl font-black font-mono mt-0.5 flex items-baseline gap-2 ${
                    isDark ? 'text-white' : 'text-slate-900'
                  }`}
                >
                  <span>{setup.recommendedLotSize.toFixed(2)}</span>
                  <span className="text-sm font-bold text-amber-500">
                    {setup.contractSpecs?.lotUnit || (setup.accountType === 'Cent' ? 'Cent Lots' : 'Standard Lots')}
                  </span>
                </div>
                <div className={`text-[11px] mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {setup.accountType === 'Cent'
                    ? `Contract Size: 1 Troy Oz per Cent Lot • Min trade 0.01 lot`
                    : setup.accountType === 'Pro'
                    ? `Contract Size: 100 Troy Oz • Commission factored`
                    : `Contract Size: 100 Troy Oz per Standard Lot • Zero commission`}
                </div>
              </div>

              <div className={`text-left sm:text-right text-xs font-mono space-y-0.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                <div>
                  Risk Budget:{' '}
                  <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                    {formatAccountMoney(setup.riskDollarAmount, setup.accountType)} (
                    {setup.effectiveRiskPercentage ?? setup.riskPercentage}%)
                  </strong>
                </div>
                {/* Why this lot and not a bigger one. The risk percentage the
                    user set is a ceiling for the strongest setups, so a weaker
                    read deliberately commits less of it. */}
                {typeof setup.convictionScore === 'number' && (
                  <div
                    className={
                      setup.convictionBand === 'High'
                        ? 'text-emerald-400'
                        : setup.convictionBand === 'Moderate'
                        ? 'text-amber-400'
                        : 'text-slate-400'
                    }
                    title={setup.convictionNotes?.join(' ')}
                  >
                    Conviction: <strong>{setup.convictionBand}</strong> ({setup.convictionScore}/100)
                    {setup.convictionMultiplier !== undefined && setup.convictionMultiplier < 1 && (
                      <span className="text-[10px] block leading-snug mt-0.5">
                        Sized at {Math.round(setup.convictionMultiplier * 100)}% of your {setup.riskPercentage}% budget.
                      </span>
                    )}
                  </div>
                )}
                {/* The broker's minimum lot can risk more than the budget allows.
                    Showing only the budget would understate the real exposure. */}
                {setup.exceedsRiskBudget && typeof setup.actualRiskDollars === 'number' && (
                  <div className="text-rose-400">
                    Actual risk:{' '}
                    <strong>{formatAccountMoney(setup.actualRiskDollars, setup.accountType)}</strong>
                    <span className="text-[10px] block leading-snug mt-0.5">
                      Broker minimum lot exceeds your budget. Lower the stop distance or raise the balance.
                    </span>
                  </div>
                )}
                <div>
                  Risk-to-Reward:{' '}
                  <strong className="text-emerald-500 font-bold">{setup.riskRewardRatio}</strong>
                </div>
                <div className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {setup.accountType} tier &bull; {setup.tradingStyle} profile
                </div>
              </div>
            </div>

            {/* Institutional SMC/ICT Rationale */}
            <div
              className={`border rounded-xl p-3.5 ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div
                className={`text-xs font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1.5 ${
                  isDark ? 'text-slate-300' : 'text-slate-800'
                }`}
              >
                <Cpu className="w-3.5 h-3.5 text-amber-400" />
                <span>Institutional Confluence Rationale ({setup.tradingStyle})</span>
              </div>
              <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                {setup.institutionalRationale}
              </p>
            </div>

            {/* Why each target sits where it does. The reward multiple sets the
                distance so the trade pays for its stop; a level nearby decides
                where inside that window the order rests, and is named. */}
            {setup.targetBasis && setup.targetBasis.length > 0 && (
              <div
                id="target-basis"
                className={`border rounded-xl p-3.5 ${
                  isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div
                  className={`text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5 ${
                    isDark ? 'text-slate-300' : 'text-slate-800'
                  }`}
                >
                  <Target className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Why the targets sit where they do</span>
                </div>
                <div className="space-y-1.5">
                  {setup.targetBasis.map((reason, index) => (
                    <div key={index} className="flex items-start gap-2 text-[11px] leading-relaxed">
                      <span className="font-mono font-bold text-emerald-400 shrink-0">TP{index + 1}</span>
                      <span className={isDark ? 'text-slate-400' : 'text-slate-600'}>{reason}</span>
                    </div>
                  ))}
                </div>
                {setup.targetsFellBack && (
                  <p className={`text-[10px] mt-2 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                    No level sat near where the reward the trade needs puts the target, so it stays on that
                    distance rather than being pulled in to whatever was nearest.
                  </p>
                )}
              </div>
            )}

            {/* What the engine actually read. Built where the decision was made,
                so this is the real list rather than the card's assumption. */}
            {setup.inputsConsulted && setup.inputsConsulted.length > 0 && (
              <div
                id="engine-inputs-consulted"
                className={`border rounded-xl p-3.5 ${
                  isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div
                  className={`text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5 ${
                    isDark ? 'text-slate-300' : 'text-slate-800'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5 text-sky-400" />
                  <span>What the engine read for this setup</span>
                </div>
                <div className="space-y-1.5">
                  {setup.inputsConsulted.map((input) => (
                    <div key={input.label} className="flex items-start gap-2 text-[11px] leading-relaxed">
                      <span className={`mt-0.5 shrink-0 ${input.used ? 'text-emerald-400' : 'text-slate-500'}`}>
                        {input.used ? <CheckCircle className="w-3 h-3" /> : <Info className="w-3 h-3" />}
                      </span>
                      <span>
                        <span className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                          {input.label}:
                        </span>{' '}
                        <span className={isDark ? 'text-slate-400' : 'text-slate-600'}>{input.value}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* MetaTrader 5 Quick Execution Instructions */}
            <div
              className={`border rounded-xl p-3.5 ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div
                className={`text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5 ${
                  isDark ? 'text-slate-300' : 'text-slate-800'
                }`}
              >
                <TrendingUp className="w-3.5 h-3.5 text-sky-400" />
                <span>MetaTrader 5 Order Execution Guide ({setup.accountType} Tier)</span>
              </div>
              <ul className={`space-y-1 text-xs font-mono ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                {setup.executionInstructionsMT5.map((step, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="text-amber-400">&bull;</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Autonomous Self-Learning Trigger: When Price Hits SL, TP, or Misses */}
            <div
              className={`border rounded-xl p-4 ${
                isDark
                  ? 'bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 border-amber-500/40'
                  : 'bg-amber-50/40 border-amber-300'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                {/* min-w-0 lets this column shrink. Without it the text block
                    holds its intrinsic width and pushes the button row out of
                    the card entirely. */}
                <div className="min-w-0">
                  <div className="text-xs font-bold text-amber-500 uppercase tracking-wider flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Autonomous Self-Learning Engine Evaluation</span>
                  </div>
                  <p className={`text-xs mt-1 leading-relaxed max-w-xl ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                    When market price hits Stop Loss, reaches Take Profit, or misses your pending order,
                    trigger an evaluation to update institutional predictive weights.
                  </p>
                </div>

                {/* Outcome Simulation Buttons with Exact Dollar Calculation */}
                {(() => {
                  // Projected with the same function that records the result, so
                  // the button cannot promise one number and book another. The
                  // stop button used to quote the risk budget, which understates
                  // the loss whenever the broker's minimum lot exceeds it.
                  const tp1Gain = formatAccountMoney(
                    computeTradeResult(setup, setup.takeProfit1, 'TP').dollars,
                    setup.accountType,
                    { signed: true }
                  );
                  const tp2Gain = formatAccountMoney(
                    computeTradeResult(setup, setup.takeProfit2, 'TP').dollars,
                    setup.accountType,
                    { signed: true }
                  );
                  const slLoss = formatAccountMoney(
                    computeTradeResult(setup, setup.stopLoss, 'SL').dollars,
                    setup.accountType,
                    { signed: true }
                  );
                  const noMove = formatAccountMoney(0, setup.accountType);

                  return (
                    // shrink-0 stopped flex-wrap from ever engaging, so this
                    // row overflowed the card and the neighbouring column
                    // painted over it, leaving the stop-loss button unclickable
                    // at desktop widths.
                    <div className="flex items-center flex-wrap gap-2 w-full sm:w-auto sm:max-w-[60%] sm:justify-end">
                      <button
                        type="button"
                        id="trigger-tp1-btn"
                        disabled={isEvaluatingOutcome}
                        onClick={() => onSimulateOutcome('TP', 1)}
                        className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold px-3 py-2 rounded-xl text-xs transition-all shadow active:scale-95 cursor-pointer"
                        title="Simulate Take Profit 1 Hit"
                      >
                        <CheckCircle className="w-4 h-4" />
                        <span>Price Hit TP1 ({tp1Gain})</span>
                      </button>

                      <button
                        type="button"
                        id="trigger-tp2-btn"
                        disabled={isEvaluatingOutcome}
                        onClick={() => onSimulateOutcome('TP', 2)}
                        className="flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold px-3 py-2 rounded-xl text-xs transition-all shadow active:scale-95 cursor-pointer"
                        title="Simulate Take Profit 2 Hit"
                      >
                        <CheckCircle className="w-4 h-4" />
                        <span>Hit TP2 ({tp2Gain})</span>
                      </button>

                      <button
                        type="button"
                        id="trigger-sl-btn"
                        disabled={isEvaluatingOutcome}
                        onClick={() => onSimulateOutcome('SL')}
                        className="flex items-center gap-1.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-bold px-3 py-2 rounded-xl text-xs transition-all shadow active:scale-95 cursor-pointer"
                        title="Simulate Stop Loss Hit"
                      >
                        <XCircle className="w-4 h-4" />
                        <span>Price Hit SL ({slLoss})</span>
                      </button>

                      <button
                        type="button"
                        id="trigger-missed-btn"
                        disabled={isEvaluatingOutcome}
                        onClick={() => onSimulateOutcome('MISSED')}
                        className={`flex items-center gap-1.5 border font-bold px-3 py-2 rounded-xl text-xs transition-all shadow active:scale-95 cursor-pointer ${
                          isDark
                            ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border-amber-500/40'
                            : 'bg-amber-100 hover:bg-amber-200 text-amber-900 border-amber-300'
                        }`}
                        title="Simulate Pending Order Missed"
                      >
                        <AlertTriangle className="w-4 h-4" />
                        <span>Order Missed ({noMove})</span>
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        ) : skipped ? (
          /* The engine looked and judged nothing here worth the risk. Saying so
             is the honest answer; offering a weak setup anyway is not. */
          <div
            id="quality-floor-notice"
            className={`border rounded-xl p-6 space-y-3 ${
              isDark ? 'bg-slate-950 border-slate-800/80' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="flex items-center justify-center gap-2">
              <Filter className="w-5 h-5 text-sky-400" />
              <h3 className={`text-sm font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                {skipped.reason === 'unfillable'
                  ? 'Price has run away from its level'
                  : skipped.reason === 'feed-mismatch'
                  ? 'The only price available is the wrong instrument'
                  : skipped.reason === 'daily-limit'
                  ? 'Daily loss limit reached'
                  : 'Nothing worth trading right now'}
              </h3>
            </div>

            {skipped.reason === 'daily-limit' ? null : skipped.reason === 'feed-mismatch' ? (
              <div className={`text-center text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                Gold futures and spot XAUUSD are different contracts, tens of dollars apart. Levels
                read from one do not work at a broker quoting the other, so none were produced.
              </div>
            ) : skipped.reason === 'unfillable' ? (
              <div className={`text-center text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                An order left at that level would be recorded as a missed entry the moment it was
                placed, so none was offered. Waiting costs nothing.
              </div>
            ) : (
            <div className={`text-center font-mono text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              Best available setup scored{' '}
              <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                {skipped.convictionScore}/100
              </strong>{' '}
              ({skipped.band}),{' '}
              {skipped.reason === 'dead-band' && skipped.deadBand ? (
                <>
                  inside the{' '}
                  <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                    {skipped.deadBand.label}
                  </strong>{' '}
                  band, which your backtest showed losing money in both halves of the period.
                </>
              ) : skipped.declinedBy === 'weak-setup' ? (
                <>
                  under{' '}
                  <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                    {skipped.threshold}
                  </strong>
                  , and the pivot bias does not back it.
                </>
              ) : skipped.declinedBy === 'session' ? (
                <>
                  under the Asian session&apos;s{' '}
                  <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                    {skipped.threshold}
                  </strong>
                  .
                </>
              ) : (
                <>
                  under your floor of{' '}
                  <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                    {skipped.threshold}
                  </strong>
                  .
                </>
              )}
            </div>
            )}

            {skipped.notes.length > 0 && (
              <ul className={`text-xs space-y-1 max-w-md mx-auto ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                {skipped.notes.slice(0, 4).map((note, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="text-sky-400">&bull;</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* When to come back. "Nothing right now" is only half an answer;
                the other half is the moment new information exists, which is a
                candle close or a session opening, not a guess. */}
            {skipped.nextCheck && (
              <div
                id="next-check-notice"
                className={`border rounded-xl p-3 text-center ${
                  isDark ? 'bg-sky-500/5 border-sky-500/25' : 'bg-sky-50 border-sky-200'
                }`}
              >
                <div className={`text-xs font-bold mb-1 ${isDark ? 'text-sky-300' : 'text-sky-700'}`}>
                  <Clock className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" />
                  {skipped.nextCheck.marketClosed ? 'Market reopens' : 'Check again at'}{' '}
                  {formatLocalTime(skipped.nextCheck.at)}
                </div>
                <p className={`text-[11px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {skipped.nextCheck.reason}
                </p>
                {typeof skipped.watchPrice === 'number' && (
                  <p className={`text-[11px] mt-1 font-mono ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                    Sooner if price falls back below ${skipped.watchPrice.toFixed(2)}, which is where an
                    order at that level becomes placeable again.
                  </p>
                )}
                {skipped.nextCheck.session && !skipped.nextCheck.marketClosed && (
                  <p className={`text-[11px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                    Next session: {skipped.nextCheck.session.name} at{' '}
                    {formatLocalTime(skipped.nextCheck.session.at)}.
                  </p>
                )}
              </div>
            )}

            <p className={`text-[11px] text-center ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              {skipped.reason === 'daily-limit'
                ? 'A bad day ends here, before it becomes a bad week. You can change or turn off the limit in Capital & Account Configuration.'
                : skipped.reason === 'feed-mismatch'
                ? 'Automatic fills and closes are paused while this lasts, so nothing is recorded from a price your market never traded. Run the analysis again once the spot feed is back.'
                : skipped.reason === 'unfillable'
                ? 'Run the analysis again once price has pulled back toward the level, or switch to a style whose stop is wide enough to reach it.'
                : skipped.reason === 'dead-band'
                ? 'Skipping costs nothing. Run the analysis again later, or turn the refused band off in the Strategy Backtest Lab.'
                : skipped.declinedBy === 'weak-setup' || skipped.declinedBy === 'session'
                ? 'This rule is part of Take all as it was tested, so lowering the floor does not change it. Skipping costs nothing; run the analysis again later.'
                : 'Skipping costs nothing. Run the analysis again later, or lower the floor in Capital & Account Configuration.'}
            </p>
          </div>
        ) : lastOutcome ? (
          /* The trade is closed and gone from the card. What is left is the
             receipt, so the user can see the result was recorded. */
          (() => {
            const closed = lastOutcome.setup;
            const pnl = lastOutcome.record.profitOrLossDollars;
            const isWin = closed.status === 'TP_HIT';
            const isMiss = closed.status === 'MISSED';
            const accent = isWin
              ? 'text-emerald-500'
              : isMiss
              ? 'text-amber-500'
              : 'text-rose-500';
            return (
              <div
                id="closed-trade-receipt"
                className={`border rounded-xl p-6 space-y-4 ${
                  isDark ? 'bg-slate-950 border-slate-800/80' : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div className="flex items-center justify-center gap-2">
                  {isWin ? (
                    <CheckCircle className="w-5 h-5 text-emerald-500" />
                  ) : isMiss ? (
                    <AlertTriangle className="w-5 h-5 text-amber-500" />
                  ) : (
                    <XCircle className="w-5 h-5 text-rose-500" />
                  )}
                  <h3 className={`text-sm font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                    {isWin ? 'Take Profit Recorded' : isMiss ? 'Missed Entry Recorded' : 'Stop Loss Recorded'}
                  </h3>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
                  <div>
                    <div className={isDark ? 'text-slate-500' : 'text-slate-400'}>Order</div>
                    <div className={`font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                      {closed.orderType}
                    </div>
                  </div>
                  <div>
                    <div className={isDark ? 'text-slate-500' : 'text-slate-400'}>Entry</div>
                    <div className={`font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                      ${closed.entryPrice.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className={isDark ? 'text-slate-500' : 'text-slate-400'}>Closed at</div>
                    <div className={`font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                      ${(closed.closedPrice ?? lastOutcome.record.exitPrice).toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className={isDark ? 'text-slate-500' : 'text-slate-400'}>Result</div>
                    <div className={`font-bold ${accent}`}>
                      {formatAccountMoney(pnl, closed.accountType ?? accountType, { signed: true })}
                    </div>
                  </div>
                </div>

                <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {lastOutcome.record.strategyEvolutionLesson}
                </p>

                <p className={`text-[11px] text-center ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                  Balance and the learning engine are already updated. Run a new analysis for the next setup.
                </p>
              </div>
            );
          })()
        ) : (
          /* Empty / Initial State */
          <div
            className={`border rounded-xl p-8 text-center space-y-3 ${
              isDark ? 'bg-slate-950 border-slate-800/80' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mx-auto">
              <Cpu className="w-6 h-6" />
            </div>
            <h3 className={`text-sm font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
              No Active Setup Yet
            </h3>
            <p className={`text-xs max-w-md mx-auto leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              Click &quot;Run XAUUSD Analysis&quot; above to capture real-time order flow and evaluate D1 &rarr; H4 &rarr; H1 &rarr; M15 market structure for institutional entry, SL, and TP.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

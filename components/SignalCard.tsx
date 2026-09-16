'use client';

import React, { useState } from 'react';
import {
  InstitutionalTradingSetup,
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
  Info,
} from 'lucide-react';

interface SignalCardProps {
  setup: InstitutionalTradingSetup | null;
  isAnalyzing: boolean;
  onRunAnalysis: () => void;
  onSimulateOutcome: (outcome: 'TP' | 'SL' | 'MISSED', tpLevel?: 1 | 2 | 3) => void;
  onConvertToMarketOrder?: (newEntryPrice: number) => void;
  isEvaluatingOutcome: boolean;
  userEquity: number;
  currentPrice: number | null;
  theme?: 'dark' | 'light';
}

export default function SignalCard({
  setup,
  isAnalyzing,
  onRunAnalysis,
  onSimulateOutcome,
  onConvertToMarketOrder,
  isEvaluatingOutcome,
  currentPrice,
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
                    <strong>2. Self-Learning Engine Adaptation:</strong> When you click <em>&quot;Mark Missed &amp; Adapt&quot;</em>, the engine registers that the limit buffer was too conservative. It automatically increases the Fair Value Gap priority weight and relaxes entry distance buffers on subsequent setups.
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
                  <div
                    className={`text-[10px] font-mono mt-1 ${
                      distancePips > 150 ? 'text-rose-400' : isDark ? 'text-slate-500' : 'text-slate-500'
                    }`}
                  >
                    {distancePips} pips from market
                    {distancePips > 150 ? ' • may not fill today' : ''}
                  </div>
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
                    ${setup.riskDollarAmount.toFixed(2)} ({setup.riskPercentage}%)
                  </strong>
                </div>
                {/* The broker's minimum lot can risk more than the budget allows.
                    Showing only the budget would understate the real exposure. */}
                {setup.exceedsRiskBudget && typeof setup.actualRiskDollars === 'number' && (
                  <div className="text-rose-400">
                    Actual risk:{' '}
                    <strong>${setup.actualRiskDollars.toFixed(2)}</strong>
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
                  const contractMult = setup.accountType === 'Cent' || setup.contractSpecs?.contractSizeOz === 1 ? 1 : 100;
                  const tp1Gain = (setup.recommendedLotSize * contractMult * Math.abs(setup.takeProfit1 - setup.entryPrice)).toFixed(2);
                  const tp2Gain = (setup.recommendedLotSize * contractMult * Math.abs(setup.takeProfit2 - setup.entryPrice)).toFixed(2);
                  const slLoss = setup.riskDollarAmount.toFixed(2);

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
                        <span>Price Hit TP1 (+${tp1Gain})</span>
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
                        <span>Hit TP2 (+${tp2Gain})</span>
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
                        <span>Price Hit SL (-${slLoss})</span>
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
                        <span>Order Missed ($0)</span>
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
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

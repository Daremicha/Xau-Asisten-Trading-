'use client';

import React, { useState } from 'react';
import { formatTimeLeft } from '@/lib/order-validity';
import { formatAccountMoney } from '@/lib/account-display';
import { computeTradeResult } from '@/lib/trade-result';
import AiReviewPanel from '@/components/AiReviewPanel';
import { isUnresolved } from '@/lib/active-setup-store';
import type { RepeatedMiss } from '@/lib/repeat-level';
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
  History,
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
  /** Asks the language models again after none of them answered. */
  onRetryAiReview?: () => void;
  /** Whether live trades re-tune the engine, the user's switch. */
  selfLearning?: boolean;
  /** Set when this level already missed in the last seven days. */
  repeatedMiss?: RepeatedMiss | null;
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
    : `${at.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'short' })} ${time}`;
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
  onRetryAiReview,
  selfLearning = false,
  repeatedMiss = null,
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
          label: 'Setup Scalping (M15/M5)',
        };
      case 'Swing':
        return {
          bg: isDark
            ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
            : 'bg-purple-100 text-purple-800 border-purple-300',
          label: 'Setup Swing (D1/H4)',
        };
      case 'Intraday':
      default:
        return {
          bg: isDark
            ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
            : 'bg-sky-100 text-sky-800 border-sky-300',
          label: 'Setup Intraday (H1/M15)',
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
          label: 'Akun Cent (Kontrak 1 Oz)',
        };
      case 'Pro':
        return {
          bg: isDark
            ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
            : 'bg-blue-50 text-blue-700 border-blue-200',
          label: 'Pro ECN (~0.3p Spread Raw)',
        };
      case 'Standard':
      default:
        return {
          bg: isDark
            ? 'bg-slate-800 text-slate-300 border-slate-700'
            : 'bg-slate-100 text-slate-700 border-slate-300',
          label: 'Akun Standard (100 Oz)',
        };
    }
  };

  const getProviderBadge = (metadata?: EngineGenerationMetadata) => {
    if (!metadata) {
      return {
        bg: isDark
          ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
          : 'bg-amber-50 text-amber-800 border-amber-200',
        label: 'Engine Algoritma SMC/ICT',
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
          label: `Claude (${metadata.model})`,
          isFallback: true,
        };
      case 'algorithmic':
      default:
        return {
          bg: isDark
            ? 'bg-purple-500/15 text-purple-300 border-purple-500/30'
            : 'bg-purple-50 text-purple-700 border-purple-200',
          label: 'Engine struktur SMC/ICT',
          isFallback: metadata.isFallback,
        };
    }
  };

  const copyToClipboard = () => {
    if (!setup) return;
    const text = `SINYAL XAUUSD
Gaya Trading: ${setup.tradingStyle || 'Intraday'}
Jenis Akun: ${setup.accountType || 'Standard'} (${setup.contractSpecs?.lotUnit || 'Standard Lots'})
Jenis Order: ${setup.orderType}
Harga Entry: ${setup.entryPrice.toFixed(2)}
Stop Loss (SL): ${setup.stopLoss.toFixed(2)} (${setup.stopLossPips} pips)
Take Profit 1: ${setup.takeProfit1.toFixed(2)}
Take Profit 2: ${setup.takeProfit2.toFixed(2)}
Take Profit 3: ${setup.takeProfit3.toFixed(2)}
Ukuran Lot Disarankan: ${setup.recommendedLotSize.toFixed(2)} ${setup.contractSpecs?.lotUnit || 'Lots'} (Risiko: $${setup.riskDollarAmount.toFixed(2)})
Risk/Reward: ${setup.riskRewardRatio}
Siap dieksekusi langsung di MetaTrader 5.`;

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
                Sinyal & Eksekusi MetaTrader 5
              </h2>
            </div>
            <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Gabungan multi-timeframe (D1 &rarr; H4 &rarr; H1 &rarr; M15) &bull; Ukuran lot disesuaikan dengan modal terkunci.
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
              <span className="font-semibold text-slate-300">Level harga:</span>
              <span className="flex items-center gap-1 text-purple-400 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                Engine struktur SMC/ICT
              </span>
              <span className="text-slate-600">&bull;</span>
              <span className="font-semibold text-slate-300">Narasi:</span>
              <span className="flex items-center gap-1 text-blue-400 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                Gemini &rarr; ChatGPT &rarr; Claude, opsional
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
                <span>Menyusun struktur pasar...</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-slate-950 text-slate-950" />
                <span>Analisis XAUUSD</span>
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
                    title={setup.engineMetadata.switchReason || 'Engine analisis pasar yang aktif'}
                  >
                    <Cpu className="w-3 h-3" />
                    <span>{getProviderBadge(setup.engineMetadata).label}</span>
                    {setup.engineMetadata.isFallback && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold">
                        Cadangan Aktif
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
                        ? `Usulan model divalidasi terhadap ${setup.modelProposal.anchoredTo ?? 'struktur terukur'}.`
                        : `Usulan model ditolak: ${setup.modelProposal.reasons.join(' ')}`
                    }
                  >
                    <ShieldAlert className="w-3 h-3" />
                    <span>
                      {setup.modelProposal.accepted
                        ? 'Usulan model tervalidasi'
                        : 'Usulan model ditolak, level engine dipakai'}
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
                  <span>Perlindungan Missed</span>
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
                      <span className="text-emerald-400">Tersalin</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-amber-400" />
                      <span>Salin Sinyal untuk MT5</span>
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
                          ? '⚠️ Peringatan Order Pending Terlewat / Missed'
                          : 'Pemantauan Order Pending Live'}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold">
                        {distancePips} pips dari limit
                      </span>
                    </div>
                    <p className={`text-[11px] mt-0.5 leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                      {isFrontRunOrMissed
                        ? `Harga pasar mencapai $${(currentPrice ?? 0).toFixed(2)} tanpa turun ke order limit kamu di $${setup.entryPrice.toFixed(2)}. Kalau harga sudah kena TP1 atau menjauh, tandai sebagai missed atau ubah jadi order market.`
                        : `Harga sekarang ($${(currentPrice ?? 0).toFixed(2)}) mendekati Entry Block ($${setup.entryPrice.toFixed(2)}).`}
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
                      Masuk Market Sekarang ($${(currentPrice ?? 0).toFixed(2)})
                    </button>
                  )}
                  <button
                    type="button"
                    id="mark-as-missed-btn"
                    disabled={isEvaluatingOutcome}
                    onClick={() => onSimulateOutcome('MISSED')}
                    className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 border border-amber-500/30 transition-all cursor-pointer"
                  >
                    Tandai Missed & Pelajari
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
                  <span>Apa yang terjadi kalau harga tidak menyentuh order pending kamu?</span>
                </div>
                <div className="space-y-1.5 text-[11px]">
                  <p>
                    <strong>1. Kenapa order bisa missed:</strong> Institusi besar sering masuk lebih awal di 50% Fair Value Gap (Consequent Encroachment), tidak menunggu sampai Order Block terisi 100%.
                  </p>
                  <p>
                    <strong>2. Apa yang diubah oleh missed:</strong> {selfLearning
                      ? <>Dengan self-learning aktif, order missed mengajari engine seberapa jauh entry-nya dari titik harga benar-benar berbalik; setelah cukup banyak, dan hanya kalau trade yang terisi memang menguntungkan, entry di setup berikutnya digeser lebih dekat.</>
                      : <>Order missed dicatat untuk statistikmu. Dengan self-learning mati, bobot engine tetap di setelan yang sudah diuji.</>}
                  </p>
                  <p>
                    <strong>3. Masuk di Harga Market:</strong> Kalau setup belum kena TP1 dan tren multi-timeframe masih utuh, kamu bisa menekan <em>&quot;Masuk Market Sekarang&quot;</em> untuk memindah entry ke harga market tanpa menambah risiko dalam dolar.
                  </p>
                </div>
              </div>
            )}

            {/* The same level already missed recently: offered anyway, because
                skipping it did not reliably do better, but said so. */}
            {repeatedMiss && isUnresolved(setup) && (
              <div
                id="repeated-miss-notice"
                className={`flex items-start gap-2 p-3 rounded-xl border text-xs ${
                  isDark ? 'bg-amber-500/10 border-amber-500/30 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-900'
                }`}
              >
                <History className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                <div>
                  <div className="font-bold">
                    Level ini sudah missed {repeatedMiss.count === 1 ? 'sekali' : `${repeatedMiss.count} kali`} dalam 7 hari terakhir
                  </div>
                  <div className={`mt-0.5 ${isDark ? 'text-amber-200/80' : 'text-amber-800'}`}>
                    Terakhir pada {formatLocalTime(repeatedMiss.lastAt)}. Order block atau gap di belakangnya masih ada di grafik, jadi engine menawarkannya lagi. Melewatkan level yang ditawarkan ulang sudah diuji selama 24 bulan dan hasilnya tidak konsisten lebih baik, jadi keputusan memasang order ada di tanganmu.
                  </div>
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
                  Harga Entry
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
                      {distancePips} pips dari harga
                      {distancePips > 150 ? ' • mungkin tidak terisi hari ini' : ''}
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
                  Risiko: {setup.stopLossPips} pips
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
                  Target TP utama
                </div>
              </div>

              {/* Take Profit 2 & 3 */}
              <div
                className={`border rounded-xl p-3 ${
                  isDark ? 'bg-slate-950 border-emerald-500/20' : 'bg-emerald-50/50 border-emerald-200'
                }`}
              >
                <div className="text-[11px] text-emerald-400 font-medium mb-1 flex items-center gap-1">
                  <Target className="w-3 h-3" /> Target TP2 & TP3
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
                  <span className="font-bold">Setelah harga mencapai ${breakEvenTrigger?.toFixed(2)}</span>, pindahkan stop ke entry di ${setup.entryPrice.toFixed(2)}. Sejak saat itu trade paling rugi sebesar spread, bukan stop, dan target tidak berubah.
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
                  <span>Volume Disarankan untuk MetaTrader 5</span>
                </div>
                <div
                  className={`text-2xl font-black font-mono mt-0.5 flex items-baseline gap-2 ${
                    isDark ? 'text-white' : 'text-slate-900'
                  }`}
                >
                  <span>{setup.recommendedLotSize.toFixed(2)}</span>
                  <span className="text-sm font-bold text-amber-500">
                    {setup.contractSpecs?.lotUnit || (setup.accountType === 'Cent' ? 'Cent Lot' : 'Lot Standard')}
                  </span>
                </div>
                <div className={`text-[11px] mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {setup.accountType === 'Cent'
                    ? `Ukuran Kontrak: 1 Troy Oz per Cent Lot • Minimal 0.01 lot`
                    : setup.accountType === 'Pro'
                    ? `Ukuran Kontrak: 100 Troy Oz • Komisi sudah dihitung`
                    : `Ukuran Kontrak: 100 Troy Oz per Lot Standard • Tanpa komisi`}
                </div>
              </div>

              <div className={`text-left sm:text-right text-xs font-mono space-y-0.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                <div>
                  Risiko per Trade:{' '}
                  <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                    {formatAccountMoney(setup.riskDollarAmount, setup.accountType)} (
                    {setup.effectiveRiskPercentage ?? setup.riskPercentage}%)
                  </strong>
                </div>
                {/* Why this lot and not a bigger one. The risk percentage the
                    user set is a ceiling for the strongest setups, so a weaker
                    read deliberately commits less of it. */}
                {setup.entryAnchor === 'Asian Range Breakout' && (
                  <div id="london-breakout-badge" className="text-sky-400">
                    Strategi: <strong>London breakout</strong>
                    <span className="text-[10px] block leading-snug mt-0.5">
                      Order stop di luar range Asia, searah tren. Hapus jam 10:00 London kalau belum terisi.
                    </span>
                  </div>
                )}
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
                        Dipakai {Math.round(setup.convictionMultiplier * 100)}% dari risiko {setup.riskPercentage}% kamu.
                      </span>
                    )}
                  </div>
                )}
                {/* What the stop actually costs, spread and slippage included,
                    against the balance. The broker's minimum lot can push it
                    past the budget, and showing only the budget would
                    understate the real exposure. */}
                {typeof setup.actualRiskDollars === 'number' && (
                  <div id="risk-at-stop" className={setup.exceedsRiskBudget ? 'text-rose-400' : undefined}>
                    Rugi di SL:{' '}
                    <strong>{formatAccountMoney(setup.actualRiskDollars, setup.accountType)}</strong>
                    {typeof setup.balanceAtSetup === 'number' && setup.balanceAtSetup > 0 && (
                      <> ({((setup.actualRiskDollars / setup.balanceAtSetup) * 100).toFixed(1)}% dari saldo)</>
                    )}
                    <span className="text-[10px] block leading-snug mt-0.5">
                      {setup.exceedsRiskBudget
                        ? `Lot terkecil broker rugi lebih dari risiko ${setup.riskPercentage}% kamu. Kalau penjaga risiko di Akun aktif, setup seperti ini ditolak.`
                        : `Sudah termasuk spread dan slippage stop, masih dalam risiko ${setup.riskPercentage}% kamu.`}
                    </span>
                  </div>
                )}
                <div>
                  Risk-to-Reward:{' '}
                  <strong className="text-emerald-500 font-bold">{setup.riskRewardRatio}</strong>
                </div>
                <div className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {setup.accountType} &bull; {setup.tradingStyle}
                </div>
              </div>
            </div>

            <AiReviewPanel
              review={setup.aiReview ?? (isUnresolved(setup) ? undefined : null)}
              onRetry={isUnresolved(setup) ? onRetryAiReview : undefined}
              theme={theme}
            />

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
                <span>Alasan Konfluensi ({setup.tradingStyle})</span>
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
                  <span>Kenapa target ada di situ</span>
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
                    Tidak ada level di dekat jarak reward yang dibutuhkan trade ini, jadi target tetap di jarak itu, tidak ditarik ke level terdekat.
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
                  <span>Yang dibaca engine untuk setup ini</span>
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
                <span>Panduan Eksekusi Order MetaTrader 5 ({setup.accountType} Tier)</span>
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
                    <span>Evaluasi Engine Self-Learning</span>
                  </div>
                  <p className={`text-xs mt-1 leading-relaxed max-w-xl ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                    Saat harga menyentuh Stop Loss, mencapai Take Profit, atau melewatkan order pending kamu, catat evaluasinya supaya bobot engine diperbarui.
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
                        title="Catat TP1 tercapai"
                      >
                        <CheckCircle className="w-4 h-4" />
                        <span>Kena TP1 ({tp1Gain})</span>
                      </button>

                      <button
                        type="button"
                        id="trigger-tp2-btn"
                        disabled={isEvaluatingOutcome}
                        onClick={() => onSimulateOutcome('TP', 2)}
                        className="flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold px-3 py-2 rounded-xl text-xs transition-all shadow active:scale-95 cursor-pointer"
                        title="Catat TP2 tercapai"
                      >
                        <CheckCircle className="w-4 h-4" />
                        <span>Kena TP2 ({tp2Gain})</span>
                      </button>

                      <button
                        type="button"
                        id="trigger-sl-btn"
                        disabled={isEvaluatingOutcome}
                        onClick={() => onSimulateOutcome('SL')}
                        className="flex items-center gap-1.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-bold px-3 py-2 rounded-xl text-xs transition-all shadow active:scale-95 cursor-pointer"
                        title="Catat SL tersentuh"
                      >
                        <XCircle className="w-4 h-4" />
                        <span>Kena SL ({slLoss})</span>
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
                        title="Catat order pending missed"
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
                  ? 'Harga sudah menjauh dari levelnya'
                  : skipped.reason === 'feed-mismatch'
                  ? 'Harga yang tersedia dari instrumen yang salah'
                  : skipped.reason === 'daily-limit'
                  ? 'Batas rugi harian tercapai'
                  : skipped.reason === 'risk-cap'
                  ? 'Lot terkecil akan melanggar setelan risikomu'
                  : 'Belum ada yang layak di-trade sekarang'}
              </h3>
            </div>

            {skipped.reason === 'daily-limit' ? null : skipped.reason === 'risk-cap' && skipped.riskCap ? (
              <div
                id="risk-cap-notice"
                className={`text-center text-xs space-y-1 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}
              >
                <p>
                  Ada setup, tapi dengan lot terkecil broker stop-nya akan rugi{' '}
                  <strong className="text-rose-400">
                    {formatAccountMoney(skipped.riskCap.actualRiskDollars, skipped.riskCap.accountType)} (
                    {skipped.riskCap.actualPercent.toFixed(1)}% dari saldo)
                  </strong>
                  , sudah termasuk spread dan slippage. Setelanmu mengizinkan{' '}
                  <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                    {skipped.riskCap.riskPercentage}% (
                    {formatAccountMoney(skipped.riskCap.budgetDollars, skipped.riskCap.accountType)})
                  </strong>
                  .
                </p>
                <p>
                  Trade yang sama pas dengan setelanmu mulai dari saldo sekitar{' '}
                  <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                    {formatAccountMoney(skipped.riskCap.balanceNeeded, skipped.riskCap.accountType)}
                  </strong>
                  .
                </p>
              </div>
            ) : skipped.reason === 'feed-mismatch' ? (
              <div className={`text-center text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                Futures emas dan XAUUSD spot adalah kontrak berbeda, selisihnya puluhan dolar. Level dari yang satu tidak berlaku di broker yang memakai harga yang lain, jadi tidak ada level yang dibuat.
              </div>
            ) : skipped.reason === 'unfillable' ? (
              <div className={`text-center text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                Order di level itu akan langsung tercatat missed begitu dipasang, jadi tidak ditawarkan. Menunggu tidak ada ruginya.
              </div>
            ) : (
            <div className={`text-center font-mono text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              Setup terbaik skornya{' '}
              <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                {skipped.convictionScore}/100
              </strong>{' '}
              ({skipped.band}),{' '}
              {skipped.reason === 'dead-band' && skipped.deadBand ? (
                <>
                  di dalam rentang{' '}
                  <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                    {skipped.deadBand.label}
                  </strong>{' '}
                  , yang menurut backtest kamu rugi di kedua paruh periode.
                </>
              ) : skipped.declinedBy === 'weak-setup' ? (
                <>
                  under{' '}
                  <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                    {skipped.threshold}
                  </strong>
                  , dan bias pivot tidak mendukungnya.
                </>
              ) : skipped.declinedBy === 'session' ? (
                <>
                  di bawah batas sesi Asia{' '}
                  <strong className={isDark ? 'text-slate-200' : 'text-slate-900'}>
                    {skipped.threshold}
                  </strong>
                  .
                </>
              ) : (
                <>
                  di bawah batas kamu{' '}
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
                  {skipped.nextCheck.marketClosed ? 'Pasar buka lagi' : 'Cek lagi jam'}{' '}
                  {formatLocalTime(skipped.nextCheck.at)}
                </div>
                <p className={`text-[11px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {skipped.nextCheck.reason}
                </p>
                {typeof skipped.watchPrice === 'number' && (
                  <p className={`text-[11px] mt-1 font-mono ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                    Lebih cepat kalau harga kembali ke bawah ${skipped.watchPrice.toFixed(2)}, karena di situ order di level itu bisa dipasang lagi.
                  </p>
                )}
                {skipped.nextCheck.session && !skipped.nextCheck.marketClosed && (
                  <p className={`text-[11px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                    Sesi berikutnya: {skipped.nextCheck.session.name} jam{' '}
                    {formatLocalTime(skipped.nextCheck.session.at)}.
                  </p>
                )}
              </div>
            )}

            <p className={`text-[11px] text-center ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              {skipped.reason === 'daily-limit'
                ? 'Hari yang buruk berhenti di sini, sebelum jadi minggu yang buruk. Kamu bisa mengubah atau mematikan batas ini di Modal & Pengaturan Akun.'
                : skipped.reason === 'risk-cap'
                ? 'Naikkan saldo, naikkan risiko per trade, atau matikan penjaga risiko di Akun untuk tetap mengambilnya dengan lot terkecil. Rangkaian stop dengan ukuran ini cepat menghabiskan akun kecil.'
                : skipped.reason === 'feed-mismatch'
                ? 'Fill dan penutupan otomatis dihentikan selama ini berlangsung, jadi tidak ada yang dicatat dari harga yang tidak pernah terjadi di pasarmu. Jalankan analisis lagi setelah feed spot kembali.'
                : skipped.reason === 'unfillable'
                ? 'Jalankan analisis lagi setelah harga kembali mendekati level, atau ganti ke gaya trading yang stop-nya cukup lebar untuk menjangkaunya.'
                : skipped.reason === 'dead-band'
                ? 'Melewatkan tidak ada ruginya. Jalankan analisis lagi nanti, atau matikan penolakan rentang itu di Lab Backtest.'
                : skipped.declinedBy === 'weak-setup' || skipped.declinedBy === 'session'
                ? 'Aturan ini bagian dari Ambil semua sesuai yang diuji, jadi menurunkan batas tidak mengubahnya. Melewatkan tidak ada ruginya; jalankan analisis lagi nanti.'
                : 'Melewatkan tidak ada ruginya. Jalankan analisis lagi nanti, atau turunkan batas di Modal & Pengaturan Akun.'}
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
                    {isWin ? 'Take Profit Tercatat' : isMiss ? 'Entry Missed Tercatat' : 'Stop Loss Tercatat'}
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
                    <div className={isDark ? 'text-slate-500' : 'text-slate-400'}>Ditutup di</div>
                    <div className={`font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                      ${(closed.closedPrice ?? lastOutcome.record.exitPrice).toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className={isDark ? 'text-slate-500' : 'text-slate-400'}>Hasil</div>
                    <div className={`font-bold ${accent}`}>
                      {formatAccountMoney(pnl, closed.accountType ?? accountType, { signed: true })}
                    </div>
                  </div>
                </div>

                <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {lastOutcome.record.strategyEvolutionLesson}
                </p>

                {/* The app stops watching a missed order, but the broker does not:
                    a pending order left in MT5 can still fill later. */}
                {isMiss && (
                  <div
                    id="missed-delete-notice"
                    className={`border rounded-xl p-3 text-xs leading-relaxed ${
                      isDark ? 'bg-amber-500/10 border-amber-500/30 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-900'
                    }`}
                  >
                    <strong>Hapus {closed.orderType} di {closed.entryPrice.toFixed(2)} di MT5 sekarang.</strong> Aplikasi sudah berhenti memantaunya, tapi MT5 menyimpan order pending sampai kamu menghapusnya, jadi order itu masih bisa terisi nanti. Kalau sudah terisi, catat hasil sebenarnya di Hasil, bagian &quot;Order MISSED ternyata terisi di MT5?&quot;, setelah trade-nya tertutup.
                  </div>
                )}

                <p className={`text-[11px] text-center ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                  Saldo dan engine belajar sudah diperbarui. Jalankan analisis baru untuk setup berikutnya.
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
              Belum Ada Setup Aktif
            </h3>
            <p className={`text-xs max-w-md mx-auto leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              Tekan &quot;Analisis XAUUSD&quot; di atas untuk membaca order flow real-time dan struktur pasar D1 &rarr; H4 &rarr; H1 &rarr; M15 untuk entry, SL, dan TP.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

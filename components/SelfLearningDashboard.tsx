'use client';

import { factorLabel } from '@/lib/factor-labels';
import React, { useState } from 'react';
import { tradeSummaryText, type SummarySettings } from '@/lib/trade-summary';
import { SelfLearningMemoryRecord, AdaptiveStrategyEngineWeights, TradingStyle, AccountType } from '@/lib/types';
import { deriveAdaptiveWeights, summariseEvidence } from '@/lib/learning-engine';
import { Brain, CheckCircle2, XCircle, AlertTriangle, Sliders, Sparkles, Clock, ClipboardCopy } from 'lucide-react';

interface SelfLearningDashboardProps {
  learningRecords: SelfLearningMemoryRecord[];
  engineWeights: AdaptiveStrategyEngineWeights;
  /** Kept in step with the analysis, which segments learning by style. */
  tradingStyle?: TradingStyle;
  /** What the copied trade summary says about the account and its settings. */
  summary?: { equity: number; accountType: AccountType; settings: SummarySettings };
  /** Whether live trades re-tune the engine, the user's switch. */
  selfLearning?: boolean;
  theme?: 'dark' | 'light';
}

export default function SelfLearningDashboard({
  learningRecords,
  engineWeights,
  tradingStyle,
  summary,
  selfLearning = false,
  theme = 'dark',
}: SelfLearningDashboardProps) {
  const isDark = theme === 'dark';
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  /** Puts every recorded trade on the clipboard, ready to paste into a chat. */
  const copySummary = async () => {
    if (!summary) return;
    const text = tradeSummaryText(learningRecords, summary);
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      // Some in-app browsers refuse the clipboard API; a selected textarea
      // and the old copy command still work there.
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        setCopyState(ok ? 'copied' : 'failed');
      } catch {
        setCopyState('failed');
      }
    }
    setTimeout(() => setCopyState('idle'), 4000);
  };
  const total = learningRecords.length;
  const wins = learningRecords.filter((r) => r.outcome === 'TP').length;
  const losses = learningRecords.filter((r) => r.outcome === 'SL').length;
  const missed = learningRecords.filter((r) => r.outcome === 'MISSED').length;
  const triggered = wins + losses;
  // A strike rate with no triggered trades is not zero information, it is no
  // information. The previous code printed a flattering 80.0% instead.
  const evidence = summariseEvidence(learningRecords);
  // The smoothed rate is the headline, because the raw one reports a single
  // win as a perfect 100% strike rate, which is the last thing a trader should
  // be shown before sizing their next position. The raw figure and the sample
  // size sit underneath so nothing is hidden.
  const winRate = evidence.smoothedWinRate === null ? null : evidence.smoothedWinRate.toFixed(1);
  // Computed with the same style segmentation as the weights shown below, so
  // the explanation always describes the bars the user is looking at.
  const learned = deriveAdaptiveWeights(learningRecords, tradingStyle);
  const adjustments = learned.adjustments;

  /**
   * What each kind of setup actually returned. A global strike rate says the
   * engine is doing well or badly; this says which setups are carrying it.
   * Only buckets with trades in them are shown, so an empty history shows
   * nothing rather than a table of dashes.
   */
  const conditionRows = [
    ...learned.conditions.byAnchor,
    ...learned.conditions.bySession,
    ...learned.conditions.byNews,
    ...learned.conditions.byAlignment,
  ].filter((bucket) => bucket.samples > 0);

  /**
   * Each confluence factor measured on its own: what trades it argued for
   * returned, against what trades it argued against returned. Only factors
   * with trades on both sides say anything, so only those are shown.
   */
  const factorRows = learned.factorReliability.filter(
    (factor) => factor.agreedSamples > 0 && factor.opposedSamples > 0
  );
  const formatR = (value: number | null) => (value === null ? '—' : `${value > 0 ? '+' : ''}${value}R`);

  return (
    <div
      id="self-learning-dashboard-card"
      className={`${
        isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-sm'
      } border rounded-2xl p-5 transition-colors`}
    >
      <div
        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b ${
          isDark ? 'border-slate-800' : 'border-slate-100'
        } pb-4 mb-4`}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <Brain className="w-5 h-5" />
          </div>
          <div>
            <h2
              className={`text-base font-bold flex items-center gap-2 ${
                isDark ? 'text-slate-100' : 'text-slate-900'
              }`}
            >
              Engine Self-Learning Adaptif
              <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 font-semibold border border-amber-500/20">
                {selfLearning ? 'Belajar dari setiap trade' : 'Bobot dikunci ke setup yang sudah diuji'}
              </span>
            </h2>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {selfLearning
                ? 'Setiap TP, SL, dan order MISSED menyetel ulang bobot konfluensi, jarak aman stop, dan jarak entry untuk setup berikutnya, dalam batas yang mencegah satu dua trade menggeser semuanya.'
                : 'Mencatat dan meninjau setiap TP, SL, dan order MISSED. Engine memakai bobot yang bertahan di uji ulang 24 bulan, karena menyetel ulang setelah setiap trade live hasilnya lebih buruk di sana.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`text-xs font-mono px-3 py-1 rounded-xl border ${
              isDark ? 'bg-slate-950 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-700'
            }`}
          >
            Evaluasi Tersimpan: <strong className="text-amber-400">{total}</strong>
          </span>
          {summary && total > 0 && (
            <button
              type="button"
              id="copy-trade-summary-btn"
              onClick={copySummary}
              className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1 rounded-xl cursor-pointer ${
                copyState === 'copied'
                  ? 'bg-emerald-500 text-slate-950'
                  : copyState === 'failed'
                    ? 'bg-rose-500 text-white'
                    : 'bg-sky-500 text-slate-950'
              }`}
            >
              <ClipboardCopy className="w-3.5 h-3.5" />
              {copyState === 'copied'
                ? 'Tersalin, tempel di chat'
                : copyState === 'failed'
                  ? 'Gagal menyalin'
                  : 'Salin ringkasan trade'}
            </button>
          )}
        </div>
      </div>

      {/* What the engine changed and why, in plain sentences. Weights that move
          without explanation are indistinguishable from noise. */}
      <div
        className={`border rounded-xl p-3 mb-4 ${
          isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
        }`}
      >
        <div className={`text-[11px] font-semibold mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
          Yang dipelajari engine
        </div>
        <ul className={`space-y-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          {adjustments.map((line, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-amber-400 shrink-0">•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
        {conditionRows.length > 0 && (
          <div className={`mt-3 pt-3 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
            <div className={`text-[11px] font-semibold mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Hasil setiap jenis setup
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                    <th className="text-left font-medium py-1">Kondisi</th>
                    <th className="text-right font-medium py-1">Trade</th>
                    <th className="text-right font-medium py-1">Menang</th>
                    <th className="text-right font-medium py-1">Per risiko</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {conditionRows.map((bucket) => (
                    <tr
                      key={bucket.label}
                      className={isDark ? 'border-t border-slate-800/70' : 'border-t border-slate-100'}
                    >
                      <td className={`py-1 font-sans ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                        {bucket.label}
                      </td>
                      <td className={`py-1 text-right ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        {bucket.samples}
                      </td>
                      <td className={`py-1 text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                        {bucket.winRate === null ? '—' : `${bucket.winRate}%`}
                      </td>
                      <td
                        className={`py-1 text-right font-bold ${
                          bucket.averageR === null
                            ? isDark
                              ? 'text-slate-500'
                              : 'text-slate-400'
                            : bucket.averageR > 0
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }`}
                      >
                        {bucket.averageR === null ? '—' : `${bucket.averageR > 0 ? '+' : ''}${bucket.averageR}R`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={`text-[10px] mt-1.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Diukur per satuan risiko, jadi stop lebar dan stop sempit bisa dibandingkan. Satu kondisi baru menggeser engine setelah ada delapan trade tertutup.
            </p>
          </div>
        )}

        {factorRows.length > 0 && (
          <div
            id="factor-reliability"
            className={`mt-3 pt-3 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}
          >
            <div className={`text-[11px] font-semibold mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Sinyal mana yang layak didengar
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                    <th className="text-left font-medium py-1">Faktor</th>
                    <th className="text-right font-medium py-1">Saat setuju</th>
                    <th className="text-right font-medium py-1">Saat kalah suara</th>
                    <th className="text-right font-medium py-1">Jumlah</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {factorRows.map((factor) => (
                    <tr
                      key={factor.name}
                      className={isDark ? 'border-t border-slate-800/70' : 'border-t border-slate-100'}
                    >
                      <td className={`py-1 font-sans ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                        {factorLabel(factor.name)}
                      </td>
                      <td className={`py-1 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        {formatR(factor.agreedR)}{' '}
                        <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>({factor.agreedSamples})</span>
                      </td>
                      <td className={`py-1 text-right ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        {formatR(factor.opposedR)}{' '}
                        <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>({factor.opposedSamples})</span>
                      </td>
                      <td
                        className={`py-1 text-right font-bold ${
                          factor.multiplier > 1
                            ? 'text-emerald-400'
                            : factor.multiplier < 1
                            ? 'text-rose-400'
                            : isDark
                            ? 'text-slate-500'
                            : 'text-slate-400'
                        }`}
                      >
                        {factor.multiplier.toFixed(2)}x
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={`text-[10px] mt-1.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Faktor yang trade-trade-nya justru lebih bagus saat ia kalah suara berarti menyesatkan engine, dan bobotnya diturunkan. Tidak ada yang berubah sampai sebuah faktor punya delapan trade terisi di masing-masing sisi dan selisihnya dua kali lipat noise-nya, jadi kebetulan beruntun tidak mengubah apa pun.
            </p>
          </div>
        )}

        <div className={`text-[10px] mt-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          Keyakinan {(evidence.confidence * 100).toFixed(0)}% dari {evidence.sampleSize} record
          {evidence.sampleSize === 1 ? '' : 's'}, dibobot ke {evidence.effectiveSampleSize} menurut waktu. Trade yang lebih baru dihitung lebih berat.
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Akurasi Eksekusi</div>
          <div
            className={`text-2xl font-black font-mono mt-0.5 ${
              winRate === null ? (isDark ? 'text-slate-600' : 'text-slate-400') : 'text-emerald-400'
            }`}
          >
            {winRate === null ? '—' : `${winRate}%`}
          </div>
          <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {winRate === null
              ? 'Belum ada order yang terisi dan selesai'
              : `${wins} dari ${triggered} kena (mentah ${evidence.winRate?.toFixed(1)}%), disesuaikan dengan jumlah sampel`}
          </div>
        </div>

        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Take Profit Tercapai</div>
          <div className="text-2xl font-black font-mono text-emerald-400 mt-0.5">{wins}</div>
          <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Target penuh tercapai
          </div>
        </div>

        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Diagnostik Stop Loss</div>
          <div className="text-2xl font-black font-mono text-rose-400 mt-0.5">{losses}</div>
          <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Sweep pemburu stop dipetakan
          </div>
        </div>

        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Order Missed / Terdahului</div>
          <div className="text-2xl font-black font-mono text-amber-400 mt-0.5">{missed}</div>
          <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Menyetel jarak entry limit
          </div>
        </div>
      </div>

      {/* Adaptive Weights Progress Bars */}
      <div
        className={`border rounded-xl p-4 mb-4 ${
          isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
        }`}
      >
        <div
          className={`text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-1.5 ${
            isDark ? 'text-slate-300' : 'text-slate-800'
          }`}
        >
          <Sliders className="w-3.5 h-3.5 text-amber-400" />
          <span>Bobot Faktor Konfluensi Dinamis (Disetel oleh Pengalaman)</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
          {/* Order Block Weight */}
          <div>
            <div className="flex justify-between mb-1">
              <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>Prioritas Order Block (OB)</span>
              <strong className="text-amber-400">{(engineWeights.orderBlockWeight * 100).toFixed(0)}%</strong>
            </div>
            <div className={`w-full h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-900' : 'bg-slate-200'}`}>
              <div
                className="h-full bg-amber-400 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, engineWeights.orderBlockWeight * 250)}%` }}
              />
            </div>
          </div>

          {/* Fair Value Gap Weight */}
          <div>
            <div className="flex justify-between mb-1">
              <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>Bobot Fair Value Gap (FVG)</span>
              <strong className="text-sky-400">{(engineWeights.fairValueGapWeight * 100).toFixed(0)}%</strong>
            </div>
            <div className={`w-full h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-900' : 'bg-slate-200'}`}>
              <div
                className="h-full bg-sky-400 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, engineWeights.fairValueGapWeight * 250)}%` }}
              />
            </div>
          </div>

          {/* Liquidity Sweep Priority */}
          <div>
            <div className="flex justify-between mb-1">
              <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>Konfirmasi Liquidity Sweep</span>
              <strong className="text-emerald-400">{(engineWeights.liquiditySweepWeight * 100).toFixed(0)}%</strong>
            </div>
            <div className={`w-full h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-900' : 'bg-slate-200'}`}>
              <div
                className="h-full bg-emerald-400 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, engineWeights.liquiditySweepWeight * 250)}%` }}
              />
            </div>
          </div>

          {/* News Volatility Filter */}
          <div>
            <div className="flex justify-between mb-1">
              <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>Pelindung Volatilitas Berita Makro</span>
              <strong className="text-rose-400">{(engineWeights.newsImpactWeight * 100).toFixed(0)}%</strong>
            </div>
            <div className={`w-full h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-900' : 'bg-slate-200'}`}>
              <div
                className="h-full bg-rose-400 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, engineWeights.newsImpactWeight * 250)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Chronological Strategy Evolution Log */}
      <div>
        <div
          className={`text-xs font-bold uppercase tracking-wider mb-2.5 flex items-center gap-1.5 ${
            isDark ? 'text-slate-300' : 'text-slate-800'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span>Log Belajar Otomatis & Memori Diagnostik</span>
        </div>

        {learningRecords.length > 0 ? (
          <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
            {learningRecords.slice().reverse().map((rec) => {
              const isWin = rec.outcome === 'TP';
              const isMiss = rec.outcome === 'MISSED';

              const formatLocalTimestamp = (iso: string) => {
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
                  key={rec.id}
                  className={`border rounded-xl p-3 text-xs transition-colors ${
                    isWin
                      ? isDark
                        ? 'bg-slate-950 border-emerald-500/30'
                        : 'bg-emerald-50/40 border-emerald-300'
                      : isMiss
                      ? isDark
                        ? 'bg-slate-950 border-amber-500/30'
                        : 'bg-amber-50/40 border-amber-300'
                      : isDark
                      ? 'bg-slate-950 border-rose-500/30'
                      : 'bg-rose-50/40 border-rose-300'
                  }`}
                >
                  <div
                    className={`flex items-center justify-between border-b pb-1.5 mb-1.5 font-mono ${
                      isDark ? 'border-slate-800/80' : 'border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {isWin ? (
                        <span className="flex items-center gap-1 text-emerald-400 font-bold">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Kena Take Profit
                        </span>
                      ) : isMiss ? (
                        <span className="flex items-center gap-1 text-amber-400 font-bold">
                          <AlertTriangle className="w-3.5 h-3.5" /> Order Pending Missed / Kedaluwarsa
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-rose-400 font-bold">
                          <XCircle className="w-3.5 h-3.5" /> Kena Stop Loss
                        </span>
                      )}
                      <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>({rec.orderType})</span>
                    </div>

                    <div className={`text-[11px] flex items-center gap-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      <Clock className="w-3 h-3" />
                      <span>{formatLocalTimestamp(rec.timestamp)}</span>
                    </div>
                  </div>

                  <div className="space-y-1 text-xs">
                    <div>
                      <strong className={isDark ? 'text-slate-300' : 'text-slate-700'}>Penyebab Utama: </strong>
                      <span className={isDark ? 'text-slate-400' : 'text-slate-600'}>
                        {rec.rootCauseAnalysis.primaryFactor}
                      </span>
                    </div>
                    <div>
                      <strong className={isDark ? 'text-slate-300' : 'text-slate-700'}>Perilaku Order Flow: </strong>
                      <span className={isDark ? 'text-slate-400' : 'text-slate-600'}>
                        {rec.rootCauseAnalysis.institutionalFlowExplanation}
                      </span>
                    </div>
                    <div
                      className={`mt-1.5 pt-1.5 border-t p-2 rounded-lg font-mono ${
                        isDark
                          ? 'border-slate-800 bg-slate-900/60 text-amber-300'
                          : 'border-slate-200 bg-amber-50/60 text-amber-800'
                      }`}
                    >
                      <strong>Pelajaran untuk Engine: </strong>
                      <span>{rec.strategyEvolutionLesson}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className={`border rounded-xl p-4 text-center text-xs ${
              isDark ? 'bg-slate-950 border-slate-800 text-slate-500' : 'bg-slate-50 border-slate-200 text-slate-500'
            }`}
          >
            Belum ada hasil trade yang dievaluasi. Setelah harga menyentuh Stop Loss, Take Profit, atau order limit MISSED, diagnosis belajar otomatis akan dicatat di sini.
          </div>
        )}
      </div>
    </div>
  );
}

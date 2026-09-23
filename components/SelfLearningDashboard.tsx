'use client';

import React from 'react';
import { SelfLearningMemoryRecord, AdaptiveStrategyEngineWeights, TradingStyle } from '@/lib/types';
import { deriveAdaptiveWeights, summariseEvidence } from '@/lib/learning-engine';
import { Brain, CheckCircle2, XCircle, AlertTriangle, Sliders, Sparkles, Clock } from 'lucide-react';

interface SelfLearningDashboardProps {
  learningRecords: SelfLearningMemoryRecord[];
  engineWeights: AdaptiveStrategyEngineWeights;
  /** Kept in step with the analysis, which segments learning by style. */
  tradingStyle?: TradingStyle;
  theme?: 'dark' | 'light';
}

export default function SelfLearningDashboard({
  learningRecords,
  engineWeights,
  tradingStyle,
  theme = 'dark',
}: SelfLearningDashboardProps) {
  const isDark = theme === 'dark';
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
              Adaptive Self-Learning Engine
              <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 font-semibold border border-amber-500/20">
                Continuous Calibration
              </span>
            </h2>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Autonomously evaluates TP, SL, and Missed pending orders to refine institutional execution parameters.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-mono px-3 py-1 rounded-xl border ${
              isDark ? 'bg-slate-950 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-700'
            }`}
          >
            Evaluations Stored: <strong className="text-amber-400">{total}</strong>
          </span>
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
          What the engine learned
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
              What each kind of setup has returned
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                    <th className="text-left font-medium py-1">Condition</th>
                    <th className="text-right font-medium py-1">Trades</th>
                    <th className="text-right font-medium py-1">Won</th>
                    <th className="text-right font-medium py-1">Per risk</th>
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
              Measured per unit of risk, so a wide stop and a tight one can be compared. A condition only
              moves the engine once it carries eight closed trades.
            </p>
          </div>
        )}

        {factorRows.length > 0 && (
          <div
            id="factor-reliability"
            className={`mt-3 pt-3 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}
          >
            <div className={`text-[11px] font-semibold mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Which signals have earned their say
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                    <th className="text-left font-medium py-1">Factor</th>
                    <th className="text-right font-medium py-1">When it agreed</th>
                    <th className="text-right font-medium py-1">When outvoted</th>
                    <th className="text-right font-medium py-1">Counts</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {factorRows.map((factor) => (
                    <tr
                      key={factor.name}
                      className={isDark ? 'border-t border-slate-800/70' : 'border-t border-slate-100'}
                    >
                      <td className={`py-1 font-sans ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                        {factor.name}
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
              A factor whose outvoted trades keep doing better than the ones it backed is misleading the engine,
              and its vote is turned down. Nothing moves until a factor has eight filled trades on each side and
              the gap is twice its own noise, so a lucky streak changes nothing.
            </p>
          </div>
        )}

        <div className={`text-[10px] mt-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          Confidence {(evidence.confidence * 100).toFixed(0)}% from {evidence.sampleSize} record
          {evidence.sampleSize === 1 ? '' : 's'}, weighted to {evidence.effectiveSampleSize} by recency. Newer
          trades count for more.
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Execution Accuracy</div>
          <div
            className={`text-2xl font-black font-mono mt-0.5 ${
              winRate === null ? (isDark ? 'text-slate-600' : 'text-slate-400') : 'text-emerald-400'
            }`}
          >
            {winRate === null ? '—' : `${winRate}%`}
          </div>
          <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {winRate === null
              ? 'No order has filled and resolved yet'
              : `${wins} of ${triggered} triggered (raw ${evidence.winRate?.toFixed(1)}%), adjusted for sample size`}
          </div>
        </div>

        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Take Profit Expansions</div>
          <div className="text-2xl font-black font-mono text-emerald-400 mt-0.5">{wins}</div>
          <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Full target liquidity delivered
          </div>
        </div>

        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Stop Loss Diagnostics</div>
          <div className="text-2xl font-black font-mono text-rose-400 mt-0.5">{losses}</div>
          <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Stop-hunt sweeps mapped
          </div>
        </div>

        <div
          className={`border rounded-xl p-3 ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Missed / Front-Run Orders</div>
          <div className="text-2xl font-black font-mono text-amber-400 mt-0.5">{missed}</div>
          <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Calibrates limit entry buffers
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
          <span>Dynamic Confluence Factor Weights (Calibrated by Experience)</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
          {/* Order Block Weight */}
          <div>
            <div className="flex justify-between mb-1">
              <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>Order Block (OB) Priority</span>
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
              <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>Fair Value Gap (FVG) Weight</span>
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
              <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>Liquidity Sweep Confirmation</span>
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
              <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>Macro News Volatility Shield</span>
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
          <span>Autonomous Learning Log & Diagnostic Memory</span>
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
                          <CheckCircle2 className="w-3.5 h-3.5" /> Take Profit Hit
                        </span>
                      ) : isMiss ? (
                        <span className="flex items-center gap-1 text-amber-400 font-bold">
                          <AlertTriangle className="w-3.5 h-3.5" /> Pending Order Missed / Expired
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-rose-400 font-bold">
                          <XCircle className="w-3.5 h-3.5" /> Stop Loss Hit
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
                      <strong className={isDark ? 'text-slate-300' : 'text-slate-700'}>Root Cause: </strong>
                      <span className={isDark ? 'text-slate-400' : 'text-slate-600'}>
                        {rec.rootCauseAnalysis.primaryFactor}
                      </span>
                    </div>
                    <div>
                      <strong className={isDark ? 'text-slate-300' : 'text-slate-700'}>Order Flow Behavior: </strong>
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
                      <strong>Engine Evolution Lesson: </strong>
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
            No trade outcomes evaluated yet. Once price triggers a Stop Loss, Take Profit, or misses a pending limit order, the autonomous learning diagnostic will log root cause adaptations here.
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import React, { useState } from 'react';
import { SmcStructure, TechnicalIndicators, WyckoffVolumeAnalysis, QuasimodoPattern } from '@/lib/types';
import { Activity, Compass, Layers, BarChart2, Shield, ArrowUpRight, ArrowDownRight } from 'lucide-react';

interface SMCMatrixProps {
  multiTimeframe: {
    d1: SmcStructure;
    h4: SmcStructure;
    h1: SmcStructure;
    m15: SmcStructure;
  };
  indicators: TechnicalIndicators;
  wyckoff: WyckoffVolumeAnalysis;
  quasimodo: QuasimodoPattern;
  theme?: 'dark' | 'light';
}

export default function SMCMatrix({
  multiTimeframe,
  indicators,
  wyckoff,
  quasimodo,
  theme = 'dark',
}: SMCMatrixProps) {
  const isDark = theme === 'dark';
  const [activeTab, setActiveTab] = useState<'smc' | 'indicators' | 'wyckoff_qm'>('smc');
  const timeframes: ('D1' | 'H4' | 'H1' | 'M15')[] = ['D1', 'H4', 'H1', 'M15'];

  return (
    <div
      id="institutional-smc-matrix-card"
      className={`${
        isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-sm'
      } border rounded-2xl p-5 transition-colors`}
    >
      {/* Header & Tabs */}
      <div
        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b pb-4 mb-4 ${
          isDark ? 'border-slate-800' : 'border-slate-100'
        }`}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500">
            <Compass className="w-5 h-5" />
          </div>
          <div>
            <h2 className={`text-base font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
              Struktur Institusional & Konfluensi Teknikal
            </h2>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Smart Money Concepts &bull; Likuiditas ICT &bull; Wyckoff VSA &bull; Indikator Dinamis
            </p>
          </div>
        </div>

        {/* Tab Buttons */}
        <div
          className={`flex items-center p-1 rounded-xl border self-start sm:self-auto ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <button
            type="button"
            id="tab-smc-btn"
            onClick={() => setActiveTab('smc')}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
              activeTab === 'smc'
                ? 'bg-amber-500 text-slate-950 shadow'
                : isDark
                ? 'text-slate-400 hover:text-white hover:bg-slate-800'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white'
            }`}
          >
            Matriks SMC & ICT
          </button>
          <button
            type="button"
            id="tab-indicators-btn"
            onClick={() => setActiveTab('indicators')}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
              activeTab === 'indicators'
                ? 'bg-amber-500 text-slate-950 shadow'
                : isDark
                ? 'text-slate-400 hover:text-white hover:bg-slate-800'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white'
            }`}
          >
            EMA & Momentum
          </button>
          <button
            type="button"
            id="tab-wyckoff-btn"
            onClick={() => setActiveTab('wyckoff_qm')}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
              activeTab === 'wyckoff_qm'
                ? 'bg-amber-500 text-slate-950 shadow'
                : isDark
                ? 'text-slate-400 hover:text-white hover:bg-slate-800'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white'
            }`}
          >
            Wyckoff & Quasimodo
          </button>
        </div>
      </div>

      {/* Tab 1: Multi-Timeframe SMC & ICT Matrix */}
      {activeTab === 'smc' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {timeframes.map((tf) => {
            const structure = multiTimeframe[tf.toLowerCase() as 'd1' | 'h4' | 'h1' | 'm15'];
            const isBullish = structure.trend === 'Bullish';

            return (
              <div
                key={tf}
                className={`border rounded-xl p-3.5 flex flex-col justify-between ${
                  isDark ? 'bg-slate-950 border-slate-800/90' : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div>
                  <div
                    className={`flex items-center justify-between border-b pb-2 mb-2.5 ${
                      isDark ? 'border-slate-800/80' : 'border-slate-200'
                    }`}
                  >
                    <span
                      className={`text-xs font-black font-mono px-2 py-0.5 rounded border ${
                        isDark ? 'text-white bg-slate-900 border-slate-700' : 'text-slate-900 bg-white border-slate-300'
                      }`}
                    >
                      {tf} Struktur
                    </span>
                    {structure.derivedFrom && (
                      <span
                        title={`Data ${tf} tidak tersedia, jadi bacaan ini dibuat dari candle ${structure.derivedFrom}.`}
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                          isDark
                            ? 'text-amber-300 bg-amber-500/10 border-amber-500/30'
                            : 'text-amber-700 bg-amber-50 border-amber-200'
                        }`}
                      >
                        dari {structure.derivedFrom}
                      </span>
                    )}
                    <span
                      className={`text-xs font-bold flex items-center gap-1 ${
                        isBullish ? 'text-emerald-500' : 'text-rose-500'
                      }`}
                    >
                      {isBullish ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                      {structure.trend}
                    </span>
                  </div>

                  <div className="space-y-2 text-xs">
                    {/* BOS / CHoCH */}
                    <div
                      className={`flex items-center justify-between font-mono ${
                        isDark ? 'text-slate-400' : 'text-slate-600'
                      }`}
                    >
                      <span>Level BOS:</span>
                      <strong className={isDark ? 'text-slate-200' : 'text-slate-800'}>
                        {structure.bosLevel ? `$${structure.bosLevel.toFixed(2)}` : 'Sedang terbentuk'}
                      </strong>
                    </div>

                    <div
                      className={`flex items-center justify-between font-mono ${
                        isDark ? 'text-slate-400' : 'text-slate-600'
                      }`}
                    >
                      <span>CHoCH:</span>
                      <strong className={structure.chochDetected ? 'text-amber-500 font-bold' : isDark ? 'text-slate-500' : 'text-slate-400'}>
                        {structure.chochDetected ? 'Terkonfirmasi' : 'Tidak ada'}
                      </strong>
                    </div>

                    {/* Order Block */}
                    <div
                      className={`p-2 rounded-lg border ${
                        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
                      }`}
                    >
                      <div className="text-[10px] text-amber-500 font-bold uppercase tracking-wider mb-1">
                        {structure.orderBlock.type}
                      </div>
                      <div className={`text-xs font-mono ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        ${structure.orderBlock.low.toFixed(2)} - ${structure.orderBlock.high.toFixed(2)}
                      </div>
                      <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        {structure.orderBlock.mitigated ? 'Sudah termitigasi' : 'Fresh / Belum termitigasi'}
                      </div>
                    </div>

                    {/* Fair Value Gap (FVG) */}
                    <div
                      className={`p-2 rounded-lg border ${
                        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
                      }`}
                    >
                      <div className="text-[10px] text-sky-500 font-bold uppercase tracking-wider mb-1">
                        {structure.fairValueGap.type}
                      </div>
                      <div className={`text-xs font-mono ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        ${structure.fairValueGap.bottom.toFixed(2)} - ${structure.fairValueGap.top.toFixed(2)}
                      </div>
                      <div className="text-[10px] text-emerald-500 mt-0.5">
                        Status: {structure.fairValueGap.status}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Pricing Zone */}
                <div
                  className={`mt-3 pt-2 border-t flex items-center justify-between text-xs ${
                    isDark ? 'border-slate-800/80' : 'border-slate-200'
                  }`}
                >
                  <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>Zona Harga:</span>
                  <span
                    className={`font-bold px-2 py-0.5 rounded text-[11px] ${
                      structure.pricingZone === 'Discount'
                        ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300'
                        : structure.pricingZone === 'Premium'
                        ? 'bg-rose-500/20 text-rose-600 dark:text-rose-300'
                        : isDark
                        ? 'bg-slate-800 text-slate-300'
                        : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {structure.pricingZone}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tab 2: EMA 50 & 200, RSI, Stochastic, ATR */}
      {activeTab === 'indicators' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {/* EMA 50 & EMA 200 */}
          <div
            className={`border rounded-xl p-4 ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className={`text-xs font-medium mb-1 flex items-center gap-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <Activity className="w-3.5 h-3.5 text-amber-500" />
              <span>
                EMA {indicators.emaFastPeriod ?? 50} &amp; {indicators.emaSlowPeriod ?? 200} Tren Makro
              </span>
            </div>
            <div className="mt-2 space-y-1.5 font-mono text-xs">
              <div className="flex justify-between">
                <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                  EMA {indicators.emaFastPeriod ?? 50}:
                </span>
                <strong className="text-amber-500">${indicators.ema50.toFixed(2)}</strong>
              </div>
              <div className="flex justify-between">
                <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                  EMA {indicators.emaSlowPeriod ?? 200}:
                </span>
                <strong className="text-sky-500">${indicators.ema200.toFixed(2)}</strong>
              </div>
            </div>
            <div className={`mt-2 pt-2 border-t flex justify-between ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
              <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Filter Makro:</span>
              <span className="text-emerald-500 font-bold">{indicators.trendFromEma}</span>
            </div>
          </div>

          {/* RSI (14) */}
          <div
            className={`border rounded-xl p-4 ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className={`text-xs font-medium mb-1 flex items-center gap-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <BarChart2 className="w-3.5 h-3.5 text-emerald-500" />
              <span>Relative Strength Index (RSI 14)</span>
            </div>
            <div className="text-2xl font-black font-mono text-emerald-500 mt-2">
              {indicators.rsi14.toFixed(1)}
            </div>
            <div className={`text-xs font-semibold mt-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              {indicators.rsiCondition}
            </div>
            <p className={`text-[11px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Momentum searah dengan order flow institusional di timeframe besar.
            </p>
          </div>

          {/* Stochastic Oscillator */}
          <div
            className={`border rounded-xl p-4 ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className={`text-xs font-medium mb-1 flex items-center gap-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <Activity className="w-3.5 h-3.5 text-sky-500" />
              <span>Stochastic Oscillator</span>
            </div>
            <div className="text-2xl font-black font-mono text-sky-500 mt-2">
              {indicators.stochasticK.toFixed(1)} / {indicators.stochasticD.toFixed(1)}
            </div>
            <div className={`text-xs font-semibold mt-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              {indicators.stochasticSignal}
            </div>
            <p className={`text-[11px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Persilangan konfirmasi terjadi di zona discount bawah.
            </p>
          </div>

          {/* ATR (14) Volatility Stop Buffer */}
          <div
            className={`border rounded-xl p-4 ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className={`text-xs font-medium mb-1 flex items-center gap-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <Shield className="w-3.5 h-3.5 text-rose-500" />
              <span>Average True Range (ATR 14)</span>
            </div>
            <div className={`text-2xl font-black font-mono mt-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>
              ${indicators.atr14.toFixed(2)}
            </div>
            <div className="text-xs text-amber-500 font-semibold mt-1">
              Pelindung SL dari Volatilitas
            </div>
            <p className={`text-[11px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Memberi jarak Stop Loss di luar spread broker dan noise biasa.
            </p>
          </div>
        </div>
      )}

      {/* Tab 3: Wyckoff VSA & Quasimodo Pattern */}
      {activeTab === 'wyckoff_qm' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Wyckoff Volume Spread Analysis */}
          <div
            className={`border rounded-xl p-4 ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div
              className={`flex items-center justify-between border-b pb-2 mb-3 ${
                isDark ? 'border-slate-800' : 'border-slate-200'
              }`}
            >
              <div
                className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${
                  isDark ? 'text-slate-300' : 'text-slate-800'
                }`}
              >
                <Layers className="w-3.5 h-3.5 text-amber-500" />
                <span>Metode Wyckoff & Volume Profile</span>
              </div>
              <span className="text-xs font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/30">
                Fase: {wyckoff.phase}
              </span>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex justify-between font-mono">
                <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Point of Control (POC):</span>
                <strong className="text-amber-500">${wyckoff.pointOfControlPOC.toFixed(2)}</strong>
              </div>
              <div className="flex justify-between font-mono">
                <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Volume Klimaks:</span>
                <strong className={wyckoff.volumeClimaxDetected ? 'text-rose-500' : isDark ? 'text-slate-500' : 'text-slate-400'}>
                  {wyckoff.volumeClimaxDetected ? 'Terdeteksi' : 'Tidak ada'}
                </strong>
              </div>
              <div className="flex justify-between font-mono">
                <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Penyerapan Institusional:</span>
                <strong className={wyckoff.absorptionPresent ? 'text-emerald-500' : isDark ? 'text-slate-500' : 'text-slate-400'}>
                  {wyckoff.absorptionPresent ? 'Ada di POC' : 'Tidak ada'}
                </strong>
              </div>
              <p
                className={`text-xs p-2.5 rounded-lg border leading-relaxed mt-2 ${
                  isDark ? 'text-slate-300 bg-slate-900 border-slate-800' : 'text-slate-700 bg-white border-slate-200'
                }`}
              >
                {wyckoff.description}
              </p>
            </div>
          </div>

          {/* Quasimodo (QM) / Over-Under Pattern */}
          <div
            className={`border rounded-xl p-4 ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div
              className={`flex items-center justify-between border-b pb-2 mb-3 ${
                isDark ? 'border-slate-800' : 'border-slate-200'
              }`}
            >
              <div
                className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${
                  isDark ? 'text-slate-300' : 'text-slate-800'
                }`}
              >
                <Compass className="w-3.5 h-3.5 text-sky-500" />
                <span>Pola Quasimodo (QM) / Over-Under</span>
              </div>
              <span className="text-xs font-bold px-2 py-0.5 rounded bg-sky-500/20 text-sky-600 dark:text-sky-300 border border-sky-500/30">
                {quasimodo.type}
              </span>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Bahu Kiri:</span>
                <strong className={isDark ? 'text-slate-200' : 'text-slate-800'}>${quasimodo.leftShoulder.toFixed(2)}</strong>
              </div>
              <div className="flex justify-between">
                <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Sweep Likuiditas di Kepala:</span>
                <strong className="text-amber-500">${quasimodo.headLiquiditySweep.toFixed(2)}</strong>
              </div>
              <div className="flex justify-between">
                <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Level Breakout / Shift:</span>
                <strong className={isDark ? 'text-slate-200' : 'text-slate-800'}>${quasimodo.breakLevel.toFixed(2)}</strong>
              </div>
              <div
                className={`flex justify-between p-2 rounded-lg border ${
                  isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
                }`}
              >
                <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Zona Entry Optimal:</span>
                <strong className="text-emerald-500">${quasimodo.optimalEntryZone.toFixed(2)}</strong>
              </div>
              <p className={`text-[11px] leading-relaxed mt-1 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                Sweep bahu kiri mengumpulkan order stop-loss sebelum impuls pembalikan yang tajam.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

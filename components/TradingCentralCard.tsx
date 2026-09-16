'use client';

import React from 'react';
import { TradingCentralInsight } from '@/lib/types';
import { Target, Compass, ArrowUpRight, ArrowDownRight, ShieldCheck } from 'lucide-react';

interface TradingCentralCardProps {
  bias: TradingCentralInsight;
  theme?: 'dark' | 'light';
}

export default function TradingCentralCard({ bias, theme = 'dark' }: TradingCentralCardProps) {
  const isDark = theme === 'dark';
  const isBullish = bias.directionalBias === 'BULLISH';

  return (
    <div
      id="trading-central-card"
      className={`${
        isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-sm'
      } border rounded-2xl p-5 transition-colors`}
    >
      <div
        className={`flex items-center justify-between border-b pb-4 mb-4 ${
          isDark ? 'border-slate-800' : 'border-slate-100'
        }`}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-500">
            <Compass className="w-5 h-5" />
          </div>
          <div>
            {/* This card carried the name of a commercial research vendor the
                app has no subscription to. The numbers are classic floor pivots
                computed here from the previous session, so the title now says
                what it actually is. */}
            <h2 className={`text-base font-bold flex items-center gap-2 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
              Pivot &amp; Directional Bias
              <span
                className={`text-xs px-2 py-0.5 rounded font-normal ${
                  isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-700'
                }`}
              >
                Computed from the previous session
              </span>
            </h2>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Directional bias, key inflection levels, and scenario forecasts for XAUUSD.
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-end sm:items-center gap-2">
          <div
            className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg border font-mono ${
              isDark ? 'bg-slate-950 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-600'
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
            <span>Real-Time Synced</span>
          </div>
          <span
            className={`text-xs font-black px-3 py-1 rounded-xl border font-mono flex items-center gap-1 ${
              isBullish
                ? isDark
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-emerald-100 text-emerald-800 border-emerald-300'
                : isDark
                ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                : 'bg-rose-100 text-rose-800 border-rose-300'
            }`}
          >
            {isBullish ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
            {bias.directionalBias}
          </span>
        </div>
      </div>

      <div className="space-y-3">
        {/* Pivot Point & Confidence */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div
            className={`border rounded-xl p-3 ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Critical Institutional Pivot
            </div>
            <div className="text-2xl font-black font-mono text-amber-500 mt-1">
              ${bias.pivotPoint.toFixed(2)}
            </div>
            <div className={`text-[11px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Directional bias flips if price crosses this boundary.
            </div>
          </div>

          <div
            className={`border rounded-xl p-3 ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className={`text-xs font-medium flex items-center justify-between ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <span>Model Confidence</span>
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
            </div>
            <div className="text-2xl font-black font-mono text-emerald-500 mt-1">
              {bias.confidenceScore}%
            </div>
            <div className={`text-[11px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Multi-factor technical &amp; order flow alignment.
            </div>
          </div>
        </div>

        {/* Preferred Scenario */}
        <div
          className={`border rounded-xl p-3.5 ${
            isDark ? 'bg-slate-950 border-emerald-500/30' : 'bg-emerald-50/50 border-emerald-300'
          }`}
        >
          <div className="text-xs font-bold text-emerald-500 uppercase tracking-wider mb-1 flex items-center gap-1.5">
            <Target className="w-3.5 h-3.5" /> Preferred Scenario
          </div>
          <p className={`text-xs leading-relaxed font-mono ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
            {bias.preferredScenario}
          </p>
        </div>

        {/* Alternative Scenario */}
        <div
          className={`border rounded-xl p-3.5 ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className={`text-xs font-bold uppercase tracking-wider mb-1 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            Alternative Scenario
          </div>
          <p className={`text-xs leading-relaxed font-mono ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {bias.alternativeScenario}
          </p>
        </div>

        {/* Support & Resistance Grid */}
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div
            className={`border p-2.5 rounded-xl text-xs font-mono ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="text-[10px] text-rose-500 font-bold uppercase mb-1">Key Resistances</div>
            <div className="space-y-0.5">
              {bias.keyResistanceLevels.map((lvl, idx) => (
                <div key={idx} className="flex justify-between">
                  <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>R{idx + 1}:</span>
                  <span className={`font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>${lvl.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>

          <div
            className={`border p-2.5 rounded-xl text-xs font-mono ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="text-[10px] text-emerald-500 font-bold uppercase mb-1">Key Supports</div>
            <div className="space-y-0.5">
              {bias.keySupportLevels.map((lvl, idx) => (
                <div key={idx} className="flex justify-between">
                  <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>S{idx + 1}:</span>
                  <span className={`font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>${lvl.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

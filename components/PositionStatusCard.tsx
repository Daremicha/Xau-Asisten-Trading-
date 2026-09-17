'use client';

import React from 'react';
import { CheckCircle2, Clock, Target, TrendingDown, TrendingUp } from 'lucide-react';
import { InstitutionalTradingSetup } from '@/lib/types';
import { LivePosition } from '@/lib/position-tracker';
import { formatAccountMoney } from '@/lib/account-display';

interface PositionStatusCardProps {
  setup: InstitutionalTradingSetup;
  position: LivePosition;
  currentPrice: number | null;
  /**
   * Age of that price, in seconds. The panel sits over a TradingView chart
   * running on its own live feed, so the two will not agree to the tick. Saying
   * how old this one is makes the difference readable instead of alarming.
   */
  quoteAgeSeconds?: number | null;
  theme?: 'dark' | 'light';
}

/**
 * Live state of the open order: whether it has filled, and once it has, what it
 * is floating on the way to a target or the stop.
 *
 * Sits over the top right of the chart, which is where the eye already is while
 * watching a position run.
 */
export default function PositionStatusCard({
  setup,
  position,
  currentPrice,
  quoteAgeSeconds = null,
  theme = 'dark',
}: PositionStatusCardProps) {
  const isDark = theme === 'dark';
  const pending = position.state === 'pending';
  const profitable = (position.floatingDollars ?? 0) >= 0;

  // Progress runs from the entry to the first target. A negative value means
  // price has gone the other way, toward the stop.
  const progress = position.progressToTarget ?? 0;
  const barWidth = Math.min(100, Math.abs(progress) * 100);

  const accent = pending
    ? 'text-amber-400 border-amber-500/40'
    : position.closedBy === 'SL'
    ? 'text-rose-400 border-rose-500/40'
    : position.closedBy
    ? 'text-emerald-400 border-emerald-500/40'
    : profitable
    ? 'text-emerald-400 border-emerald-500/40'
    : 'text-rose-400 border-rose-500/40';

  return (
    <div
      id="position-status-card"
      className={`w-full sm:w-64 rounded-xl border backdrop-blur-sm px-3 py-2.5 shadow-lg ${accent} ${
        isDark ? 'bg-slate-950/90' : 'bg-white/95'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">Entry status</span>
        <span
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
            isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-700'
          }`}
        >
          {setup.orderType}
        </span>
      </div>

      {pending ? (
        <>
          <div className="flex items-center gap-1.5 font-bold text-sm">
            <Clock className="w-4 h-4 shrink-0" />
            <span>Not filled yet</span>
          </div>
          <div className={`text-[11px] font-mono mt-1 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {position.distanceToEntryPips} pips to {setup.entryPrice.toFixed(2)}
          </div>
          <div className={`text-[10px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
            Current {currentPrice === null ? '—' : currentPrice.toFixed(2)}
            {quoteAgeSeconds !== null && (
              <span className={quoteAgeSeconds > 30 ? 'text-amber-500' : undefined}>
                {' '}
                &bull; {quoteAgeSeconds < 60 ? `${quoteAgeSeconds}s` : `${Math.floor(quoteAgeSeconds / 60)}m`} old
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-1.5 font-bold text-sm">
            {position.closedBy ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : profitable ? (
              <TrendingUp className="w-4 h-4 shrink-0" />
            ) : (
              <TrendingDown className="w-4 h-4 shrink-0" />
            )}
            <span>
              {position.closedBy
                ? `Closed at ${position.closedBy}`
                : profitable
                ? 'Floating profit'
                : 'Floating loss'}
            </span>
          </div>

          <div className="font-mono font-black text-lg leading-tight mt-0.5">
            {formatAccountMoney(position.floatingDollars ?? 0, setup.accountType, { signed: true })}
          </div>
          <div className={`text-[11px] font-mono ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {profitable ? '+' : ''}
            {position.floatingPips} pips from {setup.entryPrice.toFixed(2)}
            {quoteAgeSeconds !== null && (
              <span className={quoteAgeSeconds > 30 ? 'text-amber-500' : isDark ? 'text-slate-500' : 'text-slate-500'}>
                {' '}
                &bull; {quoteAgeSeconds < 60 ? `${quoteAgeSeconds}s` : `${Math.floor(quoteAgeSeconds / 60)}m`} old
              </span>
            )}
          </div>

          {/* How far price has run toward the first target, or back toward the stop. */}
          <div className={`mt-2 h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
            <div
              className={`h-full rounded-full transition-all ${
                progress >= 0 ? 'bg-emerald-500' : 'bg-rose-500'
              }`}
              style={{ width: `${barWidth}%` }}
            />
          </div>
          <div
            className={`flex items-center justify-between text-[10px] mt-1 ${
              isDark ? 'text-slate-500' : 'text-slate-500'
            }`}
          >
            <span className="font-mono">SL {setup.stopLoss.toFixed(2)}</span>
            <span className="flex items-center gap-1 font-mono">
              <Target className="w-3 h-3" />
              TP1 {setup.takeProfit1.toFixed(2)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

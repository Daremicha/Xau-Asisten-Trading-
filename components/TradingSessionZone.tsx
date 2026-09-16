'use client';

import React, { useState, useEffect } from 'react';
import { getGlobalTradingSessions } from '@/lib/market-engine';
import { TradingSessionInfo } from '@/lib/types';
import { Clock, Globe, Zap, Compass, AlertCircle } from 'lucide-react';

interface TradingSessionZoneProps {
  theme?: 'dark' | 'light';
}

export default function TradingSessionZone({ theme = 'dark' }: TradingSessionZoneProps) {
  const isDark = theme === 'dark';
  const [sessions, setSessions] = useState<TradingSessionInfo[]>([]);
  const [localTimeStr, setLocalTimeStr] = useState<string>('');
  const [localDateStr, setLocalDateStr] = useState<string>('');
  const [localTimezone, setLocalTimezone] = useState<string>('');

  useEffect(() => {
    const updateTimeAndSessions = () => {
      setSessions(getGlobalTradingSessions());
      const now = new Date();
      setLocalTimeStr(
        now.toLocaleTimeString('en-US', {
          timeZone: 'Asia/Jakarta',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      );
      setLocalDateStr(
        now.toLocaleDateString('en-US', {
          timeZone: 'Asia/Jakarta',
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      );
      setLocalTimezone('WIB / UTC+7');
    };

    updateTimeAndSessions();
    const interval = setInterval(updateTimeAndSessions, 1000);
    return () => clearInterval(interval);
  }, []);

  const getVolatilityBadge = (level: 'Low' | 'Moderate' | 'High' | 'Extreme') => {
    switch (level) {
      case 'Extreme':
        return (
          <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/30">
            Extreme Volume
          </span>
        );
      case 'High':
        return (
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
            High Volatility
          </span>
        );
      case 'Moderate':
      default:
        return (
          <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30">
            Moderate Range
          </span>
        );
    }
  };

  return (
    <div
      id="trading-session-zone-card"
      className={`${
        isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-sm'
      } border rounded-2xl p-5 transition-colors`}
    >
      {/* Header with live local clock */}
      <div
        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b ${
          isDark ? 'border-slate-800' : 'border-slate-100'
        } pb-4 mb-4`}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400">
            <Globe className="w-5 h-5" />
          </div>
          <div>
            <h2
              className={`text-base font-bold flex items-center gap-2 ${
                isDark ? 'text-slate-100' : 'text-slate-900'
              }`}
            >
              Institutional Trading Sessions
              <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 font-semibold border border-amber-500/20">
                24H Cycle
              </span>
            </h2>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Tokyo, London, and New York market hours synchronized to WIB (UTC+7 Jakarta).
            </p>
          </div>
        </div>

        {/* Local Clock Badge */}
        <div
          className={`flex flex-wrap items-center gap-2.5 px-3.5 py-1.5 rounded-xl border font-mono ${
            isDark ? 'bg-slate-950 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
          }`}
        >
          <div className="flex items-center gap-1.5 text-xs">
            <Clock className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-[11px] font-medium opacity-70">Western Indonesia Time:</span>
            <span className="font-semibold text-slate-300">{localDateStr}</span>
            <span className="text-slate-500">•</span>
            <span className="font-bold text-amber-400">{localTimeStr || '--:--:--'} WIB</span>
          </div>
          <span className="text-[10px] opacity-60 hidden md:inline">({localTimezone})</span>
        </div>
      </div>

      {/* Grid of 4 Session Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {sessions.map((sess) => (
          <div
            key={sess.id}
            className={`border rounded-xl p-3.5 flex flex-col justify-between transition-all ${
              sess.isActive
                ? isDark
                  ? 'bg-slate-950 border-emerald-500/40 ring-1 ring-emerald-500/20 shadow-sm'
                  : 'bg-emerald-50/40 border-emerald-400/60 shadow-sm'
                : isDark
                ? 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700'
                : 'bg-slate-50/70 border-slate-200/80 hover:border-slate-300'
            }`}
          >
            <div>
              {/* Session Title & Active Status */}
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      sess.isActive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
                    }`}
                  />
                  <h3
                    className={`text-sm font-bold tracking-tight ${
                      isDark ? 'text-white' : 'text-slate-900'
                    }`}
                  >
                    {sess.name}
                  </h3>
                </div>
                {sess.isActive ? (
                  <span className="text-[10px] font-black font-mono px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                    LIVE
                  </span>
                ) : (
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                      isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    CLOSED
                  </span>
                )}
              </div>

              {/* City / Hub */}
              <div className={`text-[11px] font-medium mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {sess.city} &bull; {sess.region}
              </div>

              {/* Local Hours Box */}
              <div
                className={`p-2.5 rounded-lg border font-mono text-xs mb-2.5 ${
                  isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
                }`}
              >
                <div className="flex justify-between items-center text-[11px] mb-0.5">
                  <span className={`${isDark ? 'text-slate-400' : 'text-slate-500'}`}>WIB Hours:</span>
                  <span className="font-bold text-amber-400">
                    {sess.localOpenFormatted} - {sess.localCloseFormatted} WIB
                  </span>
                </div>
                <div className="flex justify-between items-center text-[10px] opacity-65">
                  <span>UTC Hours:</span>
                  <span>
                    {String(sess.utcOpen).padStart(2, '0')}:00 - {String(sess.utcClose).padStart(2, '0')}:00 UTC
                  </span>
                </div>
              </div>

              {/* Volatility & Characteristics */}
              <div className="space-y-1 mb-3">
                <div className="flex items-center justify-between">
                  <span className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Volatility:</span>
                  {getVolatilityBadge(sess.volatilityLevel)}
                </div>
                <p className={`text-[11px] leading-relaxed mt-1 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {sess.characteristics}
                </p>
              </div>
            </div>

            {/* Bottom: Countdown / Progress Bar */}
            <div className={`pt-2 border-t ${isDark ? 'border-slate-800/80' : 'border-slate-200/80'}`}>
              <div className="flex justify-between items-center text-[11px] font-mono mb-1">
                <span className={sess.isActive ? 'text-emerald-400 font-bold' : isDark ? 'text-slate-400' : 'text-slate-500'}>
                  {sess.statusText}
                </span>
                {sess.isActive && (
                  <span className="text-[10px] text-slate-400">{sess.progressPercentage}% elapsed</span>
                )}
              </div>
              {sess.isActive ? (
                <div className={`w-full h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
                  <div
                    className="h-full bg-emerald-400 rounded-full transition-all duration-1000"
                    style={{ width: `${sess.progressPercentage}%` }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

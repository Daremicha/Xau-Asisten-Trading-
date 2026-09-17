'use client';

import React, { useState, useEffect } from 'react';
import { ForexFactoryEvent } from '@/lib/types';
import { filterUpcoming } from '@/lib/economic-calendar';
import { AlertTriangle, Calendar, TrendingUp, Clock, Hourglass, ShieldCheck } from 'lucide-react';

interface EconomicCalendarProps {
  events: ForexFactoryEvent[];
  /** Explains an empty calendar, so it never looks like a loading state. */
  notice?: string | null;
  theme?: 'dark' | 'light';
}

export default function EconomicCalendar({ events, notice = null, theme = 'dark' }: EconomicCalendarProps) {
  const isDark = theme === 'dark';
  const [upcomingEvents, setUpcomingEvents] = useState<ForexFactoryEvent[]>([]);
  const [currentTimeMs, setCurrentTimeMs] = useState<number>(0);

  useEffect(() => {
    // Periodic refresh every 10 seconds to update countdowns and filter out past events
    const updateEvents = () => {
      const now = Date.now();
      setCurrentTimeMs(now);
      const filtered = filterUpcoming(events);
      setUpcomingEvents(filtered);
    };

    updateEvents();
    const timer = setInterval(updateEvents, 10000);
    return () => clearInterval(timer);
  }, [events]);

  const getImpactBadge = (impact: 'High' | 'Medium' | 'Low') => {
    switch (impact) {
      case 'High':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
            High Impact
          </span>
        );
      case 'Medium':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            Medium Impact
          </span>
        );
      default:
        return (
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded ${
              isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-200 text-slate-700'
            }`}
          >
            Low Impact
          </span>
        );
    }
  };

  const formatLocalTime = (scheduledIso?: string) => {
    if (!scheduledIso) return 'Upcoming';
    try {
      const date = new Date(scheduledIso);
      const dayStr = date.toLocaleDateString('en-US', {
        timeZone: 'Asia/Jakarta',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const timeStr = date.toLocaleTimeString('en-US', {
        timeZone: 'Asia/Jakarta',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }) + ' WIB';
      return `${dayStr}, ${timeStr}`;
    } catch {
      return 'Upcoming';
    }
  };

  const getCountdownString = (scheduledIso?: string) => {
    if (!scheduledIso) return 'Scheduled';
    const diffMs = new Date(scheduledIso).getTime() - currentTimeMs;
    if (diffMs <= 0) return 'Released';
    const totalMinutes = Math.floor(diffMs / (60 * 1000));
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `In ${days}d ${hours % 24}h`;
    }
    if (hours > 0) {
      return `In ${hours}h ${mins}m`;
    }
    return `In ${mins}m`;
  };

  return (
    <div
      id="forex-factory-calendar-card"
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
          <div className="w-9 h-9 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
            <Calendar className="w-5 h-5" />
          </div>
          <div>
            <h2
              className={`text-base font-bold flex items-center gap-2 ${
                isDark ? 'text-slate-100' : 'text-slate-900'
              }`}
            >
              Upcoming USD Calendar
              <span className="text-xs px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 font-semibold border border-rose-500/20">
                Live Filtered
              </span>
            </h2>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Gold is priced in dollars, so only USD releases are listed. Times in WIB (UTC+7 Jakarta).
            </p>
          </div>
        </div>

        <div
          className={`flex items-center gap-2 px-3 py-1 rounded-xl text-xs font-mono border ${
            isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
          }`}
        >
          <Clock className="w-3.5 h-3.5 text-amber-400" />
          <span>All Times in WIB (UTC+7)</span>
        </div>
      </div>

      {/* Events Table / Cards */}
      {upcomingEvents.length === 0 ? (
        <div
          className={`text-center py-8 px-4 rounded-xl border border-dashed ${
            isDark ? 'border-slate-800 bg-slate-950/40 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-500'
          }`}
        >
          {/* An unconnected calendar is not the same as a quiet one, and saying
              the releases have completed when none were ever fetched would be
              a claim the app cannot support. */}
          {notice ? (
            <>
              <AlertTriangle className="w-8 h-8 mx-auto text-amber-400 mb-2 opacity-80" />
              <p className="text-sm font-semibold">No economic calendar connected</p>
              <p className="text-xs mt-1 opacity-70">{notice}</p>
            </>
          ) : (
            <>
              <ShieldCheck className="w-8 h-8 mx-auto text-emerald-400 mb-2 opacity-80" />
              <p className="text-sm font-semibold">No high-impact release scheduled ahead</p>
              <p className="text-xs mt-1 opacity-70">
                Order flow is currently driven by technical liquidity rather than a pending catalyst.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {upcomingEvents.map((evt) => (
            <div
              key={evt.id}
              className={`border rounded-xl p-3.5 transition-all ${
                isDark
                  ? 'bg-slate-950 border-slate-800/90 hover:border-slate-700'
                  : 'bg-slate-50/80 border-slate-200 hover:border-slate-300'
              }`}
            >
              <div
                className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b ${
                  isDark ? 'border-slate-800/60' : 'border-slate-200/70'
                } pb-2.5 mb-2.5`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    {evt.currency}
                  </span>
                  <h3
                    className={`text-sm font-bold ${
                      isDark ? 'text-white' : 'text-slate-900'
                    }`}
                  >
                    {evt.title}
                  </h3>
                </div>

                <div className="flex items-center flex-wrap gap-2.5">
                  {getImpactBadge(evt.impact)}

                  {/* Local Time and Countdown */}
                  <div
                    className={`flex items-center gap-1.5 px-2 py-0.5 rounded font-mono text-xs border ${
                      isDark
                        ? 'bg-slate-900 border-slate-800 text-slate-200'
                        : 'bg-white border-slate-200 text-slate-800 shadow-2xs'
                    }`}
                  >
                    <Clock className="w-3 h-3 text-amber-400" />
                    <span className="font-bold">{formatLocalTime(evt.scheduledTimestamp)} Local</span>
                  </div>

                  <span className="text-xs font-bold font-mono px-2 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/25 flex items-center gap-1">
                    <Hourglass className="w-3 h-3" />
                    {getCountdownString(evt.scheduledTimestamp)}
                  </span>
                </div>
              </div>

              {/* Figures Grid */}
              <div className="grid grid-cols-3 gap-2 text-xs font-mono mb-2.5">
                <div
                  className={`p-2 rounded-lg border ${
                    isDark ? 'bg-slate-900/80 border-slate-800' : 'bg-white border-slate-200'
                  }`}
                >
                  <div className={`text-[10px] uppercase font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    Forecast
                  </div>
                  <div className={`font-bold mt-0.5 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                    {evt.forecast}
                  </div>
                </div>
                <div
                  className={`p-2 rounded-lg border ${
                    isDark ? 'bg-slate-900/80 border-slate-800' : 'bg-white border-slate-200'
                  }`}
                >
                  <div className={`text-[10px] uppercase font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    Previous
                  </div>
                  <div className={`font-bold mt-0.5 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                    {evt.previous}
                  </div>
                </div>
                <div
                  className={`p-2 rounded-lg border ${
                    isDark ? 'bg-slate-900/80 border-slate-800' : 'bg-white border-slate-200'
                  }`}
                >
                  <div className={`text-[10px] uppercase font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    Status
                  </div>
                  <div className="text-amber-400 font-bold mt-0.5">Upcoming</div>
                </div>
              </div>

              {/* Market Implication for Gold */}
              <div
                className={`flex items-start gap-2 text-xs p-2 rounded-lg border ${
                  isDark ? 'bg-slate-900/60 border-slate-800/80 text-slate-300' : 'bg-white border-slate-200 text-slate-700'
                }`}
              >
                <TrendingUp className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <strong className={isDark ? 'text-amber-300' : 'text-amber-600'}>Gold Impact Rationale: </strong>
                  <span>{evt.marketImplication}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

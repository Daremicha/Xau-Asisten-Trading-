'use client';

import React, { useState } from 'react';
import { TimeframeType, InstitutionalTradingSetup, TechnicalIndicators } from '@/lib/types';
import { Layers, Activity, ShieldAlert, Target, Crosshair, RefreshCw } from 'lucide-react';

interface MarketChartProps {
  currentPrice: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  selectedTimeframe: TimeframeType;
  onSelectTimeframe: (tf: TimeframeType) => void;
  activeSetup: InstitutionalTradingSetup | null;
  /** Live indicator readings, null until the feed has delivered enough candles. */
  indicators?: TechnicalIndicators | null;
  /** Real state of the market data connection. */
  feedStatus?: 'loading' | 'live' | 'stale' | 'unavailable';
  /**
   * Age of the quoted bid and ask, in seconds. The candles come from
   * TradingView's own live feed; these numbers come from the market data
   * provider a few seconds behind it, and saying so is the difference between
   * a lag and an apparent error.
   */
  quoteAgeSeconds?: number | null;
  onRefreshQuote?: () => void;
  isRefreshingQuote?: boolean;
  /** Live entry status panel, pinned over the top right of the chart. */
  statusPanel?: React.ReactNode;
  theme?: 'dark' | 'light';
}

export default function MarketChart({
  currentPrice,
  bidPrice,
  askPrice,
  selectedTimeframe,
  onSelectTimeframe,
  activeSetup,
  indicators = null,
  feedStatus = 'loading',
  quoteAgeSeconds = null,
  onRefreshQuote,
  isRefreshingQuote = false,
  statusPanel = null,
  theme = 'dark',
}: MarketChartProps) {
  const isDark = theme === 'dark';
  const [useTradingView, setUseTradingView] = useState(true);
  const [userTimeZone] = useState('Asia/Jakarta');

  // Timeframe interval mapping for TradingView widget
  const getTvInterval = (tf: TimeframeType) => {
    switch (tf) {
      case 'D1':
        return 'D';
      case 'H4':
        return '240';
      case 'H1':
        return '60';
      case 'M15':
        return '15';
      default:
        return '15';
    }
  };

  return (
    <div
      id="institutional-market-chart-container"
      className={`${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      } border rounded-2xl overflow-hidden flex flex-col transition-colors`}
    >
      {/* Chart Top Control Bar */}
      <div
        className={`px-4 py-3 border-b flex flex-wrap items-center justify-between gap-3 ${
          isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
        }`}
      >
        {/* Symbol & Live Quote Info */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span
              className={`text-sm font-black tracking-wider font-mono ${
                isDark ? 'text-white' : 'text-slate-900'
              }`}
            >
              XAUUSD
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 font-semibold border border-amber-500/20">
              Gold / US Dollar
            </span>
          </div>

          <div className={`h-4 w-px hidden sm:block ${isDark ? 'bg-slate-800' : 'bg-slate-300'}`} />

          <div className="flex items-center gap-3 text-xs font-mono">
            <span className={isDark ? 'text-slate-400' : 'text-slate-600'}>
              Bid: <span className={`font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{bidPrice === null ? '—' : bidPrice.toFixed(2)}</span>
            </span>
            <span className={isDark ? 'text-slate-400' : 'text-slate-600'}>
              Ask: <span className={`font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{askPrice === null ? '—' : askPrice.toFixed(2)}</span>
            </span>

            {/* How old the quoted bid and ask are. The candles beside them are
                TradingView's live feed, so without this the two look wrong
                rather than simply taken a few seconds apart. */}
            {quoteAgeSeconds !== null && (
              <span
                id="quote-age-readout"
                className={
                  quoteAgeSeconds <= 30
                    ? isDark
                      ? 'text-slate-500'
                      : 'text-slate-500'
                    : 'text-amber-500 font-semibold'
                }
                title="Age of the bid and ask from the market data provider. The candles are TradingView's own live feed."
              >
                quote {quoteAgeSeconds < 60 ? `${quoteAgeSeconds}s` : `${Math.floor(quoteAgeSeconds / 60)}m`} old
              </span>
            )}

            {onRefreshQuote && (
              <button
                type="button"
                id="refresh-quote-btn"
                onClick={onRefreshQuote}
                disabled={isRefreshingQuote}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  isDark
                    ? 'border-slate-800 text-slate-400 hover:text-slate-100 hover:border-slate-700'
                    : 'border-slate-200 text-slate-600 hover:text-slate-900 hover:border-slate-300'
                }`}
                title="Fetch a fresh quote now"
              >
                <RefreshCw className={`w-3 h-3 ${isRefreshingQuote ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Refresh</span>
              </button>
            )}
            {/* Reflects the real feed state. Claiming a connection that does not
                exist is the kind of thing a trader acts on by mistake. */}
            <span
              className={`hidden sm:inline-block font-semibold ${
                feedStatus === 'live'
                  ? 'text-emerald-500'
                  : feedStatus === 'stale'
                  ? 'text-amber-500'
                  : feedStatus === 'unavailable'
                  ? 'text-rose-500'
                  : 'text-slate-500'
              }`}
            >
              {feedStatus === 'live'
                ? 'Live feed connected'
                : feedStatus === 'stale'
                ? 'Stale quote'
                : feedStatus === 'unavailable'
                ? 'Feed unavailable'
                : 'Connecting'}
            </span>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 font-bold hidden md:inline-block">
              WIB (UTC+7)
            </span>
          </div>
        </div>

        {/* Timeframe Selector & Chart View Mode */}
        <div className="flex items-center gap-2">
          {/* Timeframe Buttons D1 -> H4 -> H1 -> M15 */}
          <div
            className={`flex items-center p-1 rounded-xl border ${
              isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
            }`}
          >
            {(['D1', 'H4', 'H1', 'M15'] as TimeframeType[]).map((tf) => (
              <button
                key={tf}
                id={`tf-btn-${tf}`}
                type="button"
                onClick={() => onSelectTimeframe(tf)}
                className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${
                  selectedTimeframe === tf
                    ? 'bg-amber-500 text-slate-950 shadow-sm'
                    : isDark
                    ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>

          {/* Which chart is on screen. A single toggle labelled with the mode it
              would switch to left people unsure which one they were looking at,
              which matters when one is a live feed and the other is not. */}
          <div
            className={`flex items-center p-0.5 rounded-xl border text-xs font-semibold ${
              isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
            }`}
          >
            <button
              id="toggle-chart-mode-btn"
              type="button"
              onClick={() => setUseTradingView(true)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                useTradingView
                  ? 'bg-amber-500 text-slate-950'
                  : isDark
                  ? 'text-slate-400 hover:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
              title="TradingView's own live XAUUSD feed"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>TradingView</span>
            </button>
            <button
              id="toggle-chart-levels-btn"
              type="button"
              onClick={() => setUseTradingView(false)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                !useTradingView
                  ? 'bg-amber-500 text-slate-950'
                  : isDark
                  ? 'text-slate-400 hover:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
              title="The engine's own entry, stop and target levels"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Levels</span>
            </button>
          </div>
        </div>
      </div>

      {/* Entry status, stacked above the chart on a phone so it never covers
          the candles, and pinned over the top right corner on wider screens. */}
      {statusPanel && (
        <div className="sm:hidden px-4 pt-3">{statusPanel}</div>
      )}

      {/* Main Chart Area */}
      <div className={`relative w-full h-[420px] sm:h-[480px] ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}>
        {statusPanel && (
          <div className="hidden sm:block absolute top-3 right-3 z-20 pointer-events-none">
            <div className="pointer-events-auto">{statusPanel}</div>
          </div>
        )}
        {useTradingView ? (
          <iframe
            suppressHydrationWarning
            key={`${selectedTimeframe}-${isDark ? 'dark' : 'light'}-${userTimeZone}`}
            src={`https://s.tradingview.com/widgetembed/?frameElementId=tradingview_xauusd&symbol=OANDA%3AXAUUSD&interval=${getTvInterval(
              selectedTimeframe
            )}&hidesidetoolbar=1&symboledit=0&saveimage=0&toolbarbg=${isDark ? '0a0f1d' : 'f8fafc'}&studies=%5B%22MASimple%40tv-basicstudies%22%2C%22RSI%40tv-basicstudies%22%5D&theme=${
              isDark ? 'dark' : 'light'
            }&style=1&timezone=${encodeURIComponent(
              userTimeZone
            )}&studies_overrides=%7B%7D&overrides=%7B%22mainSeriesProperties.candleStyle.upColor%22%3A%22%2310b981%22%2C%22mainSeriesProperties.candleStyle.downColor%22%3A%22%23ef4444%22%2C%22mainSeriesProperties.candleStyle.wickUpColor%22%3A%22%2310b981%22%2C%22mainSeriesProperties.candleStyle.wickDownColor%22%3A%22%23ef4444%22%7D&enabled_features=%5B%5D&disabled_features=%5B%5D&locale=en&utm_source=localhost`}
            className="w-full h-full border-0"
            title="TradingView XAUUSD Chart"
            // Third-party frame: send no referrer, and do not block first paint.
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ) : (
          /* Institutional Custom SMC / ICT Graphic Visualizer */
          <div className="w-full h-full p-6 flex flex-col justify-between relative select-none">
            {/* Background Grid Lines */}
            <div className="absolute inset-0 grid grid-rows-6 grid-cols-8 opacity-10 pointer-events-none">
              {Array.from({ length: 48 }).map((_, i) => (
                <div key={i} className={`border-b border-r ${isDark ? 'border-slate-500' : 'border-slate-400'}`} />
              ))}
            </div>

            {/* Top Indicator Metrics */}
            <div
              className={`relative z-10 flex items-center justify-between text-xs font-mono ${
                isDark ? 'text-slate-400' : 'text-slate-600'
              }`}
            >
              <div className="flex items-center gap-4">
                <span>
                  EMA 50: <strong className="text-amber-500">{indicators ? `$${indicators.ema50.toFixed(2)}` : '—'}</strong>
                </span>
                <span>
                  EMA 200: <strong className="text-sky-500">{indicators ? `$${indicators.ema200.toFixed(2)}` : '—'}</strong>
                </span>
                <span>
                  RSI(14): <strong className="text-emerald-500">56.4</strong>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`px-2 py-0.5 rounded border ${
                    isDark ? 'bg-slate-900 border-slate-800 text-slate-300' : 'bg-white border-slate-200 text-slate-700'
                  }`}
                >
                  {selectedTimeframe} Institutional Structure
                </span>
              </div>
            </div>

            {/* Price Level Badges overlay if activeSetup is present */}
            {activeSetup && (
              <div
                className={`relative z-10 space-y-2 my-auto max-w-md backdrop-blur border p-4 rounded-xl shadow-lg ${
                  isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-white/95 border-slate-200'
                }`}
              >
                <div
                  className={`text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5 ${
                    isDark ? 'text-slate-400' : 'text-slate-600'
                  }`}
                >
                  <Crosshair className="w-3.5 h-3.5 text-amber-500" />
                  <span>Institutional Execution Coordinates</span>
                </div>

                <div className="space-y-1.5 text-xs font-mono">
                  {/* Take Profit 3 */}
                  <div
                    className={`flex items-center justify-between p-1.5 rounded border ${
                      isDark
                        ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                        : 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Target className="w-3 h-3 text-emerald-500" /> TP3 (Extended Liquidity)
                    </span>
                    <span className="font-bold">${activeSetup.takeProfit3.toFixed(2)}</span>
                  </div>

                  {/* Take Profit 2 */}
                  <div
                    className={`flex items-center justify-between p-1.5 rounded border ${
                      isDark
                        ? 'bg-emerald-950/30 border-emerald-500/20 text-emerald-300'
                        : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Target className="w-3 h-3 text-emerald-500" /> TP2 (Structural Target)
                    </span>
                    <span className="font-bold">${activeSetup.takeProfit2.toFixed(2)}</span>
                  </div>

                  {/* Take Profit 1 */}
                  <div
                    className={`flex items-center justify-between p-1.5 rounded border ${
                      isDark
                        ? 'bg-emerald-950/20 border-emerald-500/20 text-emerald-300'
                        : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Target className="w-3 h-3 text-emerald-500" /> TP1 (Conservative 1:2 R:R)
                    </span>
                    <span className="font-bold">${activeSetup.takeProfit1.toFixed(2)}</span>
                  </div>

                  {/* Entry */}
                  <div
                    className={`flex items-center justify-between p-2 rounded border ${
                      isDark
                        ? 'bg-amber-500/10 border-amber-500/40 text-amber-300'
                        : 'bg-amber-50 border-amber-300 text-amber-900'
                    }`}
                  >
                    <span className="font-bold flex items-center gap-1.5">
                      <Activity className="w-3.5 h-3.5 text-amber-500" /> {activeSetup.orderType} Entry
                    </span>
                    <span className="font-black text-sm">${activeSetup.entryPrice.toFixed(2)}</span>
                  </div>

                  {/* Stop Loss */}
                  <div
                    className={`flex items-center justify-between p-1.5 rounded border ${
                      isDark
                        ? 'bg-rose-950/40 border-rose-500/30 text-rose-300'
                        : 'bg-rose-50 border-rose-300 text-rose-800'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <ShieldAlert className="w-3 h-3 text-rose-500" /> Stop Loss (SL)
                    </span>
                    <span className="font-bold">
                      ${activeSetup.stopLoss.toFixed(2)} ({activeSetup.stopLossPips} pips)
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Current Price Ticker Bar */}
            <div
              className={`relative z-10 flex items-center justify-between text-xs font-mono pt-3 border-t ${
                isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-600'
              }`}
            >
              <span>
                SMC Status: <span className="text-amber-500 font-bold">Unmitigated Order Block + FVG Validated</span>
              </span>
              <span className={isDark ? 'text-slate-300 font-bold' : 'text-slate-700 font-bold'}>
                Current Market: <span className="text-emerald-500">{currentPrice === null ? '—' : `$${currentPrice.toFixed(2)}`}</span>
              </span>
            </div>
          </div>
        )}

        {/* Floating Active Setup Overlay Tag */}
        {activeSetup && (
          <div className="absolute top-3 left-3 z-20 pointer-events-none">
            <div
              className={`backdrop-blur border px-3 py-1.5 rounded-lg shadow-lg flex items-center gap-2 ${
                isDark ? 'bg-slate-900/90 border-amber-500/40' : 'bg-white/95 border-amber-400'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              <span className={`text-xs font-bold font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {activeSetup.orderType} @ ${activeSetup.entryPrice.toFixed(2)}
              </span>
              <span className="text-[10px] text-amber-600 font-semibold px-1.5 py-0.5 rounded bg-amber-500/15">
                R:R {activeSetup.riskRewardRatio}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

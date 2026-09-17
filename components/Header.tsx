'use client';

import React, { useState, useEffect } from 'react';
import { User, signInWithPopup, signOut } from 'firebase/auth';
import { auth, googleProvider, describeAuthError } from '@/lib/firebase';
import { LogIn, LogOut, TrendingUp, Clock, Sun, Moon, Bell, BellRing, BellOff, AlertTriangle } from 'lucide-react';
import { BrokerId, BROKER_PROFILES } from '@/lib/types';

interface HeaderProps {
  user: User | null;
  authLoading: boolean;
  killZone: {
    currentZone: string;
    isHighVolatilityTiming: boolean;
    description: string;
  };
  marketPrice: number | null;
  change24h: number | null;
  /** Live feed state, so the header never claims a connection it does not have. */
  feedStatus?: 'loading' | 'live' | 'stale' | 'unavailable';
  /**
   * False when the quote is the COMEX futures contract rather than spot. The
   * header is where a price is read at a glance, so it is the one place that
   * must never call one instrument by the other's name.
   */
  quoteIsSpot?: boolean;
  selectedBroker?: BrokerId;
  notificationPermission?: NotificationPermission | 'unsupported';
  onRequestNotification?: () => void;
  theme?: 'dark' | 'light';
  onToggleTheme?: () => void;
}

export default function Header({
  user,
  authLoading,
  killZone,
  marketPrice,
  change24h,
  feedStatus = 'loading',
  quoteIsSpot = true,
  selectedBroker = 'EXNESS',
  notificationPermission = 'default',
  onRequestNotification,
  theme = 'dark',
  onToggleTheme,
}: HeaderProps) {
  const isDark = theme === 'dark';
  const [authError, setAuthError] = useState<string | null>(null);
  const [localTime, setLocalTime] = useState<string>('');
  const [localDate, setLocalDate] = useState<string>('');

  const brokerInfo = BROKER_PROFILES[selectedBroker] || BROKER_PROFILES.EXNESS;

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setLocalDate(
        d.toLocaleDateString('en-US', {
          timeZone: 'Asia/Jakarta',
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      );
      setLocalTime(
        d.toLocaleTimeString('en-US', {
          timeZone: 'Asia/Jakarta',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }) + ' WIB'
      );
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleGoogleLogin = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      // Swallowing this made the button look broken. Sign-in fails for
      // specific, fixable reasons, so say which one.
      setAuthError(describeAuthError(err));
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.warn('Sign-out error:', err);
    }
  };

  const isPositive = (change24h ?? 0) >= 0;

  const feedLabel: Record<string, { text: string; dot: string; tone: string }> = {
    loading: { text: 'Connecting to feed', dot: 'bg-slate-400', tone: isDark ? 'text-slate-400' : 'text-slate-500' },
    live: { text: 'XAUUSD Live Spot', dot: 'bg-emerald-400 animate-ping', tone: isDark ? 'text-slate-400' : 'text-slate-500' },
    stale: { text: 'Stale quote, not live', dot: 'bg-amber-400', tone: 'text-amber-500' },
    unavailable: { text: 'Feed unavailable', dot: 'bg-rose-500', tone: 'text-rose-500' },
  };
  const feed =
    !quoteIsSpot && feedStatus !== 'unavailable'
      ? {
          text: 'COMEX futures, not spot',
          dot: 'bg-amber-400',
          tone: 'text-amber-500',
        }
      : feedLabel[feedStatus] ?? feedLabel.loading;

  return (
    <header
      id="institutional-header"
      className={`w-full sticky top-0 z-40 shadow-sm border-b transition-colors ${
        isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between gap-4">
        {/* Brand & Market Identity */}
        {/* min-w-0 so the title can truncate on a narrow screen instead of
            pushing the controls past the right edge of the viewport. */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-500 font-black text-xl shadow-inner shrink-0">
            <TrendingUp className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1
                className={`text-lg sm:text-xl font-bold tracking-tight truncate ${
                  isDark ? 'text-white' : 'text-slate-900'
                }`}
              >
                XAUUSD Institutional Assistant
              </h1>
              <span className="px-2 py-0.5 text-xs font-semibold rounded-md bg-amber-500/15 text-amber-500 border border-amber-500/30">
                SMC &bull; ICT
              </span>
            </div>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Institutional Order Flow &bull; Multi-Timeframe Strategy Engine
            </p>
          </div>
        </div>

        {/* Live Market Price & Kill Zone Status */}
        <div className="hidden md:flex items-center gap-6">
          <div className="text-right">
            <div className={`text-xs font-medium flex items-center justify-end gap-1.5 ${feed.tone}`}>
              <span className={`w-2 h-2 rounded-full inline-block ${feed.dot}`} />
              <span>{feed.text}</span>
            </div>
            <div className="flex items-center gap-2 justify-end">
              <span className="text-lg font-bold font-mono tracking-tight text-amber-500">
                {marketPrice === null ? '—' : `$${marketPrice.toFixed(2)}`}
              </span>
              {change24h !== null && (
                <span
                  className={`text-xs font-semibold font-mono ${
                    isPositive ? 'text-emerald-500' : 'text-rose-500'
                  }`}
                >
                  {isPositive ? '+' : ''}
                  {change24h.toFixed(2)}
                </span>
              )}
            </div>
          </div>

          <div className={`h-8 w-px ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />

          {/* Institutional Session Kill Zone & Local Clock with Day and Date */}
          <div className="text-left">
            <div
              className={`text-xs font-medium flex items-center justify-between gap-1.5 ${
                isDark ? 'text-slate-400' : 'text-slate-500'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-amber-500" />
                <span>{localDate || 'Real-Time'}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span
                className={`text-xs font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${
                  killZone.isHighVolatilityTiming
                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                    : isDark
                    ? 'bg-slate-800 text-slate-300 border border-slate-700'
                    : 'bg-slate-100 text-slate-700 border border-slate-300'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    killZone.isHighVolatilityTiming ? 'bg-emerald-400' : 'bg-slate-400'
                  }`}
                />
                {killZone.currentZone}
              </span>
              <span className="text-xs font-mono font-bold text-amber-500">
                {localTime}
              </span>
            </div>
          </div>
        </div>

        {/* Theme Toggle, Notifications, Broker Badge & Authentication Section */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Active Broker Mini Badge */}
          <div
            className={`hidden xl:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-medium ${
              isDark ? 'bg-slate-800/80 border-slate-700 text-slate-200' : 'bg-slate-100 border-slate-200 text-slate-800'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="font-bold">{brokerInfo.name}</span>
          </div>

          {/* Browser Notification Bell */}
          {onRequestNotification && (
            <button
              id="notification-permission-btn"
              type="button"
              onClick={onRequestNotification}
              title={
                notificationPermission === 'granted'
                  ? 'Browser & Audio Alerts Active for TP/SL Proximity (Click to test)'
                  : notificationPermission === 'denied'
                  ? 'Browser Notifications Blocked (Audio chime will play on TP/SL)'
                  : 'Click to Enable Instant Browser & Sound Alerts for TP/SL'
              }
              className={`p-2 rounded-xl border transition-all cursor-pointer flex items-center gap-1.5 text-xs ${
                notificationPermission === 'granted'
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/25'
                  : notificationPermission === 'denied'
                  ? isDark
                    ? 'bg-slate-800 border-slate-700 text-slate-500'
                    : 'bg-slate-100 border-slate-200 text-slate-400'
                  : 'bg-amber-500/15 border-amber-500/40 text-amber-400 hover:bg-amber-500/25 animate-pulse'
              }`}
            >
              {notificationPermission === 'granted' ? (
                <BellRing className="w-4 h-4 text-emerald-400" />
              ) : notificationPermission === 'denied' ? (
                <BellOff className="w-4 h-4" />
              ) : (
                <Bell className="w-4 h-4 text-amber-400" />
              )}
              <span className="hidden sm:inline font-semibold">
                {notificationPermission === 'granted' ? 'Alerts ON' : 'Enable Alerts'}
              </span>
            </button>
          )}

          {/* Light / Dark Mode Toggle */}
          {onToggleTheme && (
            <button
              id="theme-toggle-btn"
              type="button"
              onClick={onToggleTheme}
              title={`Switch to ${isDark ? 'Light' : 'Dark'} Mode`}
              className={`p-2 rounded-xl border transition-all cursor-pointer ${
                isDark
                  ? 'bg-slate-800/80 hover:bg-slate-700 border-slate-700 text-amber-400'
                  : 'bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-700'
              }`}
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          )}

          {authLoading ? (
            <div className={`h-9 w-24 rounded-lg animate-pulse ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />
          ) : user ? (
            <div
              className={`flex items-center gap-3 border rounded-xl px-3 py-1.5 ${
                isDark ? 'bg-slate-800/80 border-slate-700/80' : 'bg-slate-50 border-slate-200'
              }`}
            >
              {user.photoURL ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.photoURL}
                  alt={user.displayName || 'Trader'}
                  className="w-8 h-8 rounded-full border border-amber-500/40"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-amber-600 text-white font-bold flex items-center justify-center text-xs">
                  {user.displayName ? user.displayName.charAt(0).toUpperCase() : 'T'}
                </div>
              )}
              <div className="hidden sm:block text-left text-xs">
                <div className={`font-semibold truncate max-w-[120px] ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {user.displayName || 'Trader'}
                </div>
                <div className="text-[10px] text-emerald-500 font-mono">Cloud Synced</div>
              </div>
              <button
                id="header-logout-btn"
                onClick={handleLogout}
                title="Sign out"
                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                  isDark
                    ? 'text-slate-400 hover:text-rose-400 hover:bg-slate-700/60'
                    : 'text-slate-500 hover:text-rose-600 hover:bg-slate-200'
                }`}
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              id="header-google-login-btn"
              onClick={handleGoogleLogin}
              className="flex items-center gap-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-slate-950 font-bold px-3.5 py-2 rounded-xl text-xs sm:text-sm shadow-md transition-all active:scale-95 cursor-pointer"
            >
              <LogIn className="w-4 h-4" />
              <span>Login with Google</span>
            </button>
          )}
        </div>
      </div>

      {/* Sign-in problems are explained in place. Signing in is optional: the
          app keeps working, storing your data in this browser instead. */}
      {authError && (
        <div
          id="auth-error-banner"
          className="border-t border-amber-500/40 bg-amber-500/10 text-amber-300 px-4 sm:px-6 lg:px-8 py-3"
        >
          <div className="max-w-7xl mx-auto flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <p className="text-xs leading-relaxed">{authError}</p>
            </div>
            <button
              id="dismiss-auth-error-btn"
              type="button"
              onClick={() => setAuthError(null)}
              className="text-xs px-2 py-1 rounded-lg border border-current hover:bg-white/10 cursor-pointer shrink-0"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </header>
  );
}

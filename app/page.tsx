'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, setDoc, collection, getDocs, limit, orderBy, query } from 'firebase/firestore';

/**
 * Most recent trades to load and to send for analysis. The learning engine
 * halves a trade's weight every twenty positions back, so beyond this the
 * contribution is negligible while the Firestore read cost and request payload
 * would keep growing with every trade ever taken.
 */
const RECENT_RECORD_LIMIT = 200;
import { auth, db } from '@/lib/firebase';
import { migrateLocalProfileToCloud } from '@/lib/cloud-sync';
import {
  clearActiveSetup,
  isUnresolved,
  loadActiveSetup,
  pickNewer,
  saveActiveSetup,
} from '@/lib/active-setup-store';
import { evaluatePendingOrder, missCause } from '@/lib/order-validity';
import { replayOrder, resolveClose, resolveMiss } from '@/lib/order-replay';
import { tickMayResolve } from '@/lib/close-guard';
import { auditableRecords } from '@/lib/record-audit';
import type { Candle } from '@/lib/candles';
import { trackPosition } from '@/lib/position-tracker';
import { QUOTE_POLL_MS } from '@/lib/price-feed';
import { roundMoney } from '@/lib/trade-result';
import { accountUnitLabel } from '@/lib/account-display';
import PositionStatusCard from '@/components/PositionStatusCard';
import RecordAuditPanel, {
  type AuditSummary,
  type Correction,
} from '@/components/RecordAuditPanel';
import {
  GUEST_STATUS,
  failedStatus,
  formatLastSaved,
  savedStatus,
  savingStatus,
  type SyncStatus,
} from '@/lib/sync-status';
import {
  LOCAL_KEYS,
  alreadyMigrated,
  hasLocalDataWorthMigrating,
  markMigrated,
  markMirrorOwner,
  mirrorBelongsTo,
  readLocalProfile,
  settingsMissingFromCloud,
  toCloudPatch,
  writeLocalSettings,
  type LocalProfile,
  type ProfileSettings,
} from '@/lib/local-store';
import Header from '@/components/Header';
import EquityManager from '@/components/EquityManager';
import TradingSessionZone from '@/components/TradingSessionZone';
import MarketChart from '@/components/MarketChart';
import SignalCard from '@/components/SignalCard';
import PortfolioGrowthCard from '@/components/PortfolioGrowthCard';
import SMCMatrix from '@/components/SMCMatrix';
import EconomicCalendar from '@/components/EconomicCalendar';
import TradingCentralCard from '@/components/TradingCentralCard';
import SelfLearningDashboard from '@/components/SelfLearningDashboard';
import BacktestLab from '@/components/BacktestLab';
import type { BacktestJobResult } from '@/lib/backtest-client';
import { chronological, normalisePrior, type PriorWeights } from '@/lib/learning-engine';
import {
  ClosedTrade,
  InstitutionalTradingSetup,
  SkippedSetup,
  TimeframeType,
  SelfLearningMemoryRecord,
  AdaptiveStrategyEngineWeights,
  TradingStyle,
  AccountType,
  BrokerId,
  ForexFactoryEvent,
} from '@/lib/types';
import { calculateXAUUSDLotSize, getICTKillZoneStatus, recalculateEngineWeights } from '@/lib/market-engine';
import {
  evaluatePriceProximity,
  getNotificationPermission,
  requestNotificationPermission,
  triggerBrowserNotification,
  playProximityChime,
  ProximityAlertEvent,
  NotificationPermissionState,
} from '@/lib/notification-utility';
import { enableClosedAppAlerts, syncWatchedSetup } from '@/lib/push-client';
import { TESTED_FLOOR, TESTED_PROTECT_AT_R, TESTED_STYLE } from '@/lib/tested-configuration';
import { DEFAULT_DAILY_LOSS_LIMIT } from '@/lib/daily-loss';
import { BellRing, X, WifiOff, AlertTriangle, RefreshCw, Cloud, CloudOff, HardDrive } from 'lucide-react';
import type {
  SmcStructure,
  TechnicalIndicators,
  WyckoffVolumeAnalysis,
  QuasimodoPattern,
  TradingCentralInsight,
} from '@/lib/types';

type FeedStatus = 'loading' | 'live' | 'stale' | 'unavailable';

interface LiveRead {
  multiTimeframe: { d1: SmcStructure; h4: SmcStructure; h1: SmcStructure; m15: SmcStructure };
  indicators: TechnicalIndicators;
  wyckoff: WyckoffVolumeAnalysis;
  quasimodo: QuasimodoPattern;
  tradingCentral: TradingCentralInsight;
}

export default function Home() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);

  // Theme state: dark | light
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Notification state
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>('default');
  const [activeProximityAlert, setActiveProximityAlert] = useState<ProximityAlertEvent | null>(null);

  // Broker selection (HFM, EXNESS, IC Markets, XM, FBS, OCTA, MIFX)
  const [selectedBroker, setSelectedBroker] = useState<BrokerId>('EXNESS');

  useEffect(() => {
    const timer = setTimeout(() => {
      setNotificationPermission(getNotificationPermission());
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const handleRequestNotification = async () => {
    const perm = await requestNotificationPermission();
    setNotificationPermission(perm);
    if (perm === 'granted') {
      playProximityChime('TP');
      const push = await enableClosedAppAlerts(activeSetup);
      // Proof on the spot that alerts reach this device's notification shade,
      // and an honest word on whether they also arrive with the app closed.
      void triggerBrowserNotification('XAU Assistant notifications are on', {
        body:
          push === 'on'
            ? 'TP, SL, fill and missed-order alerts will reach this phone even when the app is closed.'
            : push === 'unconfigured'
              ? 'You will be alerted while the app is open. Alerts with the app closed are not set up on the server yet.'
              : 'You will be alerted while the app is open. This device could not sign up for alerts with the app closed.',
        tag: 'notifications-enabled',
      });
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const savedTheme = localStorage.getItem('xauusd_theme') as 'dark' | 'light' | null;
        if (savedTheme === 'light' || savedTheme === 'dark') {
          setTheme(savedTheme);
        }
      } catch {
        // ignore
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const handleToggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      void persistSettings({ theme: next });
    } catch {
      // ignore
    }
  };

  // Market state. Null until the feed answers, so nothing fabricated is shown.
  const [marketPrice, setMarketPrice] = useState<number | null>(null);
  /** Provider timestamp of the quote on screen, for the age readout. */
  const [quoteTakenAt, setQuoteTakenAt] = useState<number | null>(null);
  const [bidPrice, setBidPrice] = useState<number | null>(null);
  const [askPrice, setAskPrice] = useState<number | null>(null);
  const [change24h, setChange24h] = useState<number | null>(null);
  const [selectedTimeframe, setSelectedTimeframe] = useState<TimeframeType>('H1');

  // Live feed status and the structural read derived from real candles.
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('loading');
  /**
   * Whether the quote on screen is the instrument being traded.
   *
   * When the spot providers are all unreachable the feed can fall back to the
   * COMEX futures contract, which tracks gold from tens of dollars away. The
   * chart is still worth showing; the price is not fit to resolve an order
   * against, so automatic fills and closes hold until spot comes back.
   */
  const [quoteIsSpot, setQuoteIsSpot] = useState<boolean>(true);
  /**
   * True when the provider's daily allowance is being rationed, so the quote is
   * deliberately held rather than merely slow. Worth saying out loud: the two
   * look identical on screen and mean different things.
   */
  const [quotaPaced, setQuotaPaced] = useState<boolean>(false);
  /** Whether an order is working, read by the poller without re-creating it. */
  const liveOrderRef = React.useRef<boolean>(false);
  const [feedMessage, setFeedMessage] = useState<string>('Connecting to the market data provider.');
  const [feedSource, setFeedSource] = useState<string | null>(null);
  const [liveRead, setLiveRead] = useState<LiveRead | null>(null);
  const [isRefreshingFeed, setIsRefreshingFeed] = useState<boolean>(false);

  // Equity & Risk Management State (Permanent Lock)
  const [equity, setEquity] = useState<number>(5000);
  const [initialEquity, setInitialEquity] = useState<number>(5000);
  const [isEquityLocked, setIsEquityLocked] = useState<boolean>(false);
  const [riskPercentage, setRiskPercentage] = useState<number>(1.0);
  const [tradingStyle, setTradingStyle] = useState<TradingStyle>(TESTED_STYLE);
  // Read inside the auth listener, which must not resubscribe when the style changes.
  const tradingStyleRef = React.useRef<TradingStyle>('Intraday');
  useEffect(() => {
    tradingStyleRef.current = tradingStyle;
  }, [tradingStyle]);
  const [accountType, setAccountType] = useState<AccountType>('Standard');

  // Active Setup & Analysis State
  const [activeSetup, setActiveSetup] = useState<InstitutionalTradingSetup | null>(null);
  /**
   * The trade that was just closed out. A resolved setup used to be kept in
   * `activeSetup`, so the signal card went on showing a finished trade with its
   * outcome buttons still live. The setup now leaves the card the moment the
   * result is recorded, and this holds the receipt until the next analysis.
   */
  const [lastOutcome, setLastOutcome] = useState<ClosedTrade | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [isEvaluatingOutcome, setIsEvaluatingOutcome] = useState<boolean>(false);

  /**
   * Parameters a backtest produced and the user chose to start live analysis
   * from. Null means the engine uses its own defaults. Either way real trades
   * keep moving the weights on top of it.
   */
  const [backtestPrior, setBacktestPrior] = useState<PriorWeights | null>(null);
  /**
   * The last replay. Held in memory only: it is thousands of simulated trades,
   * which belong in a report rather than in the user's stored profile.
   */
  const [backtestResult, setBacktestResult] = useState<BacktestJobResult | null>(null);
  /**
   * Lowest conviction worth trading. Zero, the default, takes every setup the
   * engine produces, which is how it behaved before the backtest showed which
   * bands were paying for themselves.
   */
  const [minConviction, setMinConviction] = useState<number>(TESTED_FLOOR);
  /**
   * Multiple of risk at which a setup tells the user to move the stop to entry,
   * or null when trades are held exactly as quoted. Turned on from the backtest
   * lab, and only when a run supports it.
   */
  const [protectStopAtR, setProtectStopAtR] = useState<number | null>(null);
  /**
   * Percent of the day's starting balance that may be lost before no new setup
   * is offered until the next trading day. Zero turns it off.
   */
  const [dailyLossLimit, setDailyLossLimit] = useState<number>(DEFAULT_DAILY_LOSS_LIMIT);
  /**
   * A conviction band live analysis refuses outright, when a backtest showed it
   * losing money in both halves of the period. Null when every band is taken.
   */
  const [skipConvictionBand, setSkipConvictionBand] = useState<{ min: number; max: number } | null>(
    null
  );
  /** Set when the engine declined a setup for scoring below that floor. */
  const [skippedSetup, setSkippedSetup] = useState<SkippedSetup | null>(null);

  // Self-Learning Engine Memory & Weights
  const [learningRecords, setLearningRecords] = useState<SelfLearningMemoryRecord[]>([]);
  const [engineWeights, setEngineWeights] = useState<AdaptiveStrategyEngineWeights>({
    orderBlockWeight: 0.28,
    fairValueGapWeight: 0.24,
    liquiditySweepWeight: 0.22,
    newsImpactWeight: 0.14,
    indicatorConfluenceWeight: 0.12,
    atrBufferFactor: 1.25,
    totalAnalysesLearned: 0,
    historicalWinRate: 0,
  });

  // Session context. Memoised so a price tick does not rebuild these arrays and
  // restart the timers in the calendar and session components every few seconds.
  const killZone = useMemo(() => getICTKillZoneStatus(), []);
  // The calendar now comes from the analysis response, which reflects whatever
  // provider is actually configured. Nothing is generated on the client.
  /**
   * Upcoming releases, refreshed with the quote rather than with an analysis.
   *
   * They used to arrive only attached to a setup, so the panel was empty
   * whenever nothing was open, which is most of the time, and emptied again the
   * moment a trade was closed.
   */
  const [economicEvents, setEconomicEvents] = useState<ForexFactoryEvent[]>([]);
  const [calendarMessage, setCalendarMessage] = useState<string | null>(null);

  // Whether the user's data actually reached the cloud. Firestore rejections
  // used to vanish into the console, leaving the screen looking normal while
  // nothing was being saved.
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(GUEST_STATUS);

  // Recomputed on a timer so "2 minutes ago" does not sit frozen on screen.
  const [lastSavedLabel, setLastSavedLabel] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setLastSavedLabel(formatLastSaved(syncStatus));
    tick();
    const id = setInterval(tick, 20000);
    return () => clearInterval(id);
  }, [syncStatus]);

  /**
   * Runs a Firestore write and records whether it succeeded, so a rejection is
   * visible instead of silent. Returns true when the write landed.
   */
  const saveToCloud = useCallback(async (write: () => Promise<void>): Promise<boolean> => {
    setSyncStatus((prev) => savingStatus(prev));
    try {
      await write();
      setSyncStatus(savedStatus());
      return true;
    } catch (err) {
      console.warn('Cloud write rejected:', err);
      setSyncStatus((prev) => failedStatus(prev, err));
      return false;
    }
  }, []);

  // One-time transfer of guest work into a freshly signed-in account.
  const [isMigrating, setIsMigrating] = useState<boolean>(false);
  const [migrationNotice, setMigrationNotice] = useState<string | null>(null);

  /** Applies a browser-stored profile to component state. */
  const applyLocalProfile = useCallback((profile: LocalProfile) => {
    if (profile.equity !== null) setEquity(profile.equity);
    if (profile.initialEquity !== null) setInitialEquity(profile.initialEquity);
    else if (profile.equity !== null) setInitialEquity(profile.equity);
    if (profile.isEquityLocked !== null) setIsEquityLocked(profile.isEquityLocked);
    if (profile.riskPercentage !== null) setRiskPercentage(profile.riskPercentage);
    if (profile.tradingStyle) setTradingStyle(profile.tradingStyle);
    if (profile.accountType) setAccountType(profile.accountType);
    if (profile.selectedBroker) setSelectedBroker(profile.selectedBroker);
    if (profile.backtestPrior) setBacktestPrior(profile.backtestPrior);
    if (profile.minConviction !== null) setMinConviction(profile.minConviction);
    if (profile.protectStopAtR !== null) setProtectStopAtR(profile.protectStopAtR);
    if (profile.dailyLossLimit !== null) setDailyLossLimit(profile.dailyLossLimit);
    if (profile.skipConvictionBand) setSkipConvictionBand(profile.skipConvictionBand);
    if (profile.learningRecords.length > 0) {
      setLearningRecords(profile.learningRecords);
      setEngineWeights(recalculateEngineWeights(profile.learningRecords, tradingStyleRef.current));
    }
  }, []);

  /**
   * What has become of an unresolved pending order: still waiting, past its
   * window, invalidated, or overtaken by the move. Derived rather than stored,
   * so it stays correct as price updates.
   */
  /**
   * Whether the open order has filled. This latches: once price has touched the
   * entry the position is open, and a later quote drifting back past the entry
   * must not report it as pending again.
   */
  const [filledSetupId, setFilledSetupId] = useState<string | null>(null);

  /**
   * Fifteen minute candles behind the current quote: forty eight hours of path.
   *
   * They arrive with every quote and cost nothing extra, and they are the only
   * record of what happened while the tab was closed.
   */
  const [candles, setCandles] = useState<Candle[]>([]);

  /**
   * What the candles say became of the open order.
   *
   * The screen used to decide this from the latest price alone, which is a
   * point where the question is about a path. An order that filled overnight,
   * reached its target and drifted back reads, on that one number, exactly like
   * an order that never filled while the move ran away from it — and it was
   * recorded as a missed entry on that reading.
   */
  const replay = useMemo(() => {
    if (!activeSetup || !isUnresolved(activeSetup) || candles.length === 0) return null;
    // A futures quote carries a futures path, tens of dollars from the market
    // the user trades. The same rule the live reads follow.
    if (!quoteIsSpot) return null;
    return replayOrder(activeSetup, candles);
  }, [activeSetup, candles, quoteIsSpot]);

  /**
   * True once the order has opened.
   *
   * A reload used to clear this, so a filled position that had drifted back
   * past its entry was read as still waiting — the latch existed but was thrown
   * away by the very refresh it was meant to survive. The candles restore it.
   */
  const isFilled = Boolean(
    activeSetup &&
      (filledSetupId === activeSetup.id ||
        activeSetup.status === 'ACTIVE' ||
        replay?.kind === 'running' ||
        replay?.kind === 'closed')
  );

  /** Live state of the order: pending, filled and floating, or closed. */
  const livePosition = useMemo(() => {
    if (!activeSetup || marketPrice === null) return null;
    return trackPosition(activeSetup, marketPrice, isFilled);
  }, [activeSetup, marketPrice, isFilled]);

  useEffect(() => {
    if (!activeSetup || !livePosition) return;
    if (livePosition.state !== 'pending' && filledSetupId !== activeSetup.id) {
      setFilledSetupId(activeSetup.id);
      // The resting order became a live position, so the status follows.
      if (activeSetup.status === 'PENDING') {
        setActiveSetup((prev) =>
          prev && prev.id === activeSetup.id
            ? { ...prev, status: 'ACTIVE', filledAt: new Date().toISOString() }
            : prev
        );
      }
    }
  }, [activeSetup, livePosition, filledSetupId]);

  // Only an order that has not filled can be missed. Once it fills, the miss
  // rules no longer apply: the trade is running and will end at a level.
  const pendingVerdict = useMemo(() => {
    if (!activeSetup || !isUnresolved(activeSetup) || marketPrice === null) return null;
    if (activeSetup.orderType.includes('INSTANT')) return null;
    if (isFilled || livePosition?.state !== 'pending') return null;
    return evaluatePendingOrder(activeSetup, marketPrice);
  }, [activeSetup, marketPrice, isFilled, livePosition]);

  /**
   * True once a restore has been attempted. Writing before that point would
   * save the empty initial state over the setup we are about to read back,
   * which is exactly how the order used to vanish on refresh.
   */
  const [setupHydrated, setSetupHydrated] = useState<boolean>(false);

  /**
   * Holds the open setup across a reload. It is cleared only once the user
   * records an outcome, so an unresolved order can never vanish on refresh.
   */
  useEffect(() => {
    if (!setupHydrated) return;
    saveActiveSetup(activeSetup);
  }, [activeSetup, setupHydrated]);

  // Keep the server watching the same setup, so alerts still arrive when the
  // app is closed. A device that already allowed notifications is subscribed
  // on first load without asking again.
  const pushEnabledRef = React.useRef(false);
  useEffect(() => {
    if (!setupHydrated) return;
    if (!pushEnabledRef.current) {
      pushEnabledRef.current = true;
      if (getNotificationPermission() === 'granted') {
        void enableClosedAppAlerts(activeSetup);
        return;
      }
    }
    void syncWatchedSetup(activeSetup);
  }, [activeSetup, setupHydrated]);

  // Mirror it to the cloud so the same order follows the user to another device.
  useEffect(() => {
    if (!setupHydrated || !currentUser) return;
    const ref = doc(db, 'users', currentUser.uid);
    const payload = activeSetup && isUnresolved(activeSetup) ? activeSetup : null;
    setDoc(ref, { activeSetup: payload, updatedAt: new Date().toISOString() }, { merge: true }).catch(
      (err) => console.warn('Could not mirror the open setup to the cloud:', err)
    );
  }, [activeSetup, currentUser, setupHydrated]);

  // Load User Data from Firestore or LocalStorage
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      setAuthLoading(false);

      if (user) {
        setSyncStatus(savedStatus());
        try {
          const userDocRef = doc(db, 'users', user.uid);
          const snap = await getDoc(userDocRef);

          // First sign-in on an account with no cloud record yet. Carry the
          // guest work up rather than leaving it stranded in this browser,
          // which would split the trade history in two permanently.
          if (!snap.exists() && !alreadyMigrated(user.uid)) {
            const local = readLocalProfile();
            if (hasLocalDataWorthMigrating(local)) {
              setIsMigrating(true);
              const migrated = await migrateLocalProfileToCloud(user.uid, local);
              setIsMigrating(false);
              if (migrated) {
                applyLocalProfile(local);
                markMigrated(user.uid);
                setMigrationNotice(
                  `Your guest data was copied to this account: ${local.learningRecords.length} recorded trade${
                    local.learningRecords.length === 1 ? '' : 's'
                  } and your saved balance.`
                );
                return;
              }
            }
          }

          if (snap.exists()) {
            const data = snap.data();

            // Anything this browser holds that the account does not: a balance
            // set before signing in, or set while a cloud write was failing.
            // Carrying it up is the difference between an account that
            // remembers and one that appears to reset itself on every login.
            // Never from a browser where somebody else signed in: that would
            // hand one person's balance to the next account to use it.
            const local = readLocalProfile();
            const gaps = mirrorBelongsTo(user.uid) ? settingsMissingFromCloud(data, local) : {};
            if (Object.keys(gaps).length > 0) {
              await saveToCloud(() =>
                setDoc(
                  doc(db, 'users', user.uid),
                  { ...toCloudPatch(gaps), updatedAt: new Date().toISOString() },
                  { merge: true }
                )
              );
              Object.assign(data, toCloudPatch(gaps));
            }
            if (typeof data.lockedEquity === 'number') {
              setEquity(data.lockedEquity);
            }
            if (typeof data.initialEquity === 'number') {
              setInitialEquity(data.initialEquity);
            } else if (typeof data.lockedEquity === 'number') {
              setInitialEquity(data.lockedEquity);
            }
            if (typeof data.isEquityLocked === 'boolean') {
              setIsEquityLocked(data.isEquityLocked);
            }
            if (typeof data.riskPercentage === 'number') {
              setRiskPercentage(data.riskPercentage);
            }
            if (data.tradingStyle) {
              setTradingStyle(data.tradingStyle as TradingStyle);
            }
            if (data.accountType) {
              setAccountType(data.accountType as AccountType);
            }
            if (data.selectedBroker) {
              setSelectedBroker(data.selectedBroker as BrokerId);
            }
            if (typeof data.minConviction === 'number' && data.minConviction >= 0 && data.minConviction <= 100) {
              setMinConviction(data.minConviction);
            }
            if (data.backtestPrior && typeof data.backtestPrior === 'object') {
              setBacktestPrior(normalisePrior(data.backtestPrior as Partial<PriorWeights>));
            }
            if (
              typeof data.protectStopAtR === 'number' &&
              data.protectStopAtR >= 0.5 &&
              data.protectStopAtR <= 3
            ) {
              setProtectStopAtR(data.protectStopAtR);
            } else if (data.protectStopAtR === null) {
              setProtectStopAtR(null);
            }
            if (typeof data.dailyLossLimit === 'number' && data.dailyLossLimit >= 0 && data.dailyLossLimit <= 50) {
              setDailyLossLimit(data.dailyLossLimit);
            }
            const band = data.skipConvictionBand as { min?: unknown; max?: unknown } | null;
            if (
              band &&
              typeof band.min === 'number' &&
              typeof band.max === 'number' &&
              band.max > band.min
            ) {
              setSkipConvictionBand({ min: band.min, max: band.max });
            } else if (band === null) {
              setSkipConvictionBand(null);
            }
            // Restore an order the user never resolved, preferring whichever
            // copy is newer between this browser and the cloud.
            const restored = pickNewer(
              (data.activeSetup as InstitutionalTradingSetup | null) ?? null,
              loadActiveSetup()
            );
            if (restored && isUnresolved(restored)) {
              setActiveSetup(restored);
            }
          }

          // Mirror the account's settings into this browser. Without this the
          // local copy stays at whatever it was before signing in, and signing
          // out later looks exactly like the balance resetting.
          if (snap.exists()) {
            const data = snap.data();
            writeLocalSettings({
              ...(typeof data.lockedEquity === 'number' ? { equity: data.lockedEquity } : {}),
              ...(typeof data.initialEquity === 'number' ? { initialEquity: data.initialEquity } : {}),
              ...(typeof data.isEquityLocked === 'boolean' ? { isEquityLocked: data.isEquityLocked } : {}),
              ...(typeof data.riskPercentage === 'number' ? { riskPercentage: data.riskPercentage } : {}),
              ...(data.tradingStyle ? { tradingStyle: data.tradingStyle as TradingStyle } : {}),
              ...(data.accountType ? { accountType: data.accountType as AccountType } : {}),
              ...(data.selectedBroker ? { selectedBroker: data.selectedBroker as BrokerId } : {}),
              ...(typeof data.minConviction === 'number' ? { minConviction: data.minConviction } : {}),
              ...(typeof data.dailyLossLimit === 'number' ? { dailyLossLimit: data.dailyLossLimit } : {}),
              ...(data.theme === 'dark' || data.theme === 'light' ? { theme: data.theme } : {}),
            });
            markMirrorOwner(user.uid);
          }

          // Fetch user's historical self-learning records from Firestore
          const recRef = collection(db, 'users', user.uid, 'learning_records');
          const recSnap = await getDocs(
            query(recRef, orderBy('timestamp', 'desc'), limit(RECENT_RECORD_LIMIT))
          );
          if (!recSnap.empty) {
            const loadedRecords: SelfLearningMemoryRecord[] = [];
            recSnap.forEach((d) => loadedRecords.push(d.data() as SelfLearningMemoryRecord));
            // The query asks for the newest first because that is the cheap
            // index. Everything downstream reads this list as a history, so it
            // is put back into the order a history is written in.
            const ordered = chronological(loadedRecords);
            setLearningRecords(ordered);
            setEngineWeights(recalculateEngineWeights(ordered, tradingStyleRef.current));
          }
        } catch (err) {
          console.warn('Notice loading user cloud document:', err);
        } finally {
          setSetupHydrated(true);
        }
      } else {
        // Guest trader: everything lives in this browser.
        setSyncStatus(GUEST_STATUS);
        applyLocalProfile(readLocalProfile());
        const restored = loadActiveSetup();
        if (restored) setActiveSetup(restored);
        setSetupHydrated(true);
      }
    });

    return () => unsubscribe();
    // applyLocalProfile and saveToCloud are stable, so listing them would only
    // resubscribe the auth listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyLocalProfile]);

  /**
   * Saves a settings change everywhere it belongs.
   *
   * Always to this browser, and to the account as well when one is signed in.
   * The old code did one or the other: signed in, nothing was written locally,
   * so signing out fell back to a stale browser copy and the balance appeared
   * to reset itself. A mirror costs nothing and removes the whole class of it.
   */
  const persistSettings = useCallback(
    async (patch: Partial<ProfileSettings>) => {
      writeLocalSettings(patch);
      if (!currentUser) return;
      await saveToCloud(() =>
        setDoc(
          doc(db, 'users', currentUser.uid),
          { ...toCloudPatch(patch), updatedAt: new Date().toISOString() },
          { merge: true }
        )
      );
    },
    // saveToCloud is stable, so listing it would only churn this callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentUser]
  );

  /**
   * Pulls the real XAUUSD quote and the structural read derived from live
   * candles. There is no simulated price: when the provider cannot be reached
   * the UI says so rather than inventing a number.
   */
  const loadMarketData = useCallback(async () => {
    try {
      // Read through a ref so the polling effect is not rebuilt every time an
      // order opens or closes. The flag tells the server this is the moment
      // worth spending a provider request on.
      const lane = liveOrderRef.current ? '&live=1' : '';
      const res = await fetch(
        `/api/market-data?accountType=${encodeURIComponent(accountType)}&brokerId=${encodeURIComponent(
          selectedBroker
        )}${lane}`,
        { cache: 'no-store' }
      );
      const data = await res.json();

      if (!res.ok || !data?.success || typeof data.marketPrice !== 'number') {
        setFeedStatus('unavailable');
        setFeedMessage(data?.message || 'The market data provider could not be reached.');
        return;
      }

      setFeedStatus(data.status === 'stale' ? 'stale' : 'live');
      setQuoteIsSpot(data.instrument !== 'futures');
      setQuotaPaced(Boolean(data.quotaPaced));
      setFeedMessage(data.message || '');
      setFeedSource(data.source ?? null);
      setMarketPrice(data.marketPrice);
      // When the provider took this quote, so the screen can say how old it is
      // instead of presenting a minute-old number as the current price.
      setQuoteTakenAt(
        typeof data.fetchedAt === 'string' && Number.isFinite(Date.parse(data.fetchedAt))
          ? Date.parse(data.fetchedAt)
          : Date.now()
      );
      setBidPrice(typeof data.bid === 'number' ? data.bid : null);
      setAskPrice(typeof data.ask === 'number' ? data.ask : null);
      setChange24h(typeof data.change24h === 'number' ? data.change24h : null);
      // The path, not just the point. These decide what became of an order that
      // ran while the tab was closed; the quote alone cannot tell a trade that
      // filled and won from one that was never in the market.
      if (Array.isArray(data.candlesM15)) setCandles(data.candlesM15 as Candle[]);

      if (Array.isArray(data.economicEvents)) {
        setEconomicEvents(data.economicEvents as ForexFactoryEvent[]);
      }
      setCalendarMessage(data.calendarConfigured ? null : (data.calendarMessage ?? null));

      if (data.structureAvailable && data.multiTimeframe && data.technicalIndicators) {
        setLiveRead({
          multiTimeframe: data.multiTimeframe,
          indicators: data.technicalIndicators,
          wyckoff: data.wyckoffVsa,
          quasimodo: data.quasimodo,
          tradingCentral: data.tradingCentralBias,
        });
      }
    } catch {
      setFeedStatus('unavailable');
      setFeedMessage('Network error while contacting the market data provider.');
    }
  }, [accountType, selectedBroker]);

  /**
   * How often to ask for a new quote.
   *
   * Every request spends from the provider's daily allowance, so the rate
   * follows what the price is actually being used for. While an order is
   * working, the status panel and the automatic close both read this number, so
   * it is refreshed often. With nothing open it only has to look current. In a
   * background tab it is not being read at all, and polling one would spend the
   * allowance on a screen nobody is looking at.
   */
  const hasLiveOrder = Boolean(activeSetup && isUnresolved(activeSetup));
  useEffect(() => {
    liveOrderRef.current = hasLiveOrder;
  }, [hasLiveOrder]);

  /**
   * Age of the quote on screen, in seconds.
   *
   * The chart is TradingView's own live feed; this number comes from the market
   * data provider a few seconds behind it. Saying how old it is turns an
   * apparent disagreement between the two into a fact the user can read.
   */
  const [clockMs, setClockMs] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => setClockMs(Date.now()), 5000);
    // Set after mount so the first server and client render agree.
    const first = setTimeout(() => setClockMs(Date.now()), 0);
    return () => {
      clearInterval(id);
      clearTimeout(first);
    };
  }, []);

  const quoteAgeSeconds =
    quoteTakenAt === null || clockMs === null ? null : Math.max(0, Math.round((clockMs - quoteTakenAt) / 1000));

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

    const schedule = () => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, hasLiveOrder ? QUOTE_POLL_MS.withOpenOrder : QUOTE_POLL_MS.idle);
    };

    const run = async () => {
      if (cancelled) return;
      if (visible()) await loadMarketData();
      schedule();
    };

    void run();

    // Coming back to the tab asks straight away rather than waiting out the
    // interval with a price that went stale while it was hidden.
    const onVisibility = () => {
      if (visible()) void run();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadMarketData, hasLiveOrder]);

  const handleManualRefresh = async () => {
    setIsRefreshingFeed(true);
    await loadMarketData();
    setIsRefreshingFeed(false);
  };

  // Real-time TP/SL proximity monitoring with notifications and audio chimes
  useEffect(() => {
    if (!activeSetup || !isUnresolved(activeSetup) || marketPrice === null) return;

    const timer = setTimeout(() => {
      const alert = evaluatePriceProximity(marketPrice, activeSetup, {
        proximityThresholdDollars: 1.5, // Alert within 15 pips of TP or SL
        cooldownMs: 120000, // 2 minutes cooldown per target level
        enableSound: true,
        enableBrowserNotification: true,
      });
      if (alert) {
        setActiveProximityAlert(alert);
      }
    }, 0);

    return () => clearTimeout(timer);
  }, [marketPrice, activeSetup]);

  /**
   * Records a miss automatically once a pending order ends without filling.
   *
   * Waiting for the user to notice and click meant an order could sit
   * unresolved for days, and the learning engine only ever saw the misses
   * someone happened to be watching. The ref guards against the effect firing
   * twice for the same setup while the evaluation is in flight.
   */
  /**
   * Closes a running position the moment price reaches a target or the stop,
   * so the ledger and the learning engine reflect what the market actually did
   * rather than whenever the user happened to look.
   */
  /**
   * Whether the current price may be used to end the open trade.
   *
   * The only guard here used to be the instrument: never close a spot trade on
   * a futures quote. Nothing asked whether the number was current. A trade
   * could be opened and closed in the same breath — issued at one price, then
   * matched against a quote from another moment sitting beyond its stop — and
   * the loss was recorded, the balance moved and the engine taught that the
   * setup had failed, for a trade that never happened.
   *
   * The candle replay is not subject to this. It carries its own timestamps,
   * which is the very thing a bare price cannot.
   */
  const tickTrust = useMemo(() => {
    if (!activeSetup || marketPrice === null) {
      return { ok: false as const, reason: 'No open order, or no price.' };
    }
    if (!quoteIsSpot) {
      return {
        ok: false as const,
        reason: 'The only quote available is the COMEX futures contract, which trades away from spot.',
      };
    }
    return tickMayResolve({
      feedStatus,
      quoteAgeSeconds,
      issuedAt: activeSetup.timestamp,
      price: marketPrice,
      candles,
    });
  }, [activeSetup, marketPrice, quoteIsSpot, feedStatus, quoteAgeSeconds, candles]);

  /**
   * The setup this screen has already resolved, whichever path resolved it.
   *
   * One ref for both, because a trade may only be recorded once. The close and
   * the miss used to keep a guard each, and their conditions happen not to
   * overlap today — a position cannot be closed and still pending — but that
   * is an accident of the current rules rather than a promise. Sharing the
   * guard makes it one: whichever path reaches a verdict first, the other
   * finds the trade already settled.
   */
  const resolvedRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (!activeSetup) return;
    if (isEvaluatingOutcome || marketPrice === null) return;
    // Never close a spot trade on a futures price: the two are tens of dollars
    // apart, so the level it appears to have reached is not a level the market
    // the user trades in ever touched.
    if (!quoteIsSpot) return;
    if (resolvedRef.current === activeSetup.id) return;

    const close = resolveClose(
      replay,
      tickTrust.ok && livePosition?.state === 'closed' ? livePosition.closedBy : null
    );
    if (!close) return;

    resolvedRef.current = activeSetup.id;
    const { trigger: hit, level } = close;
    const when = close.at ? ` at ${new Date(close.at).toLocaleString()}` : '';
    setAutoResolveNotice(
      hit === 'SL'
        ? `Price reached the stop at ${activeSetup.stopLoss.toFixed(
            2
          )}${when}. The engine closed the trade and recorded it.`
        : `Price reached ${hit} at ${(hit === 'TP3'
            ? activeSetup.takeProfit3
            : hit === 'TP2'
            ? activeSetup.takeProfit2
            : activeSetup.takeProfit1
          ).toFixed(2)}${when}. The engine closed the trade and recorded it.`
    );
    void handleSimulateOutcome(hit === 'SL' ? 'SL' : 'TP', level as 1 | 2 | 3);
    // handleSimulateOutcome closes over the same setup each render, so listing
    // it would re-fire this effect without changing anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSetup, livePosition, replay, tickTrust, isEvaluatingOutcome, marketPrice, quoteIsSpot]);

  useEffect(() => {
    if (!activeSetup) return;
    if (isEvaluatingOutcome || marketPrice === null) return;
    // Same rule as the automatic close: a missed entry recorded from a futures
    // quote is a miss that never happened.
    if (!quoteIsSpot) return;
    if (resolvedRef.current === activeSetup.id) return;

    // A miss recorded from a price that cannot be trusted is the same mistake
    // as a close recorded from one, and costs more: it teaches the engine to
    // move its entries.
    const miss = resolveMiss(replay, tickTrust.ok ? pendingVerdict : null);
    if (!miss) return;

    resolvedRef.current = activeSetup.id;
    setAutoResolveNotice(`${miss.reason} The engine recorded it as a missed entry.`);
    void handleSimulateOutcome('MISSED', 1, missCause(miss.cause));
    // handleSimulateOutcome is recreated each render but closes over the same
    // setup, so listing it would re-fire this effect without changing anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSetup, pendingVerdict, replay, tickTrust, isEvaluatingOutcome, marketPrice, quoteIsSpot]);

  const [autoResolveNotice, setAutoResolveNotice] = useState<string | null>(null);

  /**
   * Says so when the order outran the price history.
   *
   * The app can only replay the forty eight hours of candles it carries. An
   * order older than that had a path nobody recorded, and the one thing it must
   * not do is invent one. It hands the question back instead, which is a
   * question the user can answer from their own terminal in a second.
   */
  const outcomeNeedsUser = replay?.kind === 'unknown' ? replay.reason : null;

  // Handle Locking Initial Equity
  const handleLockEquity = async (amount: number) => {
    setEquity(amount);
    setInitialEquity(amount);
    setIsEquityLocked(true);

    await persistSettings({
      equity: amount,
      initialEquity: amount,
      isEquityLocked: true,
      riskPercentage,
      tradingStyle,
      accountType,
      selectedBroker,
    });
  };

  /**
   * Sets the lowest conviction worth trading. Above zero the engine declines a
   * weak setup outright rather than offering it, which is what the backtest's
   * conviction breakdown is there to help choose.
   */
  const handleChangeMinConviction = (score: number) => {
    setMinConviction(score);
    setSkippedSetup(null);
    void persistSettings({ minConviction: score });
  };

  /** Sets the daily loss limit, or turns it off with zero. */
  const handleChangeDailyLossLimit = (percent: number) => {
    setDailyLossLimit(percent);
    setSkippedSetup(null);
    void persistSettings({ dailyLossLimit: percent });
  };

  /**
   * Turns the break-even rule on or off for live setups. The backtest lab only
   * offers it when a run over real history says it was the better way to hold
   * the same trades.
   */
  const handleProtectStop = (atR: number | null) => {
    setProtectStopAtR(atR);
    void persistSettings({ protectStopAtR: atR });
  };

  /**
   * Refuses, or stops refusing, a conviction band on live analysis. Offered by
   * the lab only when a band lost money in both halves of a backtested period.
   */
  const handleSkipBand = (band: { min: number; max: number } | null) => {
    setSkipConvictionBand(band);
    setSkippedSetup(null);
    void persistSettings({ skipConvictionBand: band });
  };

  /**
   * Adopts, or drops, the parameters a backtest ended on. They become the point
   * the live learning engine shrinks toward instead of its built-in defaults;
   * real trades keep adjusting from there.
   */
  const handleAdoptBacktestPrior = (weights: PriorWeights | null) => {
    setBacktestPrior(weights);
    void persistSettings({ backtestPrior: weights });
  };

  const handleResetBaseline = () => {
    setInitialEquity(equity);
    void persistSettings({ initialEquity: equity });
  };

  // Update Broker Preference
  const handleChangeBroker = async (broker: BrokerId) => {
    setSelectedBroker(broker);
    await persistSettings({ selectedBroker: broker });
  };

  // Update Risk Percentage
  const handleChangeRiskPercentage = async (pct: number) => {
    setRiskPercentage(pct);
    await persistSettings({ riskPercentage: pct });
  };

  // Update Trading Style (Scalping / Intraday / Swing)
  const handleChangeTradingStyle = async (style: TradingStyle) => {
    setTradingStyle(style);
    await persistSettings({ tradingStyle: style });
  };

  const handleApplyTestedConfiguration = async () => {
    setTradingStyle(TESTED_STYLE);
    setMinConviction(TESTED_FLOOR);
    setProtectStopAtR(TESTED_PROTECT_AT_R);
    setSkippedSetup(null);
    await persistSettings({
      tradingStyle: TESTED_STYLE,
      minConviction: TESTED_FLOOR,
      protectStopAtR: TESTED_PROTECT_AT_R,
    });
  };

  // Update Account Type (Standard / Cent / Pro)
  const handleChangeAccountType = async (acc: AccountType) => {
    setAccountType(acc);
    await persistSettings({ accountType: acc });
  };

  const handleResetEquity = async () => {
    // Only reachable once the account is actually empty, which is why it is not
    // guarded by a confirmation: there is nothing left to lose at that point.
    if (equity <= 0) {
      setIsEquityLocked(false);
      setEquity(5000);
      await persistSettings({ isEquityLocked: false, equity: 5000 });
    }
  };

  // Run Institutional Analysis
  const handleRunAnalysis = async () => {
    // The server refuses to analyse without live data; failing fast here keeps
    // the reason visible in the banner instead of surfacing a raw error.
    if (marketPrice === null) {
      setFeedStatus('unavailable');
      setFeedMessage('Cannot run an analysis without a live quote. Retry the market data connection first.');
      return;
    }
    setIsAnalyzing(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          equity,
          riskPercentage,
          tradingStyle,
          accountType,
          brokerId: selectedBroker,
          userId: currentUser?.uid || 'guest',
          pastLearningRecords: learningRecords.slice(-RECENT_RECORD_LIMIT),
          minConviction,
          dailyLossLimitPercent: dailyLossLimit,
          // What the engine shrinks toward. Null keeps its own defaults.
          priorWeights: backtestPrior,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data?.success) {
        setFeedMessage(data?.error || 'The analysis engine could not produce a setup.');
        if (res.status === 503) setFeedStatus('unavailable');
        return;
      }
      // The engine looked and found nothing worth offering. The card shows the
      // reason, but only when it has room: a live order keeps the card, so the
      // answer would otherwise vanish and the button would look broken.
      if (!data.setup && data.skipped) {
        const skip = data.skipped as SkippedSetup;
        setSkippedSetup(skip);
        if (activeSetup) {
          setFeedMessage(
            skip.reason === 'unfillable'
              ? 'No new setup: price has run too far from its level for an order to rest there. Your current order is unchanged.'
              : skip.reason === 'daily-limit'
              ? 'No new setup: today has reached your daily loss limit. Your current order is unchanged.'
              : 'No new setup met the engine quality rules. Your current order is unchanged.'
          );
        }
        return;
      }

      if (data.setup) {
        setActiveSetup(data.setup);
        // A new setup replaces the previous trade's receipt.
        setLastOutcome(null);
        setSkippedSetup(null);
        if (data.engineWeights) {
          setEngineWeights(data.engineWeights);
        }
        setCalendarMessage(data.calendarConfigured ? null : (data.calendarMessage ?? null));

        // Save setup to Firestore if user is authenticated
        if (currentUser) {
          // Keyed by the setup's own id so a retry cannot create a duplicate.
          await saveToCloud(() =>
            setDoc(doc(db, 'users', currentUser.uid, 'analyses', data.setup.id), data.setup)
          );
        }
      }
    } catch (err) {
      console.warn('Analysis execution notice:', err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Convert Pending Limit Order to Instant Market Order at Current Live Price
  const handleConvertToMarketOrder = (newEntryPrice: number) => {
    if (!activeSetup) return;

    // Use the same calculator as the analysis path. The ad-hoc arithmetic that
    // lived here ignored the Pro round-turn commission and used a different
    // minimum lot for Cent accounts, so the two paths disagreed.
    const lotCalculation = calculateXAUUSDLotSize(
      equity,
      activeSetup.riskPercentage,
      newEntryPrice,
      activeSetup.stopLoss,
      activeSetup.accountType,
      activeSetup.tradingStyle,
      activeSetup.brokerId ?? 'EXNESS'
    );
    const slPips = lotCalculation.stopLossPips;
    const adjustedLot = lotCalculation.lotSize;

    const tpDistance = Math.abs(activeSetup.takeProfit1 - activeSetup.entryPrice);
    const isBuy = activeSetup.orderType.includes('BUY');

    const updatedSetup: InstitutionalTradingSetup = {
      ...activeSetup,
      orderType: isBuy ? 'BUY INSTANT' : 'SELL INSTANT',
      entryPrice: newEntryPrice,
      stopLossPips: slPips,
      recommendedLotSize: adjustedLot,
      actualRiskDollars: lotCalculation.actualRiskDollars,
      exceedsRiskBudget: lotCalculation.exceedsRiskBudget,
      takeProfit1: isBuy
        ? parseFloat((newEntryPrice + tpDistance).toFixed(2))
        : parseFloat((newEntryPrice - tpDistance).toFixed(2)),
      takeProfit2: isBuy
        ? parseFloat((newEntryPrice + tpDistance * 1.5).toFixed(2))
        : parseFloat((newEntryPrice - tpDistance * 1.5).toFixed(2)),
      takeProfit3: isBuy
        ? parseFloat((newEntryPrice + tpDistance * 2.2).toFixed(2))
        : parseFloat((newEntryPrice - tpDistance * 2.2).toFixed(2)),
      status: 'ACTIVE',
      executionInstructionsMT5: [
        `Converted to instant Market Order at $${newEntryPrice.toFixed(2)}`,
        `Adjusted Lot Size: ${adjustedLot.toFixed(2)} ${activeSetup.contractSpecs?.lotUnit || 'Lots'}`,
        `Stop Loss preserved at $${activeSetup.stopLoss.toFixed(2)} (${slPips} pips)`,
        lotCalculation.exceedsRiskBudget
          ? `WARNING: the broker minimum lot risks $${lotCalculation.actualRiskDollars.toFixed(2)}, above your $${lotCalculation.riskDollars.toFixed(2)} budget`
          : `Risk held at $${lotCalculation.actualRiskDollars.toFixed(2)}`,
      ],
    };

    setActiveSetup(updatedSetup);
  };

  // Simulate Outcome & Trigger Autonomous Self-Learning Engine (TP, SL, or MISSED)
  const handleSimulateOutcome = async (
    outcome: 'TP' | 'SL' | 'MISSED',
    tpLevel: 1 | 2 | 3 = 1,
    autoReason?: string
  ) => {
    if (!activeSetup) return;
    setIsEvaluatingOutcome(true);

    try {
      // A missed order closes at the live price. Without one there is nothing
      // to measure the miss against, so the evaluation is not attempted.
      if (outcome === 'MISSED' && marketPrice === null) {
        setIsEvaluatingOutcome(false);
        return;
      }

      const targetExit =
        outcome === 'TP'
          ? tpLevel === 3
            ? activeSetup.takeProfit3
            : tpLevel === 2
            ? activeSetup.takeProfit2
            : activeSetup.takeProfit1
          : outcome === 'SL'
          ? activeSetup.stopLoss
          : (marketPrice as number);

      const res = await fetch('/api/learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setup: activeSetup,
          outcome,
          closedPrice: targetExit,
          // Why it missed, so the post mortem reflects the real cause instead
          // of assuming every miss is the same thing.
          missCause: autoReason,
          autoResolved: Boolean(autoReason),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.learningRecord) {
          const newRecord: SelfLearningMemoryRecord = data.learningRecord;
          const updatedRecords = [...learningRecords, newRecord];
          setLearningRecords(updatedRecords);

          // Recalculate weights with the newly acquired experience
          const newWeights = recalculateEngineWeights(updatedRecords, tradingStyle);
          setEngineWeights(newWeights);

          // Update active balance according to trade outcome (0 change for MISSED)
          // Four decimals, because two is a whole unit on a cent account.
          const newEquity = Math.max(0, roundMoney(equity + (newRecord.profitOrLossDollars || 0)));
          setEquity(newEquity);

          // The trade is resolved, so the held copy is no longer needed.
          clearActiveSetup();

          // Clear the card and keep only the receipt. Leaving the closed setup
          // in place is what made a stopped-out trade linger on screen with its
          // TP and SL buttons still clickable.
          setLastOutcome({
            setup: {
              ...activeSetup,
              status: outcome === 'TP' ? 'TP_HIT' : outcome === 'SL' ? 'SL_HIT' : 'MISSED',
              closedPrice: targetExit,
              closedAt: new Date().toISOString(),
              learningOutcome: newRecord,
            },
            record: newRecord,
          });
          setActiveSetup(null);
          // The fill latch belongs to the trade that just ended.
          setFilledSetupId(null);

          // Save learning record to cloud Firestore or local storage
          if (currentUser) {
            // A rejected write here would lose the trade result, so it is
            // reported rather than swallowed. The browser copy is written
            // either way, so nothing is lost while the cause is fixed.
            const stored = await saveToCloud(async () => {
              // Same key as the guest migration uses, so a record copied up
              // earlier is updated rather than stored twice.
              await setDoc(doc(db, 'users', currentUser.uid, 'learning_records', newRecord.id), newRecord);
              await setDoc(
                doc(db, 'users', currentUser.uid),
                {
                  lockedEquity: newEquity,
                  totalTrades: updatedRecords.length,
                  winTrades: updatedRecords.filter((r) => r.outcome === 'TP').length,
                  lossTrades: updatedRecords.filter((r) => r.outcome === 'SL').length,
                  missedTrades: updatedRecords.filter((r) => r.outcome === 'MISSED').length,
                  updatedAt: new Date().toISOString(),
                },
                { merge: true }
              );
            });

            if (!stored) {
              // Keep a browser copy so the result survives until the cloud accepts it.
              localStorage.setItem(LOCAL_KEYS.records, JSON.stringify(updatedRecords));
              localStorage.setItem(LOCAL_KEYS.equity, newEquity.toString());
            }
          } else {
            localStorage.setItem(LOCAL_KEYS.records, JSON.stringify(updatedRecords));
            localStorage.setItem(LOCAL_KEYS.equity, newEquity.toString());
          }
        }
      }
    } catch (err) {
      console.warn('Error running post-trade evaluation:', err);
    } finally {
      setIsEvaluatingOutcome(false);
    }
  };

  /**
   * Writes a changed ledger to both homes and recomputes what depends on it.
   *
   * Shared by the two audit actions so a correction and a confirmation cannot
   * drift apart in how they persist.
   */
  const persistRecords = useCallback(
    async (records: SelfLearningMemoryRecord[], nextEquity?: number) => {
      setLearningRecords(records);
      setEngineWeights(recalculateEngineWeights(records, tradingStyle));
      if (typeof nextEquity === 'number') setEquity(nextEquity);

      const changed = records.filter((r) => r.audit);
      if (currentUser) {
        const stored = await saveToCloud(async () => {
          for (const record of changed) {
            await setDoc(doc(db, 'users', currentUser.uid, 'learning_records', record.id), record, {
              merge: true,
            });
          }
          await setDoc(
            doc(db, 'users', currentUser.uid),
            {
              ...(typeof nextEquity === 'number' ? { lockedEquity: nextEquity } : {}),
              totalTrades: records.length,
              winTrades: records.filter((r) => r.outcome === 'TP').length,
              lossTrades: records.filter((r) => r.outcome === 'SL').length,
              missedTrades: records.filter((r) => r.outcome === 'MISSED').length,
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        });
        if (stored) return;
      }
      try {
        localStorage.setItem(LOCAL_KEYS.records, JSON.stringify(records));
        if (typeof nextEquity === 'number') {
          localStorage.setItem(LOCAL_KEYS.equity, nextEquity.toString());
        }
      } catch {
        // A browser refusing storage loses the correction on reload, which is
        // the old behaviour rather than a new failure.
      }
    },
    [currentUser, saveToCloud, tradingStyle]
  );

  /**
   * Sends the missed entries to be checked against the candles of their own day.
   *
   * Read only on the server: it returns a verdict per row and changes nothing.
   * What is done about a verdict is decided here, by the user, one row at a time.
   */
  const handleAuditMisses = useCallback(async (): Promise<AuditSummary | null> => {
    try {
      const res = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Everything the engine closed on its own and that has not already
        // been settled. A result the user typed is their own testimony.
        body: JSON.stringify({ records: auditableRecords(learningRecords) }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) return null;
      return data as AuditSummary;
    } catch {
      return null;
    }
  }, [learningRecords]);

  /**
   * Rewrites one row to what the user's terminal says actually happened.
   *
   * The money comes from the user because the record never kept the lot size,
   * so it cannot be recomputed here. That is the better source anyway: it is
   * what the broker actually paid, not what the app calculates it should have.
   */
  const handleCorrectRecord = useCallback(
    async (correction: Correction) => {
      const target = learningRecords.find((r) => r.id === correction.id);
      if (!target) return;

      const previous = target.profitOrLossDollars || 0;
      const money = roundMoney(correction.profitOrLossDollars);

      const risk = Math.abs((target.context?.stopLossPips ?? 0) / 10);
      // Measured from where the trade actually closed, which the user supplied.
      // The price already on the row is the one the app misread the trade from,
      // so anything derived from it would carry the same error forward.
      const isLong = target.orderType.includes('BUY');
      const moved = (correction.exitPrice - target.entryPrice) * (isLong ? 1 : -1);

      // A row corrected back to a missed entry moved no money and earns no R:
      // there was no trade to measure.
      const missed = correction.outcome === 'MISSED';

      const corrected: SelfLearningMemoryRecord = {
        ...target,
        outcome: correction.outcome,
        exitPrice: correction.exitPrice,
        profitOrLossDollars: missed ? 0 : money,
        profitOrLossPips: missed ? 0 : parseFloat((moved * 10).toFixed(1)),
        context: target.context
          ? {
              ...target.context,
              // R is the only comparison the engine has across trades, so it
              // has to follow the corrected result rather than keep a miss's
              // zero — and it is signed, so a stop counts against the average.
              rMultiple: missed
                ? 0
                : risk > 0
                ? parseFloat((moved / risk).toFixed(2))
                : target.context.rMultiple,
            }
          : target.context,
        audit: {
          at: new Date().toISOString(),
          verdict: 'corrected',
          confirmed: false,
          correctedFrom: target.outcome,
        },
      };

      const records = learningRecords.map((r) => (r.id === corrected.id ? corrected : r));
      // The balance moves by the difference between what this row used to claim
      // and what it actually was, so correcting a phantom loss gives it back.
      const nextEquity = Math.max(
        0,
        roundMoney(equity + ((corrected.profitOrLossDollars || 0) - previous))
      );
      await persistRecords(records, nextEquity);
    },
    [learningRecords, equity, persistRecords]
  );

  /**
   * Moves the balance onto what the recorded trades add up to.
   *
   * The two are kept by different paths, and a trade recorded against a price
   * that never happened could move one without the other. Once the rows have
   * been checked against the market, the ledger is the side with evidence
   * behind it, so this is the safe direction — but it stays a click, never
   * something that happens quietly to someone's balance.
   */
  const handleReconcileToLedger = useCallback(
    async (ledgerBalance: number) => {
      const next = Math.max(0, roundMoney(ledgerBalance));
      setEquity(next);
      await persistSettings({ equity: next });
    },
    [persistSettings]
  );

  /** Marks a row as checked and correct, so the audit stops raising it. */
  const handleConfirmRecord = useCallback(
    async (id: string) => {
      const records = learningRecords.map((r) =>
        r.id === id
          ? { ...r, audit: { at: new Date().toISOString(), verdict: 'genuine', confirmed: true } }
          : r
      );
      await persistRecords(records);
    },
    [learningRecords, persistRecords]
  );

  // Prefer the frozen read captured with the active setup, otherwise the live
  // structural read. Both come from real candles; neither is a placeholder.
  const displayMT = activeSetup ? activeSetup.multiTimeframeAlignment : liveRead?.multiTimeframe ?? null;
  const displayIndicators = activeSetup ? activeSetup.technicalIndicators : liveRead?.indicators ?? null;
  const displayWyckoff = activeSetup ? activeSetup.wyckoffVsa : liveRead?.wyckoff ?? null;
  const displayQM = activeSetup ? activeSetup.quasimodo : liveRead?.quasimodo ?? null;
  const displayTradingCentral = activeSetup ? activeSetup.tradingCentralBias : liveRead?.tradingCentral ?? null;
  const structuresReady = Boolean(displayMT && displayIndicators && displayWyckoff && displayQM);

  return (
    <div
      suppressHydrationWarning
      className={`min-h-screen flex flex-col font-sans transition-colors ${
        theme === 'dark'
          ? 'bg-slate-950 text-slate-100 selection:bg-amber-500 selection:text-slate-950'
          : 'bg-slate-100 text-slate-900 selection:bg-amber-400 selection:text-slate-900'
      }`}
    >
      {/* Institutional Navigation Header */}
      <Header
        user={currentUser}
        authLoading={authLoading}
        killZone={killZone}
        marketPrice={marketPrice}
        change24h={change24h}
        feedStatus={feedStatus}
        quoteIsSpot={quoteIsSpot}
        selectedBroker={selectedBroker}
        notificationPermission={notificationPermission}
        onRequestNotification={handleRequestNotification}
        theme={theme}
        onToggleTheme={handleToggleTheme}
      />

      {/* Main Trading Terminal Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Market data provenance. Trading decisions depend on knowing whether
            the quote on screen is real, so this is never hidden. */}
        {feedStatus !== 'live' && (
          <div
            id="market-feed-status-banner"
            className={`p-4 rounded-xl border flex items-start justify-between gap-3 ${
              feedStatus === 'unavailable'
                ? 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                : feedStatus === 'stale'
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                : 'bg-slate-500/15 border-slate-500/40 text-slate-300'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-black/20 shrink-0">
                {feedStatus === 'unavailable' ? (
                  <WifiOff className="w-5 h-5" />
                ) : feedStatus === 'stale' ? (
                  <AlertTriangle className="w-5 h-5" />
                ) : (
                  <RefreshCw className="w-5 h-5 animate-spin" />
                )}
              </div>
              <div>
                <div className="font-bold text-sm tracking-tight">
                  {feedStatus === 'unavailable'
                    ? 'No live market data'
                    : feedStatus === 'stale'
                    ? 'Quote is stale'
                    : 'Connecting to market data'}
                </div>
                <div className="text-xs opacity-90 mt-0.5">{feedMessage}</div>
                <div className="text-xs opacity-75 mt-1">
                  Analysis is disabled until a live quote is available, so no signal is ever built on an invented price.
                </div>
              </div>
            </div>
            <button
              id="retry-market-feed-btn"
              type="button"
              onClick={handleManualRefresh}
              disabled={isRefreshingFeed}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-current hover:bg-white/10 cursor-pointer flex items-center gap-1 shrink-0 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingFeed ? 'animate-spin' : ''}`} />
              <span>Retry</span>
            </button>
          </div>
        )}

        <div className="text-xs text-slate-500 flex flex-wrap items-center gap-x-4 gap-y-1">
          {feedStatus === 'live' && feedSource && (
            <span className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
              <span>Live data source: {feedSource}. Refreshed about once a minute.</span>
            </span>
          )}
          <span className="flex items-center gap-1.5" title={lastSavedLabel ?? undefined}>
            {syncStatus.state === 'saved' ? (
              <Cloud className="w-3.5 h-3.5 text-emerald-400" />
            ) : syncStatus.state === 'saving' ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : syncStatus.state === 'failed' ? (
              <CloudOff className="w-3.5 h-3.5 text-rose-400" />
            ) : (
              <HardDrive className="w-3.5 h-3.5" />
            )}
            <span>
              {syncStatus.label}
              {syncStatus.state === 'saved' && lastSavedLabel ? ` ${lastSavedLabel}` : ''}
            </span>
          </span>
        </div>

        {/* A pending order that ended without filling is recorded by the engine
            itself. The notice explains what it decided and why. */}
        {autoResolveNotice && (
          <div
            id="auto-resolved-banner"
            className="p-4 rounded-xl border bg-amber-500/15 border-amber-500/40 text-amber-300 flex items-start justify-between gap-3"
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-black/20 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <div className="font-bold text-sm">Pending order closed automatically</div>
                <div className="text-xs opacity-90 mt-0.5">{autoResolveNotice}</div>
                <div className="text-xs opacity-75 mt-1">
                  No action needed. The engine has already learned from it.
                </div>
              </div>
            </div>
            <button
              id="dismiss-auto-resolve-btn"
              type="button"
              onClick={() => setAutoResolveNotice(null)}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-current hover:bg-white/10 cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* The order is older than the candles, so its path is not on record.
            The app says so and asks, rather than recording a guess. */}
        {outcomeNeedsUser && !autoResolveNotice && (
          <div
            id="outcome-unknown-banner"
            className="p-4 rounded-xl border bg-sky-500/15 border-sky-500/40 text-sky-300 flex items-start gap-3"
          >
            <div className="p-2 rounded-lg bg-black/20 shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <div className="font-bold text-sm">This one needs your answer</div>
              <div className="text-xs opacity-90 mt-0.5">{outcomeNeedsUser}</div>
              <div className="text-xs opacity-75 mt-1">
                Check your terminal and record what happened with the buttons on the signal card. The
                engine will not guess at it, because a guess here becomes a lesson it learns wrongly.
              </div>
            </div>
          </div>
        )}

        {/* Whether the trading record actually reached the cloud. A rejected
            write used to leave the screen looking entirely normal. */}
        {syncStatus.state === 'failed' && (
          <div
            id="sync-failed-banner"
            className="p-4 rounded-xl border bg-rose-500/15 border-rose-500/40 text-rose-300 flex items-start gap-3"
          >
            <div className="p-2 rounded-lg bg-black/20 shrink-0">
              <CloudOff className="w-5 h-5" />
            </div>
            <div>
              <div className="font-bold text-sm">Your data was not saved to the cloud</div>
              <div className="text-xs opacity-90 mt-0.5">{syncStatus.detail}</div>
              <div className="text-xs opacity-75 mt-1">
                Nothing is lost. This browser still holds your balance and trades.
              </div>
            </div>
          </div>
        )}

        {/* Guest data being copied into a newly signed-in account. */}
        {isMigrating && (
          <div className="p-4 rounded-xl border bg-sky-500/15 border-sky-500/40 text-sky-300 flex items-center gap-3">
            <RefreshCw className="w-5 h-5 animate-spin shrink-0" />
            <div>
              <div className="font-bold text-sm">Copying your data to this account</div>
              <div className="text-xs opacity-90 mt-0.5">
                Your balance and recorded trades are being saved to the cloud. This happens once.
              </div>
            </div>
          </div>
        )}

        {migrationNotice && (
          <div className="p-4 rounded-xl border bg-emerald-500/15 border-emerald-500/40 text-emerald-300 flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-black/20 shrink-0">
                <BellRing className="w-5 h-5" />
              </div>
              <div>
                <div className="font-bold text-sm">Data transferred</div>
                <div className="text-xs opacity-90 mt-0.5">{migrationNotice}</div>
              </div>
            </div>
            <button
              id="dismiss-migration-notice-btn"
              type="button"
              onClick={() => setMigrationNotice(null)}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-current hover:bg-white/10 cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Real-time TP/SL Proximity Alert Banner */}
        {activeProximityAlert && (
          <div
            id="proximity-alert-banner"
            className={`p-4 rounded-xl border flex items-center justify-between gap-3 shadow-md transition-all ${
              activeProximityAlert.alertType === 'TP'
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                : 'bg-rose-500/15 border-rose-500/40 text-rose-300'
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`p-2 rounded-lg ${
                  activeProximityAlert.alertType === 'TP' ? 'bg-emerald-500/20' : 'bg-rose-500/20'
                }`}
              >
                <BellRing className="w-5 h-5 animate-bounce" />
              </div>
              <div>
                <div className="font-bold text-sm tracking-tight flex items-center gap-2">
                  <span>{activeProximityAlert.title}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-black/40 font-mono">
                    Distance: ${activeProximityAlert.distanceDollars.toFixed(2)} ({activeProximityAlert.distancePips} pips)
                  </span>
                </div>
                <div className="text-xs opacity-90 mt-0.5">{activeProximityAlert.message}</div>
              </div>
            </div>
            <button
              id="dismiss-proximity-alert-btn"
              type="button"
              onClick={() => setActiveProximityAlert(null)}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-current hover:bg-white/10 cursor-pointer flex items-center gap-1 shrink-0"
            >
              <X className="w-3.5 h-3.5" />
              <span>Dismiss</span>
            </button>
          </div>
        )}

        {/* Primary Live Market Chart & TradingView Feed (Top Position) */}
        <MarketChart
          currentPrice={marketPrice}
          bidPrice={bidPrice}
          askPrice={askPrice}
          quoteAgeSeconds={quoteAgeSeconds}
          onRefreshQuote={handleManualRefresh}
          isRefreshingQuote={isRefreshingFeed}
          selectedTimeframe={selectedTimeframe}
          onSelectTimeframe={setSelectedTimeframe}
          activeSetup={activeSetup}
          indicators={displayIndicators}
          feedStatus={feedStatus}
          quotaPaced={quotaPaced}
          statusPanel={
            activeSetup && livePosition && isUnresolved(activeSetup) ? (
              <PositionStatusCard
                setup={activeSetup}
                position={livePosition}
                currentPrice={marketPrice}
                quoteAgeSeconds={quoteAgeSeconds}
                resolutionHeldBack={
                  // Only worth saying when the price is actually claiming a
                  // level has been reached; otherwise it is noise on a trade
                  // that is simply still running.
                  !tickTrust.ok && livePosition.state === 'closed' ? tickTrust.reason : null
                }
                theme={theme}
              />
            ) : null
          }
          theme={theme}
        />

        {/* Institutional Signal Execution & Portfolio Growth Tracker (Directly Below Live Chart) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Institutional Signal & MetaTrader 5 Execution Panel (6 cols) */}
          <div className="lg:col-span-6 space-y-6">
            <SignalCard
              setup={activeSetup}
              skipped={skippedSetup}
              lastOutcome={lastOutcome}
              accountType={accountType}
              isAnalyzing={isAnalyzing}
              onRunAnalysis={handleRunAnalysis}
              onSimulateOutcome={handleSimulateOutcome}
              onConvertToMarketOrder={handleConvertToMarketOrder}
              isEvaluatingOutcome={isEvaluatingOutcome}
              userEquity={equity}
              currentPrice={marketPrice}
              protectStopAtR={protectStopAtR}
              theme={theme}
            />
          </div>

          {/* Portfolio & Equity Growth Panel (6 cols) */}
          <div className="lg:col-span-6 space-y-6">
            <PortfolioGrowthCard
              currentEquity={equity}
              initialEquity={initialEquity}
              isEquityLocked={isEquityLocked}
              learningRecords={learningRecords}
              activeSetup={activeSetup}
              accountType={accountType}
              onResetBaseline={handleResetBaseline}
              onReconcileToLedger={handleReconcileToLedger}
              theme={theme}
            />
          </div>
        </div>

        {/* Equity & Risk Allocation (Lock Enforcement) */}
        <EquityManager
          equity={equity}
          isLocked={isEquityLocked}
          riskPercentage={riskPercentage}
          tradingStyle={tradingStyle}
          accountType={accountType}
          selectedBroker={selectedBroker}
          minConviction={minConviction}
          dailyLossLimit={dailyLossLimit}
          onChangeDailyLossLimit={handleChangeDailyLossLimit}
          onLockEquity={handleLockEquity}
          onChangeRiskPct={handleChangeRiskPercentage}
          onChangeMinConviction={handleChangeMinConviction}
          onChangeTradingStyle={handleChangeTradingStyle}
          onApplyTestedConfiguration={handleApplyTestedConfiguration}
          onChangeAccountType={handleChangeAccountType}
          onChangeBroker={handleChangeBroker}
          onResetEquity={handleResetEquity}
          theme={theme}
        />

        {/* Global Trading Sessions in WIB Time */}
        <TradingSessionZone theme={theme} />

        {/* Institutional Analysis & News Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: Smart Money Concepts (SMC) & Multi-Timeframe Matrix (6 cols) */}
          <div className="lg:col-span-6 space-y-6">
            {structuresReady && displayMT && displayIndicators && displayWyckoff && displayQM ? (
              <SMCMatrix
                multiTimeframe={displayMT}
                indicators={displayIndicators}
                wyckoff={displayWyckoff}
                quasimodo={displayQM}
                theme={theme}
              />
            ) : (
              <div
                className={`border rounded-2xl p-6 text-sm ${
                  theme === 'dark'
                    ? 'bg-slate-900 border-slate-800 text-slate-400'
                    : 'bg-white border-slate-200 text-slate-500'
                }`}
              >
                Market structure appears once the feed has delivered enough candles to measure it. Nothing is shown
                here until then.
              </div>
            )}

            {/* Pivot and directional bias, computed from the previous session */}
            {displayTradingCentral && <TradingCentralCard bias={displayTradingCentral} theme={theme} />}
          </div>

          {/* Right Column: Forex Factory Economic Calendar & Upcoming News (WIB) */}
          <div className="lg:col-span-6 space-y-6">
            <EconomicCalendar events={economicEvents} notice={calendarMessage} theme={theme} />
          </div>
        </div>

        {/* Rows the engine may be learning the wrong lesson from. */}
        <RecordAuditPanel
          learningRecords={learningRecords}
          onAudit={handleAuditMisses}
          onCorrect={handleCorrectRecord}
          onConfirm={handleConfirmRecord}
          accountUnit={accountUnitLabel(accountType)}
          theme={theme}
        />

        {/* Autonomous Continuous Self-Learning Engine Section */}
        <SelfLearningDashboard
          learningRecords={learningRecords}
          engineWeights={engineWeights}
          tradingStyle={tradingStyle}
          theme={theme}
        />

        {/* Historical replay: does learning from results actually help */}
        <BacktestLab
          tradingStyle={tradingStyle}
          accountType={accountType}
          brokerId={selectedBroker}
          equity={equity}
          riskPercentage={riskPercentage}
          result={backtestResult}
          onResult={setBacktestResult}
          adoptedPrior={backtestPrior}
          onAdoptPrior={handleAdoptBacktestPrior}
          protectStopAtR={protectStopAtR}
          onProtectStop={handleProtectStop}
          skipConvictionBand={skipConvictionBand}
          dailyLossLimit={dailyLossLimit}
          onSkipBand={handleSkipBand}
          theme={theme}
        />
      </main>

      {/* Footer */}
      <footer
        className={`w-full border-t py-6 text-center text-xs transition-colors ${
          theme === 'dark'
            ? 'border-slate-800/80 bg-slate-900 text-slate-500'
            : 'border-slate-200 bg-white text-slate-500'
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>XAUUSD Institutional Trading Assistant &bull; Smart Money Concepts &bull; ICT Framework</span>
          <span>Risk Warning: Gold spot trading carries market risk. Exercise proper institutional money management.</span>
        </div>
      </footer>
    </div>
  );
}

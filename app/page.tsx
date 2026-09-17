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
import { trackPosition } from '@/lib/position-tracker';
import { QUOTE_POLL_MS } from '@/lib/price-feed';
import { roundMoney } from '@/lib/trade-result';
import PositionStatusCard from '@/components/PositionStatusCard';
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
  readLocalProfile,
  type LocalProfile,
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
  playProximityChime,
  ProximityAlertEvent,
  NotificationPermissionState,
} from '@/lib/notification-utility';
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
      localStorage.setItem('xauusd_theme', next);
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
  const [feedMessage, setFeedMessage] = useState<string>('Connecting to the market data provider.');
  const [feedSource, setFeedSource] = useState<string | null>(null);
  const [liveRead, setLiveRead] = useState<LiveRead | null>(null);
  const [isRefreshingFeed, setIsRefreshingFeed] = useState<boolean>(false);

  // Equity & Risk Management State (Permanent Lock)
  const [equity, setEquity] = useState<number>(5000);
  const [initialEquity, setInitialEquity] = useState<number>(5000);
  const [isEquityLocked, setIsEquityLocked] = useState<boolean>(false);
  const [riskPercentage, setRiskPercentage] = useState<number>(1.0);
  const [tradingStyle, setTradingStyle] = useState<TradingStyle>('Intraday');
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
  const [minConviction, setMinConviction] = useState<number>(0);
  /**
   * Multiple of risk at which a setup tells the user to move the stop to entry,
   * or null when trades are held exactly as quoted. Turned on from the backtest
   * lab, and only when a run supports it.
   */
  const [protectStopAtR, setProtectStopAtR] = useState<number | null>(null);
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
  const isFilled = Boolean(activeSetup && filledSetupId === activeSetup.id);

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
    // applyLocalProfile is stable, so listing it does not resubscribe the
    // auth listener on every render.
  }, [applyLocalProfile]);

  /**
   * Pulls the real XAUUSD quote and the structural read derived from live
   * candles. There is no simulated price: when the provider cannot be reached
   * the UI says so rather than inventing a number.
   */
  const loadMarketData = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/market-data?accountType=${encodeURIComponent(accountType)}&brokerId=${encodeURIComponent(selectedBroker)}`,
        { cache: 'no-store' }
      );
      const data = await res.json();

      if (!res.ok || !data?.success || typeof data.marketPrice !== 'number') {
        setFeedStatus('unavailable');
        setFeedMessage(data?.message || 'The market data provider could not be reached.');
        return;
      }

      setFeedStatus(data.status === 'stale' ? 'stale' : 'live');
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
  const autoClosedRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (!activeSetup || !livePosition || livePosition.state !== 'closed') return;
    if (isEvaluatingOutcome || marketPrice === null) return;
    if (autoClosedRef.current === activeSetup.id) return;

    autoClosedRef.current = activeSetup.id;
    const hit = livePosition.closedBy;
    const level = hit === 'TP3' ? 3 : hit === 'TP2' ? 2 : 1;
    setAutoResolveNotice(
      hit === 'SL'
        ? `Price reached the stop at ${activeSetup.stopLoss.toFixed(2)}. The engine closed the trade and recorded it.`
        : `Price reached ${hit} at ${(hit === 'TP3'
            ? activeSetup.takeProfit3
            : hit === 'TP2'
            ? activeSetup.takeProfit2
            : activeSetup.takeProfit1
          ).toFixed(2)}. The engine closed the trade and recorded it.`
    );
    void handleSimulateOutcome(hit === 'SL' ? 'SL' : 'TP', level as 1 | 2 | 3);
    // handleSimulateOutcome closes over the same setup each render, so listing
    // it would re-fire this effect without changing anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSetup, livePosition, isEvaluatingOutcome, marketPrice]);

  const autoResolvedRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (!activeSetup || !pendingVerdict || pendingVerdict.state === 'waiting') return;
    if (isEvaluatingOutcome || marketPrice === null) return;
    if (autoResolvedRef.current === activeSetup.id) return;

    autoResolvedRef.current = activeSetup.id;
    const cause = missCause(pendingVerdict.state);
    setAutoResolveNotice(`${pendingVerdict.reason} The engine recorded it as a missed entry.`);
    void handleSimulateOutcome('MISSED', 1, cause);
    // handleSimulateOutcome is recreated each render but closes over the same
    // setup, so listing it would re-fire this effect without changing anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSetup, pendingVerdict, isEvaluatingOutcome, marketPrice]);

  const [autoResolveNotice, setAutoResolveNotice] = useState<string | null>(null);

  // Handle Locking Initial Equity
  const handleLockEquity = async (amount: number) => {
    setEquity(amount);
    setInitialEquity(amount);
    setIsEquityLocked(true);

    if (currentUser) {
      await saveToCloud(() =>
        setDoc(
          doc(db, 'users', currentUser.uid),
          {
            lockedEquity: amount,
            initialEquity: amount,
            isEquityLocked: true,
            riskPercentage,
            tradingStyle,
            accountType,
            selectedBroker,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        )
      );
    } else {
      localStorage.setItem(LOCAL_KEYS.equity, amount.toString());
      localStorage.setItem(LOCAL_KEYS.initialEquity, amount.toString());
      localStorage.setItem(LOCAL_KEYS.isLocked, 'true');
      localStorage.setItem(LOCAL_KEYS.broker, selectedBroker);
    }
  };

  /**
   * Sets the lowest conviction worth trading. Above zero the engine declines a
   * weak setup outright rather than offering it, which is what the backtest's
   * conviction breakdown is there to help choose.
   */
  const handleChangeMinConviction = (score: number) => {
    setMinConviction(score);
    setSkippedSetup(null);

    try {
      localStorage.setItem(LOCAL_KEYS.minConviction, score.toString());
    } catch {
      // A browser refusing storage simply forgets the floor on reload.
    }

    if (currentUser) {
      void saveToCloud(() =>
        setDoc(
          doc(db, 'users', currentUser.uid),
          { minConviction: score, updatedAt: new Date().toISOString() },
          { merge: true }
        )
      );
    }
  };

  /**
   * Turns the break-even rule on or off for live setups. The backtest lab only
   * offers it when a run over real history says it was the better way to hold
   * the same trades.
   */
  const handleProtectStop = (atR: number | null) => {
    setProtectStopAtR(atR);

    try {
      if (atR === null) {
        localStorage.removeItem(LOCAL_KEYS.protectStopAtR);
      } else {
        localStorage.setItem(LOCAL_KEYS.protectStopAtR, atR.toString());
      }
    } catch {
      // A browser refusing storage simply forgets the choice on reload.
    }

    if (currentUser) {
      void saveToCloud(() =>
        setDoc(
          doc(db, 'users', currentUser.uid),
          { protectStopAtR: atR, updatedAt: new Date().toISOString() },
          { merge: true }
        )
      );
    }
  };

  /**
   * Refuses, or stops refusing, a conviction band on live analysis. Offered by
   * the lab only when a band lost money in both halves of a backtested period.
   */
  const handleSkipBand = (band: { min: number; max: number } | null) => {
    setSkipConvictionBand(band);
    setSkippedSetup(null);

    try {
      if (band === null) {
        localStorage.removeItem(LOCAL_KEYS.skipConvictionBand);
      } else {
        localStorage.setItem(LOCAL_KEYS.skipConvictionBand, JSON.stringify(band));
      }
    } catch {
      // A browser refusing storage simply forgets the choice on reload.
    }

    if (currentUser) {
      void saveToCloud(() =>
        setDoc(
          doc(db, 'users', currentUser.uid),
          { skipConvictionBand: band, updatedAt: new Date().toISOString() },
          { merge: true }
        )
      );
    }
  };

  /**
   * Adopts, or drops, the parameters a backtest ended on. They become the point
   * the live learning engine shrinks toward instead of its built-in defaults;
   * real trades keep adjusting from there.
   */
  const handleAdoptBacktestPrior = (weights: PriorWeights | null) => {
    setBacktestPrior(weights);

    try {
      if (weights) {
        localStorage.setItem(LOCAL_KEYS.backtestPrior, JSON.stringify(weights));
      } else {
        localStorage.removeItem(LOCAL_KEYS.backtestPrior);
      }
    } catch {
      // A browser refusing storage simply forgets the choice on reload.
    }

    if (currentUser) {
      void saveToCloud(() =>
        setDoc(
          doc(db, 'users', currentUser.uid),
          { backtestPrior: weights, updatedAt: new Date().toISOString() },
          { merge: true }
        )
      );
    }
  };

  const handleResetBaseline = () => {
    setInitialEquity(equity);
    localStorage.setItem(LOCAL_KEYS.initialEquity, equity.toString());
    if (currentUser) {
      void saveToCloud(() =>
        setDoc(
          doc(db, 'users', currentUser.uid),
          { initialEquity: equity, updatedAt: new Date().toISOString() },
          { merge: true }
        )
      );
    }
  };

  // Update Broker Preference
  const handleChangeBroker = async (broker: BrokerId) => {
    setSelectedBroker(broker);
    if (currentUser) {
      await saveToCloud(() =>
        setDoc(doc(db, 'users', currentUser.uid), { selectedBroker: broker, updatedAt: new Date().toISOString() }, { merge: true })
      );
    } else {
      localStorage.setItem(LOCAL_KEYS.broker, broker);
    }
  };

  // Update Risk Percentage
  const handleChangeRiskPercentage = async (pct: number) => {
    setRiskPercentage(pct);
    if (currentUser) {
      await saveToCloud(() =>
        setDoc(doc(db, 'users', currentUser.uid), { riskPercentage: pct, updatedAt: new Date().toISOString() }, { merge: true })
      );
    } else {
      localStorage.setItem(LOCAL_KEYS.riskPct, pct.toString());
    }
  };

  // Update Trading Style (Scalping / Intraday / Swing)
  const handleChangeTradingStyle = async (style: TradingStyle) => {
    setTradingStyle(style);
    if (currentUser) {
      await saveToCloud(() =>
        setDoc(doc(db, 'users', currentUser.uid), { tradingStyle: style, updatedAt: new Date().toISOString() }, { merge: true })
      );
    } else {
      localStorage.setItem(LOCAL_KEYS.style, style);
    }
  };

  // Update Account Type (Standard / Cent / Pro)
  const handleChangeAccountType = async (acc: AccountType) => {
    setAccountType(acc);
    if (currentUser) {
      await saveToCloud(() =>
        setDoc(doc(db, 'users', currentUser.uid), { accountType: acc, updatedAt: new Date().toISOString() }, { merge: true })
      );
    } else {
      localStorage.setItem(LOCAL_KEYS.account, acc);
    }
  };

  const handleResetEquity = async () => {
    if (equity <= 0) {
      setIsEquityLocked(false);
      setEquity(5000);
      if (currentUser) {
        await saveToCloud(() =>
          setDoc(
            doc(db, 'users', currentUser.uid),
            { isEquityLocked: false, lockedEquity: 5000, updatedAt: new Date().toISOString() },
            { merge: true }
          )
        );
      } else {
        localStorage.setItem(LOCAL_KEYS.isLocked, 'false');
        localStorage.setItem(LOCAL_KEYS.equity, '5000');
      }
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
          statusPanel={
            activeSetup && livePosition && isUnresolved(activeSetup) ? (
              <PositionStatusCard
                setup={activeSetup}
                position={livePosition}
                currentPrice={marketPrice}
                quoteAgeSeconds={quoteAgeSeconds}
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
          onLockEquity={handleLockEquity}
          onChangeRiskPct={handleChangeRiskPercentage}
          onChangeMinConviction={handleChangeMinConviction}
          onChangeTradingStyle={handleChangeTradingStyle}
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

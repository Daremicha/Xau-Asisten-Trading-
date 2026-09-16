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
import {
  InstitutionalTradingSetup,
  TimeframeType,
  SelfLearningMemoryRecord,
  AdaptiveStrategyEngineWeights,
  TradingStyle,
  AccountType,
  BrokerId,
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
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [isEvaluatingOutcome, setIsEvaluatingOutcome] = useState<boolean>(false);

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
  const economicEvents = useMemo(() => activeSetup?.economicEvents ?? [], [activeSetup]);
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
    if (profile.learningRecords.length > 0) {
      setLearningRecords(profile.learningRecords);
      setEngineWeights(recalculateEngineWeights(profile.learningRecords, tradingStyleRef.current));
    }
  }, []);

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
          }

          // Fetch user's historical self-learning records from Firestore
          const recRef = collection(db, 'users', user.uid, 'learning_records');
          const recSnap = await getDocs(
            query(recRef, orderBy('timestamp', 'desc'), limit(RECENT_RECORD_LIMIT))
          );
          if (!recSnap.empty) {
            const loadedRecords: SelfLearningMemoryRecord[] = [];
            recSnap.forEach((d) => loadedRecords.push(d.data() as SelfLearningMemoryRecord));
            setLearningRecords(loadedRecords);
            setEngineWeights(recalculateEngineWeights(loadedRecords, tradingStyleRef.current));
          }
        } catch (err) {
          console.warn('Notice loading user cloud document:', err);
        }
      } else {
        // Guest trader: everything lives in this browser.
        setSyncStatus(GUEST_STATUS);
        applyLocalProfile(readLocalProfile());
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
      setBidPrice(typeof data.bid === 'number' ? data.bid : null);
      setAskPrice(typeof data.ask === 'number' ? data.ask : null);
      setChange24h(typeof data.change24h === 'number' ? data.change24h : null);

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

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await loadMarketData();
    };
    tick();
    // Matched to the server cache window. Polling faster only burns the data
    // provider's daily quota without producing a fresher price.
    const interval = setInterval(tick, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadMarketData]);

  const handleManualRefresh = async () => {
    setIsRefreshingFeed(true);
    await loadMarketData();
    setIsRefreshingFeed(false);
  };

  // Real-time TP/SL proximity monitoring with notifications and audio chimes
  useEffect(() => {
    if (!activeSetup || activeSetup.status !== 'ACTIVE' || marketPrice === null) return;

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
        }),
      });

      const data = await res.json();
      if (!res.ok || !data?.success) {
        setFeedMessage(data?.error || 'The analysis engine could not produce a setup.');
        if (res.status === 503) setFeedStatus('unavailable');
        return;
      }
      if (data.setup) {
        setActiveSetup(data.setup);
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
  const handleSimulateOutcome = async (outcome: 'TP' | 'SL' | 'MISSED', tpLevel: 1 | 2 | 3 = 1) => {
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
          const newEquity = Math.max(0, parseFloat((equity + (newRecord.profitOrLossDollars || 0)).toFixed(2)));
          setEquity(newEquity);

          // Update active setup status
          setActiveSetup({
            ...activeSetup,
            status: outcome === 'TP' ? 'TP_HIT' : outcome === 'SL' ? 'SL_HIT' : 'MISSED',
            closedPrice: targetExit,
            closedAt: new Date().toISOString(),
            learningOutcome: newRecord,
          });

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
          selectedTimeframe={selectedTimeframe}
          onSelectTimeframe={setSelectedTimeframe}
          activeSetup={activeSetup}
          indicators={displayIndicators}
          feedStatus={feedStatus}
          theme={theme}
        />

        {/* Institutional Signal Execution & Portfolio Growth Tracker (Directly Below Live Chart) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Institutional Signal & MetaTrader 5 Execution Panel (6 cols) */}
          <div className="lg:col-span-6 space-y-6">
            <SignalCard
              setup={activeSetup}
              isAnalyzing={isAnalyzing}
              onRunAnalysis={handleRunAnalysis}
              onSimulateOutcome={handleSimulateOutcome}
              onConvertToMarketOrder={handleConvertToMarketOrder}
              isEvaluatingOutcome={isEvaluatingOutcome}
              userEquity={equity}
              currentPrice={marketPrice}
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
          onLockEquity={handleLockEquity}
          onChangeRiskPct={handleChangeRiskPercentage}
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

            {/* Trading Central Directional Sentiment */}
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

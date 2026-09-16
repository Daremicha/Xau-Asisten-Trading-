'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, setDoc, collection, getDocs, addDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
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
import {
  getICTKillZoneStatus,
  getForexFactoryHighImpactEvents,
  getTradingCentralInstitutionalBias,
  synthesizeInstitutionalStructures,
  recalculateEngineWeights,
} from '@/lib/market-engine';
import {
  evaluatePriceProximity,
  getNotificationPermission,
  requestNotificationPermission,
  playProximityChime,
  ProximityAlertEvent,
  NotificationPermissionState,
} from '@/lib/notification-utility';
import { BellRing, X } from 'lucide-react';

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

  // Market live state
  const [marketPrice, setMarketPrice] = useState<number>(2918.45);
  const [bidPrice, setBidPrice] = useState<number>(2918.3);
  const [askPrice, setAskPrice] = useState<number>(2918.6);
  const [change24h, setChange24h] = useState<number>(14.8);
  const [selectedTimeframe, setSelectedTimeframe] = useState<TimeframeType>('H1');

  // Equity & Risk Management State (Permanent Lock)
  const [equity, setEquity] = useState<number>(5000);
  const [initialEquity, setInitialEquity] = useState<number>(5000);
  const [isEquityLocked, setIsEquityLocked] = useState<boolean>(false);
  const [riskPercentage, setRiskPercentage] = useState<number>(1.0);
  const [tradingStyle, setTradingStyle] = useState<TradingStyle>('Intraday');
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

  // Kill Zone & Macro structures
  const killZone = getICTKillZoneStatus();
  const economicEvents = getForexFactoryHighImpactEvents();
  const tradingCentral = getTradingCentralInstitutionalBias(marketPrice);
  const fallbackStructures = synthesizeInstitutionalStructures(marketPrice, engineWeights, tradingStyle);

  // Load User Data from Firestore or LocalStorage
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      setAuthLoading(false);

      if (user) {
        try {
          const userDocRef = doc(db, 'users', user.uid);
          const snap = await getDoc(userDocRef);

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
          const recSnap = await getDocs(recRef);
          if (!recSnap.empty) {
            const loadedRecords: SelfLearningMemoryRecord[] = [];
            recSnap.forEach((d) => loadedRecords.push(d.data() as SelfLearningMemoryRecord));
            setLearningRecords(loadedRecords);
            setEngineWeights(recalculateEngineWeights(loadedRecords));
          }
        } catch (err) {
          console.warn('Notice loading user cloud document:', err);
        }
      } else {
        // Fallback to localStorage for guest trader
        const localEquity = localStorage.getItem('xauusd_locked_equity');
        const localInitial = localStorage.getItem('xauusd_initial_equity');
        const localLocked = localStorage.getItem('xauusd_is_equity_locked');
        const localRisk = localStorage.getItem('xauusd_risk_pct');
        const localRecords = localStorage.getItem('xauusd_learning_records');
        const localStyle = localStorage.getItem('xauusd_trading_style') as TradingStyle | null;
        const localAccount = localStorage.getItem('xauusd_account_type') as AccountType | null;
        const localBroker = localStorage.getItem('xauusd_selected_broker') as BrokerId | null;

        if (localEquity) setEquity(parseFloat(localEquity));
        if (localInitial) setInitialEquity(parseFloat(localInitial));
        else if (localEquity) setInitialEquity(parseFloat(localEquity));
        if (localLocked) setIsEquityLocked(localLocked === 'true');
        if (localRisk) setRiskPercentage(parseFloat(localRisk));
        if (localStyle) setTradingStyle(localStyle);
        if (localAccount) setAccountType(localAccount);
        if (localBroker) setSelectedBroker(localBroker);

        if (localRecords) {
          try {
            const parsed: SelfLearningMemoryRecord[] = JSON.parse(localRecords);
            setLearningRecords(parsed);
            setEngineWeights(recalculateEngineWeights(parsed));
          } catch (e) {
            console.warn('Error reading local learning memory:', e);
          }
        }
      }
    });

    return () => unsubscribe();
  }, []);

  // Simulate Live Price Jitter for realistic institutional order flow
  useEffect(() => {
    const interval = setInterval(() => {
      setMarketPrice((prev) => {
        const delta = (Math.random() - 0.49) * 0.45;
        const next = Math.round((prev + delta) * 100) / 100;
        const spread = accountType === 'Pro' ? 0.03 : 0.25;
        setBidPrice(parseFloat((next - spread / 2).toFixed(2)));
        setAskPrice(parseFloat((next + spread / 2).toFixed(2)));
        return next;
      });
    }, 2800);

    return () => clearInterval(interval);
  }, [accountType]);

  // Real-time TP/SL proximity monitoring with notifications and audio chimes
  useEffect(() => {
    if (!activeSetup || activeSetup.status !== 'ACTIVE') return;

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
      try {
        const userDocRef = doc(db, 'users', currentUser.uid);
        await setDoc(
          userDocRef,
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
        );
      } catch (err) {
        console.warn('Error saving locked equity to Firestore:', err);
      }
    } else {
      localStorage.setItem('xauusd_locked_equity', amount.toString());
      localStorage.setItem('xauusd_initial_equity', amount.toString());
      localStorage.setItem('xauusd_is_equity_locked', 'true');
      localStorage.setItem('xauusd_selected_broker', selectedBroker);
    }
  };

  const handleResetBaseline = () => {
    setInitialEquity(equity);
    localStorage.setItem('xauusd_initial_equity', equity.toString());
    if (currentUser) {
      const userDocRef = doc(db, 'users', currentUser.uid);
      setDoc(userDocRef, { initialEquity: equity, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
    }
  };

  // Update Broker Preference
  const handleChangeBroker = async (broker: BrokerId) => {
    setSelectedBroker(broker);
    if (currentUser) {
      try {
        const userDocRef = doc(db, 'users', currentUser.uid);
        await setDoc(userDocRef, { selectedBroker: broker, updatedAt: new Date().toISOString() }, { merge: true });
      } catch (e) {
        console.warn('Error saving broker preference:', e);
      }
    } else {
      localStorage.setItem('xauusd_selected_broker', broker);
    }
  };

  // Update Risk Percentage
  const handleChangeRiskPercentage = async (pct: number) => {
    setRiskPercentage(pct);
    if (currentUser) {
      try {
        const userDocRef = doc(db, 'users', currentUser.uid);
        await setDoc(userDocRef, { riskPercentage: pct, updatedAt: new Date().toISOString() }, { merge: true });
      } catch (e) {
        console.warn('Error saving risk percentage:', e);
      }
    } else {
      localStorage.setItem('xauusd_risk_pct', pct.toString());
    }
  };

  // Update Trading Style (Scalping / Intraday / Swing)
  const handleChangeTradingStyle = async (style: TradingStyle) => {
    setTradingStyle(style);
    if (currentUser) {
      try {
        const userDocRef = doc(db, 'users', currentUser.uid);
        await setDoc(userDocRef, { tradingStyle: style, updatedAt: new Date().toISOString() }, { merge: true });
      } catch (e) {
        console.warn('Error saving trading style:', e);
      }
    } else {
      localStorage.setItem('xauusd_trading_style', style);
    }
  };

  // Update Account Type (Standard / Cent / Pro)
  const handleChangeAccountType = async (acc: AccountType) => {
    setAccountType(acc);
    if (currentUser) {
      try {
        const userDocRef = doc(db, 'users', currentUser.uid);
        await setDoc(userDocRef, { accountType: acc, updatedAt: new Date().toISOString() }, { merge: true });
      } catch (e) {
        console.warn('Error saving account tier:', e);
      }
    } else {
      localStorage.setItem('xauusd_account_type', acc);
    }
  };

  const handleResetEquity = async () => {
    if (equity <= 0) {
      setIsEquityLocked(false);
      setEquity(5000);
      if (currentUser) {
        try {
          const userDocRef = doc(db, 'users', currentUser.uid);
          await setDoc(
            userDocRef,
            { isEquityLocked: false, lockedEquity: 5000, updatedAt: new Date().toISOString() },
            { merge: true }
          );
        } catch (e) {
          console.warn('Error resetting equity:', e);
        }
      } else {
        localStorage.setItem('xauusd_is_equity_locked', 'false');
        localStorage.setItem('xauusd_locked_equity', '5000');
      }
    }
  };

  // Run Institutional Analysis
  const handleRunAnalysis = async () => {
    setIsAnalyzing(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPrice: marketPrice,
          equity,
          riskPercentage,
          tradingStyle,
          accountType,
          brokerId: selectedBroker,
          userId: currentUser?.uid || 'guest',
          pastLearningRecords: learningRecords,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.setup) {
          setActiveSetup(data.setup);
          if (data.engineWeights) {
            setEngineWeights(data.engineWeights);
          }

          // Save setup to Firestore if user is authenticated
          if (currentUser) {
            try {
              const setupRef = collection(db, 'users', currentUser.uid, 'analyses');
              await addDoc(setupRef, data.setup);
            } catch (e) {
              console.warn('Could not save analysis to cloud:', e);
            }
          }
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
    const slPips = Math.max(10, Math.round(Math.abs(newEntryPrice - activeSetup.stopLoss) * 10));
    const riskDollars = activeSetup.riskDollarAmount;
    const contractSize = activeSetup.contractSpecs?.contractSizeOz || 100;
    const pipValuePerLot = contractSize === 1 ? 0.1 : 10.0;
    const rawLot = riskDollars / (slPips * pipValuePerLot);
    const minLot = activeSetup.accountType === 'Cent' ? 0.1 : 0.01;
    const maxLot = activeSetup.accountType === 'Cent' ? 1000.0 : 100.0;
    const adjustedLot = Math.min(maxLot, Math.max(minLot, Math.floor(rawLot * 100) / 100));

    const tpDistance = Math.abs(activeSetup.takeProfit1 - activeSetup.entryPrice);
    const isBuy = activeSetup.orderType.includes('BUY');

    const updatedSetup: InstitutionalTradingSetup = {
      ...activeSetup,
      orderType: isBuy ? 'BUY INSTANT' : 'SELL INSTANT',
      entryPrice: newEntryPrice,
      stopLossPips: slPips,
      recommendedLotSize: adjustedLot,
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
        `Risk budget strictly preserved at $${riskDollars.toFixed(2)}`,
      ],
    };

    setActiveSetup(updatedSetup);
  };

  // Simulate Outcome & Trigger Autonomous Self-Learning Engine (TP, SL, or MISSED)
  const handleSimulateOutcome = async (outcome: 'TP' | 'SL' | 'MISSED', tpLevel: 1 | 2 | 3 = 1) => {
    if (!activeSetup) return;
    setIsEvaluatingOutcome(true);

    try {
      const targetExit =
        outcome === 'TP'
          ? tpLevel === 3
            ? activeSetup.takeProfit3
            : tpLevel === 2
            ? activeSetup.takeProfit2
            : activeSetup.takeProfit1
          : outcome === 'SL'
          ? activeSetup.stopLoss
          : marketPrice;

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
          const newWeights = recalculateEngineWeights(updatedRecords);
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
            try {
              const recRef = collection(db, 'users', currentUser.uid, 'learning_records');
              await addDoc(recRef, newRecord);

              const userDocRef = doc(db, 'users', currentUser.uid);
              await setDoc(
                userDocRef,
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
            } catch (e) {
              console.warn('Error saving self-learning record:', e);
            }
          } else {
            localStorage.setItem('xauusd_learning_records', JSON.stringify(updatedRecords));
            localStorage.setItem('xauusd_locked_equity', newEquity.toString());
          }
        }
      }
    } catch (err) {
      console.warn('Error running post-trade evaluation:', err);
    } finally {
      setIsEvaluatingOutcome(false);
    }
  };

  const activeOrFallbackMT = activeSetup
    ? activeSetup.multiTimeframeAlignment
    : fallbackStructures.multiTimeframe;

  const activeOrFallbackIndicators = activeSetup
    ? activeSetup.technicalIndicators
    : fallbackStructures.indicators;

  const activeOrFallbackWyckoff = activeSetup
    ? activeSetup.wyckoffVsa
    : fallbackStructures.wyckoff;

  const activeOrFallbackQM = activeSetup
    ? activeSetup.quasimodo
    : fallbackStructures.quasimodo;

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
        selectedBroker={selectedBroker}
        notificationPermission={notificationPermission}
        onRequestNotification={handleRequestNotification}
        theme={theme}
        onToggleTheme={handleToggleTheme}
      />

      {/* Main Trading Terminal Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
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
            <SMCMatrix
              multiTimeframe={activeOrFallbackMT}
              indicators={activeOrFallbackIndicators}
              wyckoff={activeOrFallbackWyckoff}
              quasimodo={activeOrFallbackQM}
              theme={theme}
            />

            {/* Trading Central Directional Sentiment */}
            <TradingCentralCard
              bias={activeSetup ? activeSetup.tradingCentralBias : tradingCentral}
              theme={theme}
            />
          </div>

          {/* Right Column: Forex Factory Economic Calendar & Upcoming News (WIB) */}
          <div className="lg:col-span-6 space-y-6">
            <EconomicCalendar
              events={activeSetup ? activeSetup.economicEvents : economicEvents}
              theme={theme}
            />
          </div>
        </div>

        {/* Autonomous Continuous Self-Learning Engine Section */}
        <SelfLearningDashboard
          learningRecords={learningRecords}
          engineWeights={engineWeights}
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

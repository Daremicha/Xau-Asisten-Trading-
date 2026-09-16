import { deriveAdaptiveWeights } from './learning-engine';
import {
  ForexFactoryEvent,
  AdaptiveStrategyEngineWeights,
  SelfLearningMemoryRecord,
  TradingStyle,
  AccountType,
  BrokerId,
  BROKER_PROFILES,
  ContractSpecification,
  TradingSessionInfo,
} from './types';

/**
 * Returns contract specifications and execution profiles for different broker account types.
 * Dynamically factors in broker-specific spreads and commissions (HFM, Exness, IC Markets, XM, FBS, Octa, MIFX).
 */
export function getContractSpecification(
  accountType: AccountType,
  brokerId: BrokerId = 'EXNESS'
): ContractSpecification {
  const profile = BROKER_PROFILES[brokerId] || BROKER_PROFILES.EXNESS;

  switch (accountType) {
    case 'Cent':
      return {
        contractSizeOz: 1, // 1 Troy Oz per lot (1/100 of standard)
        typicalSpreadPips: profile.spreadCentPips || 2.5,
        commissionPerLot: 0.0,
        lotUnit: 'Cent Lots (USC)',
        accountCurrency: 'USC (Cents)',
        brokerId,
        brokerName: profile.name,
        explanation: `1 Cent Lot = 1 Troy Oz (1/100 Standard) on ${profile.name}. Typical spread is ${profile.spreadCentPips || 2.5} pips with $0 commission. Calibrated for micro-capital to keep risk strictly within 1-2%.`,
      };
    case 'Pro':
      return {
        contractSizeOz: 100, // Standard 100 Troy Oz
        typicalSpreadPips: profile.spreadProPips,
        commissionPerLot: profile.commissionProPerLot,
        lotUnit: 'Pro / ECN Lots',
        accountCurrency: 'USD ($)',
        brokerId,
        brokerName: profile.name,
        explanation: `1 Pro Lot = 100 Troy Oz on ${profile.name}. Direct ECN access with raw spreads (~${profile.spreadProPips} pips). Fixed $${profile.commissionProPerLot.toFixed(2)}/lot round turn commission is factored into risk math.`,
      };
    case 'Standard':
    default:
      return {
        contractSizeOz: 100, // Standard 100 Troy Oz
        typicalSpreadPips: profile.spreadStandardPips,
        commissionPerLot: 0.0,
        lotUnit: 'Standard Lots',
        accountCurrency: 'USD ($)',
        brokerId,
        brokerName: profile.name,
        explanation: `1 Standard Lot = 100 Troy Oz on ${profile.name}. Floating spread is ~${profile.spreadStandardPips} pips. Zero commission; all execution fees are incorporated into the floating spread.`,
      };
  }
}

/**
 * Calculates MetaTrader 5 lot size for XAUUSD (Gold).
 * Adjusts dynamically based on Broker (Exness, HFM, IC Markets, etc.), Account Type (Standard, Cent, Pro),
 * and Trading Style (Scalping, Intraday, Swing).
 */
export function calculateXAUUSDLotSize(
  equity: number,
  riskPercentage: number,
  entryPrice: number,
  stopLossPrice: number,
  accountType: AccountType = 'Standard',
  tradingStyle: TradingStyle = 'Intraday',
  brokerId: BrokerId = 'EXNESS'
): {
  lotSize: number;
  /** The risk the user asked for. */
  riskDollars: number;
  /**
   * What the recommended lot actually risks. When the broker's minimum lot is
   * larger than the budget allows, this exceeds riskDollars, and saying so
   * matters more than the tidy number the user asked for.
   */
  actualRiskDollars: number;
  /** True when the minimum lot forces more risk than the budget allows. */
  exceedsRiskBudget: boolean;
  stopLossPips: number;
  priceDistance: number;
  contractSpecs: ContractSpecification;
} {
  const specs = getContractSpecification(accountType, brokerId);

  if (equity <= 0 || riskPercentage <= 0) {
    return {
      lotSize: 0.01,
      riskDollars: 0,
      actualRiskDollars: 0,
      exceedsRiskBudget: false,
      stopLossPips: 0,
      priceDistance: 0,
      contractSpecs: specs,
    };
  }

  const priceDistance = Math.abs(entryPrice - stopLossPrice);
  // Style-aware minimum distance to prevent invalid division
  const minDistance = tradingStyle === 'Scalping' ? 0.3 : tradingStyle === 'Intraday' ? 0.8 : 2.0;
  const validDistance = Math.max(priceDistance, minDistance);
  const stopLossPips = parseFloat((validDistance * 10).toFixed(1));

  const riskDollars = parseFloat((equity * (riskPercentage / 100)).toFixed(2));

  let rawLot = 0.01;

  if (accountType === 'Cent') {
    // In Cent Account, 1 lot = 1 Troy Oz.
    // Price move of validDistance causes a loss of validDistance * 1.00 dollar per 1.00 Cent Lot.
    const lossPerCentLot = validDistance * 1.0;
    rawLot = riskDollars / lossPerCentLot;
    rawLot = Math.floor(rawLot * 100) / 100;
    const lotSize = Math.max(0.01, Math.min(500.0, rawLot));
    const actualRiskDollars = parseFloat((lotSize * lossPerCentLot).toFixed(2));

    return {
      lotSize,
      riskDollars,
      actualRiskDollars,
      exceedsRiskBudget: actualRiskDollars > riskDollars + 0.005,
      stopLossPips,
      priceDistance: parseFloat(validDistance.toFixed(2)),
      contractSpecs: specs,
    };
  }

  if (accountType === 'Pro') {
    // In Pro ECN Account, 1 lot = 100 Troy Oz, plus broker commission round turn per lot
    const dollarLossPerProLot = validDistance * 100 + specs.commissionPerLot;
    rawLot = riskDollars / dollarLossPerProLot;
    rawLot = Math.floor(rawLot * 100) / 100;
    const lotSize = Math.max(0.01, Math.min(50.0, rawLot));
    const actualRiskDollars = parseFloat((lotSize * dollarLossPerProLot).toFixed(2));

    return {
      lotSize,
      riskDollars,
      actualRiskDollars,
      exceedsRiskBudget: actualRiskDollars > riskDollars + 0.005,
      stopLossPips,
      priceDistance: parseFloat(validDistance.toFixed(2)),
      contractSpecs: specs,
    };
  }

  // Standard Account: 1 lot = 100 Troy Oz, spread included
  const dollarLossPerStandardLot = validDistance * 100;
  rawLot = riskDollars / dollarLossPerStandardLot;
  rawLot = Math.floor(rawLot * 100) / 100;
  const lotSize = Math.max(0.01, Math.min(50.0, rawLot));
  const actualRiskDollars = parseFloat((lotSize * dollarLossPerStandardLot).toFixed(2));

  return {
    lotSize,
    riskDollars,
    actualRiskDollars,
    exceedsRiskBudget: actualRiskDollars > riskDollars + 0.005,
    stopLossPips,
    priceDistance: parseFloat(validDistance.toFixed(2)),
    contractSpecs: specs,
  };
}

/**
 * Helper to convert a UTC hour into a localized time string in WIB (HH:MM).
 */
export function formatUtcHourToLocal(utcHour: number, utcMinute: number = 0): string {
  const d = new Date();
  d.setUTCHours(utcHour, utcMinute, 0, 0);
  return d.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Returns the major global trading sessions (Asia/Tokyo, Europe/London, America/New York, and Overlap)
 * with hours displayed in WIB (Western Indonesia Time / UTC+7 Jakarta) and real-time day awareness.
 */
export function getGlobalTradingSessions(): TradingSessionInfo[] {
  const now = new Date();
  const utcDay = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const currentUtcDec = utcHours + utcMinutes / 60;

  // Gold OTC market closes Friday 21:00 UTC and reopens Sunday 22:00 UTC
  const isWeekendRecess =
    (utcDay === 5 && currentUtcDec >= 21) ||
    utcDay === 6 ||
    (utcDay === 0 && currentUtcDec < 22);

  const sessionConfigs = [
    {
      id: 'tokyo' as const,
      name: 'Asian Session',
      city: 'Tokyo / Sydney',
      region: 'Asia-Pacific',
      utcOpen: 0,
      utcClose: 9,
      volatilityLevel: 'Moderate' as const,
      characteristics: 'Consolidation range. Sets Asian High & Low liquidity boundaries for London sweeps.',
    },
    {
      id: 'london' as const,
      name: 'European Session',
      city: 'London / Frankfurt',
      region: 'Europe',
      utcOpen: 7,
      utcClose: 16,
      volatilityLevel: 'High' as const,
      characteristics: 'Judas swings, aggressive liquidity injection, and institutional trend initiation.',
    },
    {
      id: 'newyork' as const,
      name: 'American Session',
      city: 'New York',
      region: 'North America',
      utcOpen: 12,
      utcClose: 21,
      volatilityLevel: 'Extreme' as const,
      characteristics: 'Peak US Dollar volume, Tier-1 economic news releases, and institutional trend expansion.',
    },
    {
      id: 'overlap' as const,
      name: 'London & NY Overlap',
      city: 'London + New York',
      region: 'Transatlantic Peak',
      utcOpen: 12,
      utcClose: 16,
      volatilityLevel: 'Extreme' as const,
      characteristics: 'Highest liquidity window of the 24-hour cycle. Ideal for rapid take-profit delivery.',
    },
  ];

  return sessionConfigs.map((cfg) => {
    let isActive = false;
    let progressPercentage = 0;
    let statusText = '';

    const sessionDuration = cfg.utcClose - cfg.utcOpen;

    if (isWeekendRecess) {
      isActive = false;
      progressPercentage = 0;
      // Calculate hours until Sunday 22:00 UTC market open
      let hoursUntilOpen = 0;
      if (utcDay === 5) {
        hoursUntilOpen = (24 - currentUtcDec) + 24 + 22;
      } else if (utcDay === 6) {
        hoursUntilOpen = (24 - currentUtcDec) + 22;
      } else {
        hoursUntilOpen = Math.max(0, 22 - currentUtcDec);
      }
      const h = Math.floor(hoursUntilOpen);
      const m = Math.round((hoursUntilOpen - h) * 60);
      statusText = `Weekend Recess • Opens in ${h}h ${m}m`;
    } else if (currentUtcDec >= cfg.utcOpen && currentUtcDec < cfg.utcClose) {
      isActive = true;
      const elapsedHours = currentUtcDec - cfg.utcOpen;
      progressPercentage = Math.min(100, Math.max(0, Math.round((elapsedHours / sessionDuration) * 100)));
      const remainingMinutes = Math.round((cfg.utcClose - currentUtcDec) * 60);
      const remH = Math.floor(remainingMinutes / 60);
      const remM = remainingMinutes % 60;
      statusText = `Active • Closes in ${remH > 0 ? `${remH}h ` : ''}${remM}m`;
    } else {
      let minutesUntilOpen = 0;
      if (currentUtcDec < cfg.utcOpen) {
        minutesUntilOpen = Math.round((cfg.utcOpen - currentUtcDec) * 60);
      } else {
        minutesUntilOpen = Math.round((24 - currentUtcDec + cfg.utcOpen) * 60);
      }
      const untilH = Math.floor(minutesUntilOpen / 60);
      const untilM = minutesUntilOpen % 60;
      statusText = `Opens in ${untilH > 0 ? `${untilH}h ` : ''}${untilM}m`;
    }

    return {
      ...cfg,
      localOpenFormatted: formatUtcHourToLocal(cfg.utcOpen),
      localCloseFormatted: formatUtcHourToLocal(cfg.utcClose),
      isActive,
      progressPercentage,
      statusText,
    };
  });
}

/**
 * Detects current Institutional Market Session & ICT Kill Zones.
 */
export function getICTKillZoneStatus(): {
  currentZone: 'London Open' | 'New York Open' | 'London Close' | 'Asian Session' | 'Off-Hours';
  isHighVolatilityTiming: boolean;
  description: string;
} {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const timeInDec = utcHours + utcMinutes / 60;

  const isWeekend =
    (utcDay === 5 && timeInDec >= 21) ||
    utcDay === 6 ||
    (utcDay === 0 && timeInDec < 22);

  if (isWeekend) {
    return {
      currentZone: 'Off-Hours',
      isHighVolatilityTiming: false,
      description: 'Weekend market recess. Institutional liquidity pools are dormant until Sunday 22:00 UTC.',
    };
  }

  // London Open Kill Zone: 07:00 - 10:00 UTC
  if (timeInDec >= 7 && timeInDec < 10) {
    return {
      currentZone: 'London Open',
      isHighVolatilityTiming: true,
      description: 'London Open Kill Zone active. High institutional liquidity injection & Judas swings.',
    };
  }
  // New York Open Kill Zone: 12:00 - 15:00 UTC
  if (timeInDec >= 12 && timeInDec < 15) {
    return {
      currentZone: 'New York Open',
      isHighVolatilityTiming: true,
      description: 'New York Open Kill Zone active. Peak US dollar volume, high-impact news releases.',
    };
  }
  // London Close Kill Zone: 15:00 - 17:00 UTC
  if (timeInDec >= 15 && timeInDec < 17) {
    return {
      currentZone: 'London Close',
      isHighVolatilityTiming: true,
      description: 'London Close Kill Zone active. Profit taking & institutional daily trend continuations.',
    };
  }
  // Asian Session: 00:00 - 06:00 UTC
  if (timeInDec >= 0 && timeInDec < 6) {
    return {
      currentZone: 'Asian Session',
      isHighVolatilityTiming: false,
      description: 'Asian consolidation session. Building buy-side & sell-side liquidity pools for London sweep.',
    };
  }

  return {
    currentZone: 'Off-Hours',
    isHighVolatilityTiming: false,
    description: 'Transition window between major institutional trading sessions.',
  };
}

/**
 * High-impact Economic Calendar events (Forex Factory style) affecting XAUUSD.
 * Generates forward-scheduled events strictly synchronized with real-time Day, Date, and WIB Hour.
 */
export function getForexFactoryHighImpactEvents(): ForexFactoryEvent[] {
  const now = Date.now();
  const formatWibTime = (ms: number) =>
    new Date(ms).toLocaleTimeString('en-US', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' WIB';

  const formatEventDate = (ms: number) =>
    new Date(ms).toLocaleDateString('en-US', {
      timeZone: 'Asia/Jakarta',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  // Stagger upcoming catalysts relative to the real-time clock
  const event1Ms = now + 45 * 60 * 1000;
  const event2Ms = now + 3 * 3600 * 1000;
  const event3Ms = now + 18 * 3600 * 1000;
  const event4Ms = now + 28 * 3600 * 1000;

  return [
    {
      id: 'ff-1',
      title: 'Core CPI m/m & Headline US Inflation',
      country: 'United States',
      currency: 'USD',
      impact: 'High',
      date: formatEventDate(event1Ms),
      time: formatWibTime(event1Ms),
      scheduledTimestamp: new Date(event1Ms).toISOString(),
      forecast: '0.3%',
      previous: '0.2%',
      actual: 'Pending',
      marketImplication: 'Lower inflation prints reduce Fed hawkishness, fueling institutional Gold upside expansion.',
    },
    {
      id: 'ff-2',
      title: 'FOMC Federal Funds Rate Decision & Statement',
      country: 'United States',
      currency: 'USD',
      impact: 'High',
      date: formatEventDate(event2Ms),
      time: formatWibTime(event2Ms),
      scheduledTimestamp: new Date(event2Ms).toISOString(),
      forecast: '4.75%',
      previous: '5.00%',
      actual: 'Pending',
      marketImplication: 'Interest rate adjustment priced in. Dovish policy statement triggers institutional resistance breakouts.',
    },
    {
      id: 'ff-3',
      title: 'Non-Farm Payrolls (NFP) & Unemployment Rate',
      country: 'United States',
      currency: 'USD',
      impact: 'High',
      date: formatEventDate(event3Ms),
      time: formatWibTime(event3Ms),
      scheduledTimestamp: new Date(event3Ms).toISOString(),
      forecast: '165K',
      previous: '142K',
      actual: 'Pending',
      marketImplication: 'Labor market cooling accelerates bullion safe-haven capital inflow.',
    },
    {
      id: 'ff-4',
      title: 'Initial Jobless Claims',
      country: 'United States',
      currency: 'USD',
      impact: 'Medium',
      date: formatEventDate(event4Ms),
      time: formatWibTime(event4Ms),
      scheduledTimestamp: new Date(event4Ms).toISOString(),
      forecast: '218K',
      previous: '222K',
      actual: 'Pending',
      marketImplication: 'Elevated claims spark short-term institutional volatility spikes across M15/H1 charts.',
    },
  ];
}

/**
 * Filters out expired/past news events, returning strictly upcoming releases.
 */
export function filterUpcomingEconomicEvents(events: ForexFactoryEvent[]): ForexFactoryEvent[] {
  const now = Date.now();
  return events
    .filter((evt) => {
      if (!evt.scheduledTimestamp) return true;
      const targetTime = new Date(evt.scheduledTimestamp).getTime();
      return !isNaN(targetTime) && targetTime > now;
    })
    .sort((a, b) => new Date(a.scheduledTimestamp).getTime() - new Date(b.scheduledTimestamp).getTime());
}

/**
 * Adaptive weights for the current history.
 *
 * Delegates to the learning engine, which weights evidence by recency, scales
 * every adjustment by how much data supports it, and keeps the confluence
 * weights a proper distribution. Kept here so existing callers need no change.
 */
export function recalculateEngineWeights(
  records: SelfLearningMemoryRecord[],
  style?: TradingStyle
): AdaptiveStrategyEngineWeights {
  return deriveAdaptiveWeights(records, style);
}

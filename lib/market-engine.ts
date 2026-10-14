import { deriveAdaptiveWeights, type PriorWeights } from './learning-engine';
import { roundMoney } from './trade-result';
import {
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
        explanation: `1 Cent Lot = 1 Troy Oz (1/100 Standard) di ${profile.name}. Spread biasa ${profile.spreadCentPips || 2.5} pips tanpa komisi. Cocok untuk modal mikro supaya risiko tetap di 1-2%.`,
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
        explanation: `1 Pro Lot = 100 Troy Oz di ${profile.name}. Akses ECN langsung dengan spread raw (~${profile.spreadProPips} pips). Komisi tetap $${profile.commissionProPerLot.toFixed(2)}/lot pulang-pergi sudah dihitung dalam risiko.`,
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
        explanation: `1 Standard Lot = 100 Troy Oz di ${profile.name}. Spread mengambang sekitar ${profile.spreadStandardPips} pips. Tanpa komisi; semua biaya eksekusi sudah termasuk dalam spread mengambang.`,
      };
  }
}

/**
 * Dollars of price a stop is assumed to slip by when it fills, on top of the
 * spread. The backtest charges the same amount, so the risk the card quotes is
 * the risk the replay measured.
 */
export const STOP_SLIPPAGE_DOLLARS = 0.2;

/**
 * Whether a setup the broker's minimum lot cannot size within the user's risk
 * percentage is refused. On by default: the percentage is a ceiling, and a
 * trade that breaks it should be the user's explicit choice.
 */
export const DEFAULT_RISK_GUARD = true;

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
   * What the recommended lot actually risks, spread and stop slippage included.
   * When the broker's minimum lot is larger than the budget allows, this
   * exceeds riskDollars, and saying so matters more than the tidy number the
   * user asked for.
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
  // A stop loses more than its distance: the spread is paid on the way in and
  // the stop can slip on the way out. Sizing on the distance alone let the
  // real loss run past the budget the user set, so the lot is sized on both.
  const lossPerOz = validDistance + specs.typicalSpreadPips * 0.1 + STOP_SLIPPAGE_DOLLARS;

  // Four decimals, not two. On a cent account two decimals of a dollar is a
  // whole cent, so a budget of 4.5 cent was being rounded to 5 and the number
  // on screen disagreed with the percentage that produced it.
  const riskDollars = roundMoney(equity * (riskPercentage / 100));

  let rawLot = 0.01;

  if (accountType === 'Cent') {
    // In Cent Account, 1 lot = 1 Troy Oz.
    // Each dollar the stop costs an ounce is one dollar per 1.00 Cent Lot.
    const lossPerCentLot = lossPerOz * 1.0;
    rawLot = riskDollars / lossPerCentLot;
    rawLot = Math.floor(rawLot * 100) / 100;
    const lotSize = Math.max(0.01, Math.min(500.0, rawLot));
    const actualRiskDollars = roundMoney(lotSize * lossPerCentLot);

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
    const dollarLossPerProLot = lossPerOz * 100 + specs.commissionPerLot;
    rawLot = riskDollars / dollarLossPerProLot;
    rawLot = Math.floor(rawLot * 100) / 100;
    const lotSize = Math.max(0.01, Math.min(50.0, rawLot));
    const actualRiskDollars = roundMoney(lotSize * dollarLossPerProLot);

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

  // Standard Account: 1 lot = 100 Troy Oz
  const dollarLossPerStandardLot = lossPerOz * 100;
  rawLot = riskDollars / dollarLossPerStandardLot;
  rawLot = Math.floor(rawLot * 100) / 100;
  const lotSize = Math.max(0.01, Math.min(50.0, rawLot));
  const actualRiskDollars = roundMoney(lotSize * dollarLossPerStandardLot);

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
      name: 'Sesi Asia',
      city: 'Tokyo / Sydney',
      region: 'Asia-Pacific',
      utcOpen: 0,
      utcClose: 9,
      volatilityLevel: 'Moderate' as const,
      characteristics: 'Range konsolidasi. Membentuk batas likuiditas High & Low Asia untuk sweep London.',
    },
    {
      id: 'london' as const,
      name: 'Sesi Eropa',
      city: 'London / Frankfurt',
      region: 'Eropa',
      utcOpen: 7,
      utcClose: 16,
      volatilityLevel: 'High' as const,
      characteristics: 'Judas swing, masuknya likuiditas agresif, dan awal tren institusional.',
    },
    {
      id: 'newyork' as const,
      name: 'Sesi Amerika',
      city: 'New York',
      region: 'Amerika Utara',
      utcOpen: 12,
      utcClose: 21,
      volatilityLevel: 'Extreme' as const,
      characteristics: 'Volume dolar AS tertinggi, rilis berita ekonomi utama, dan perluasan tren institusional.',
    },
    {
      id: 'overlap' as const,
      name: 'Tumpang Tindih London & NY',
      city: 'London + New York',
      region: 'Puncak Transatlantik',
      utcOpen: 12,
      utcClose: 16,
      volatilityLevel: 'Extreme' as const,
      characteristics: 'Jendela likuiditas tertinggi dalam siklus 24 jam. Ideal untuk take profit yang cepat.',
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
      statusText = `Libur Akhir Pekan • Buka dalam ${h}j ${m}m`;
    } else if (currentUtcDec >= cfg.utcOpen && currentUtcDec < cfg.utcClose) {
      isActive = true;
      const elapsedHours = currentUtcDec - cfg.utcOpen;
      progressPercentage = Math.min(100, Math.max(0, Math.round((elapsedHours / sessionDuration) * 100)));
      const remainingMinutes = Math.round((cfg.utcClose - currentUtcDec) * 60);
      const remH = Math.floor(remainingMinutes / 60);
      const remM = remainingMinutes % 60;
      statusText = `Aktif • Tutup dalam ${remH > 0 ? `${remH}j ` : ''}${remM}m`;
    } else {
      let minutesUntilOpen = 0;
      if (currentUtcDec < cfg.utcOpen) {
        minutesUntilOpen = Math.round((cfg.utcOpen - currentUtcDec) * 60);
      } else {
        minutesUntilOpen = Math.round((24 - currentUtcDec + cfg.utcOpen) * 60);
      }
      const untilH = Math.floor(minutesUntilOpen / 60);
      const untilM = minutesUntilOpen % 60;
      statusText = `Buka dalam ${untilH > 0 ? `${untilH}j ` : ''}${untilM}m`;
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
export function getICTKillZoneStatus(now: Date = new Date()): {
  currentZone: 'London Open' | 'New York Open' | 'London Close' | 'Asian Session' | 'Off-Hours';
  isHighVolatilityTiming: boolean;
  description: string;
} {
  // The moment is a parameter so a backtest can ask what the session was at a
  // historical candle instead of what it is right now.
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
      description: 'Pasar libur akhir pekan. Likuiditas institusional tidur sampai Minggu 22:00 UTC.',
    };
  }

  // The kill zones are fixed UTC hours, which match London and New York only in
  // northern winter; in summer both open an hour earlier. That is deliberate,
  // not an oversight: a 24 month replay with the zones shifted for US daylight
  // saving did slightly worse (profit factor 1.35 to 1.31 at a floor of 40
  // with the stop to entry at 1R, and 1.31 to 1.30 taking everything), and
  // the session rules were tested on these hours. Re-test before changing them.

  // London Open Kill Zone: 07:00 - 10:00 UTC
  if (timeInDec >= 7 && timeInDec < 10) {
    return {
      currentZone: 'London Open',
      isHighVolatilityTiming: true,
      description: 'Kill Zone Pembukaan London aktif. Masuknya likuiditas institusional tinggi & Judas swing.',
    };
  }
  // New York Open Kill Zone: 12:00 - 15:00 UTC
  if (timeInDec >= 12 && timeInDec < 15) {
    return {
      currentZone: 'New York Open',
      isHighVolatilityTiming: true,
      description: 'Kill Zone Pembukaan New York aktif. Volume dolar AS puncak, rilis berita berdampak tinggi.',
    };
  }
  // London Close Kill Zone: 15:00 - 17:00 UTC
  if (timeInDec >= 15 && timeInDec < 17) {
    return {
      currentZone: 'London Close',
      isHighVolatilityTiming: true,
      description: 'Kill Zone Penutupan London aktif. Ambil untung & kelanjutan tren harian institusional.',
    };
  }
  // Asian Session: 00:00 - 06:00 UTC
  if (timeInDec >= 0 && timeInDec < 6) {
    return {
      currentZone: 'Asian Session',
      isHighVolatilityTiming: false,
      description: 'Sesi konsolidasi Asia. Membentuk likuiditas buy-side & sell-side untuk sweep London.',
    };
  }

  return {
    currentZone: 'Off-Hours',
    isHighVolatilityTiming: false,
    description: 'Jendela transisi antar sesi trading institusional utama.',
  };
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
  style?: TradingStyle,
  startingPrior?: Partial<PriorWeights> | null
): AdaptiveStrategyEngineWeights {
  return deriveAdaptiveWeights(records, style, startingPrior);
}

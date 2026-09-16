export type OrderExecutionType =
  | 'BUY INSTANT'
  | 'SELL INSTANT'
  | 'BUY LIMIT'
  | 'SELL LIMIT'
  | 'BUY STOP'
  | 'SELL STOP'
  | 'BUY STOP LIMIT'
  | 'SELL STOP LIMIT';

export type TimeframeType = 'D1' | 'H4' | 'H1' | 'M15';

export type TradingStyle = 'Scalping' | 'Intraday' | 'Swing';

export type AccountType = 'Standard' | 'Cent' | 'Pro';

export type BrokerId = 'EXNESS' | 'HFM' | 'IC_MARKETS' | 'XM' | 'FBS' | 'OCTA' | 'MIFX';

export interface BrokerProfile {
  id: BrokerId;
  name: string;
  tagline: string;
  popularInIndonesia: boolean;
  regulation: string;
  spreadStandardPips: number;
  spreadProPips: number;
  spreadCentPips?: number;
  supportsCent: boolean;
  commissionProPerLot: number;
  description: string;
}

export const BROKER_PROFILES: Record<BrokerId, BrokerProfile> = {
  EXNESS: {
    id: 'EXNESS',
    name: 'Exness',
    tagline: 'Instant Automated Withdrawals & Raw Spreads',
    popularInIndonesia: true,
    regulation: 'FSA / CySEC / FCA',
    spreadStandardPips: 1.8,
    spreadProPips: 0.8,
    spreadCentPips: 2.4,
    supportsCent: true,
    commissionProPerLot: 3.5,
    description: 'Highly popular in Indonesia for fast QRIS/local bank transfers and ultra-tight Gold spreads.',
  },
  HFM: {
    id: 'HFM',
    name: 'HFM (HotForex)',
    tagline: 'Islamic Swap-Free & Multi-Tier Execution',
    popularInIndonesia: true,
    regulation: 'FSCA / CySEC / DFSA',
    spreadStandardPips: 2.0,
    spreadProPips: 1.2,
    spreadCentPips: 2.6,
    supportsCent: true,
    commissionProPerLot: 0.0,
    description: 'Widely favored by Indonesian gold traders for swap-free Islamic accounts and competitive pro pricing.',
  },
  IC_MARKETS: {
    id: 'IC_MARKETS',
    name: 'IC Markets',
    tagline: 'True Raw ECN & High Liquidity Provider',
    popularInIndonesia: true,
    regulation: 'ASIC / CySEC / FSA',
    spreadStandardPips: 2.0,
    spreadProPips: 0.6,
    supportsCent: false,
    commissionProPerLot: 7.0,
    description: 'Premier institutional ECN broker with deep liquidity pools, best suited for high-frequency gold scalpers.',
  },
  XM: {
    id: 'XM',
    name: 'XM Global',
    tagline: 'Ultra Low Standard & Zero Requotes',
    popularInIndonesia: true,
    regulation: 'FSC / CySEC / ASIC',
    spreadStandardPips: 2.3,
    spreadProPips: 1.5,
    spreadCentPips: 2.5,
    supportsCent: true,
    commissionProPerLot: 0.0,
    description: 'Renowned for Ultra-Low accounts, negative balance protection, and zero execution requotes.',
  },
  FBS: {
    id: 'FBS',
    name: 'FBS',
    tagline: 'Flexible Micro & Cent Trading Accounts',
    popularInIndonesia: true,
    regulation: 'CySEC / ASIC / FSC',
    spreadStandardPips: 2.5,
    spreadProPips: 1.6,
    spreadCentPips: 2.8,
    supportsCent: true,
    commissionProPerLot: 0.0,
    description: 'Extensive Indonesian trader base with specialized Cent accounts for safe low-capital scaling.',
  },
  OCTA: {
    id: 'OCTA',
    name: 'Octa (OctaFX)',
    tagline: 'Zero Commission & Fixed Floating Spreads',
    popularInIndonesia: true,
    regulation: 'Mwali / CySEC',
    spreadStandardPips: 2.2,
    spreadProPips: 1.3,
    supportsCent: false,
    commissionProPerLot: 0.0,
    description: 'Long-standing reputation in Indonesia with zero overnight swap fees and transparent trading spreads.',
  },
  MIFX: {
    id: 'MIFX',
    name: 'MIFX (Monex Investindo)',
    tagline: 'Bappebti Licensed Domestic Indonesian Broker',
    popularInIndonesia: true,
    regulation: 'Bappebti / ICDX / JFX',
    spreadStandardPips: 2.8,
    spreadProPips: 1.8,
    supportsCent: false,
    commissionProPerLot: 1.0,
    description: 'Largest domestic Indonesian broker regulated directly by Bappebti with segregated domestic bank accounts.',
  },
};

export type SignalStatus = 'PENDING' | 'ACTIVE' | 'TP_HIT' | 'SL_HIT' | 'MISSED' | 'CANCELLED';

export interface ContractSpecification {
  contractSizeOz: number; // 100 for Standard & Pro, 1 for Cent
  typicalSpreadPips: number;
  commissionPerLot: number;
  lotUnit: string;
  accountCurrency: string;
  brokerId: BrokerId;
  brokerName: string;
  explanation: string;
}

export interface UserTradingProfile {
  id: string;
  email: string;
  displayName: string;
  photoURL?: string;
  lockedEquity: number;
  isEquityLocked: boolean;
  riskPercentage: number;
  tradingStyle?: TradingStyle;
  accountType?: AccountType;
  broker?: BrokerId;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  createdAt: string;
  updatedAt: string;
}

export interface ForexFactoryEvent {
  id: string;
  title: string;
  country: string;
  currency: 'USD' | 'EUR' | 'GBP' | 'JPY' | 'AUD' | 'CAD' | 'CHF' | 'CNY';
  impact: 'High' | 'Medium' | 'Low';
  time: string;
  date: string;
  scheduledTimestamp: string; // Exact ISO timestamp for live upcoming filter and local time display
  forecast: string;
  previous: string;
  actual?: string;
  marketImplication: string; // Institutional impact on Gold / Dollar
}

export interface TradingSessionInfo {
  id: 'tokyo' | 'london' | 'newyork' | 'overlap';
  name: string;
  region: string;
  city: string;
  utcOpen: number; // Hour in UTC
  utcClose: number; // Hour in UTC
  localOpenFormatted: string;
  localCloseFormatted: string;
  isActive: boolean;
  volatilityLevel: 'Low' | 'Moderate' | 'High' | 'Extreme';
  characteristics: string;
  progressPercentage: number;
  statusText: string;
}

export interface TradingCentralInsight {
  directionalBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  pivotPoint: number;
  preferredScenario: string;
  alternativeScenario: string;
  keySupportLevels: number[];
  keyResistanceLevels: number[];
  confidenceScore: number; // 0 - 100
}

export interface SmcStructure {
  timeframe: TimeframeType;
  trend: 'Bullish' | 'Bearish' | 'Ranging';
  bosLevel?: number;
  bosType?: 'Bullish BOS' | 'Bearish BOS';
  chochDetected: boolean;
  chochLevel?: number;
  orderBlock: {
    type: 'Bullish OB' | 'Bearish OB';
    high: number;
    low: number;
    mitigated: boolean;
    volumeConfirmation: boolean;
  };
  fairValueGap: {
    detected: boolean;
    type: 'Bullish FVG' | 'Bearish FVG';
    top: number;
    bottom: number;
    status: 'Open' | 'Partially Filled' | 'Mitigated';
  };
  liquidityPools: {
    pdh: number; // Previous Day High
    pdl: number; // Previous Day Low
    asiaHigh: number;
    asiaLow: number;
    swept: boolean;
    sweepDetail?: string;
  };
  pricingZone: 'Discount' | 'Equilibrium' | 'Premium';
}

export interface WyckoffVolumeAnalysis {
  phase: 'Accumulation' | 'Markup' | 'Distribution' | 'Markdown';
  pointOfControlPOC: number;
  volumeClimaxDetected: boolean;
  absorptionPresent: boolean;
  description: string;
}

export interface QuasimodoPattern {
  detected: boolean;
  type: 'Bullish QM' | 'Bearish QM';
  leftShoulder: number;
  headLiquiditySweep: number;
  breakLevel: number;
  optimalEntryZone: number;
}

export interface TechnicalIndicators {
  ema50: number;
  ema200: number;
  trendFromEma: 'Bullish' | 'Bearish' | 'Neutral';
  rsi14: number;
  rsiCondition: 'Oversold' | 'Overbought' | 'Neutral' | 'Bullish Divergence' | 'Bearish Divergence';
  stochasticK: number;
  stochasticD: number;
  stochasticSignal: 'Oversold Cross' | 'Overbought Cross' | 'Neutral';
  atr14: number; // Average True Range for SL buffer
}

export interface SelfLearningMemoryRecord {
  id: string;
  analysisId: string;
  timestamp: string;
  outcome: 'TP' | 'SL' | 'MISSED';
  symbol: string;
  orderType: OrderExecutionType;
  entryPrice: number;
  exitPrice: number;
  profitOrLossPips: number;
  profitOrLossDollars: number;
  rootCauseAnalysis: {
    primaryFactor: string;
    institutionalFlowExplanation: string;
    newsImpactSummary?: string;
    liquidityBehavior: string;
  };
  strategyEvolutionLesson: string;
  adaptiveWeightAdjustments: {
    fvgWeightDelta: number;
    orderBlockWeightDelta: number;
    newsFilterWeightDelta: number;
    atrBufferMultiplier: number;
  };
}

export type EngineProvider = 'gemini' | 'openai' | 'claude' | 'algorithmic';

export interface EngineGenerationMetadata {
  provider: EngineProvider;
  model: string;
  isFallback: boolean;
  switchReason?: string;
  timestamp: string;
}

export interface InstitutionalTradingSetup {
  id: string;
  userId: string;
  symbol: 'XAUUSD';
  timestamp: string;
  currentMarketPrice: number;
  bidPrice: number;
  askPrice: number;
  tradingStyle: TradingStyle;
  accountType: AccountType;
  broker?: BrokerId;
  brokerId?: BrokerId;
  contractSpecs: ContractSpecification;
  orderType: OrderExecutionType;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  riskRewardRatio: string;
  stopLossPips: number;
  recommendedLotSize: number;
  riskDollarAmount: number;
  riskPercentage: number;
  multiTimeframeAlignment: {
    d1: SmcStructure;
    h4: SmcStructure;
    h1: SmcStructure;
    m15: SmcStructure;
  };
  technicalIndicators: TechnicalIndicators;
  wyckoffVsa: WyckoffVolumeAnalysis;
  quasimodo: QuasimodoPattern;
  economicEvents: ForexFactoryEvent[];
  tradingCentralBias: TradingCentralInsight;
  killZoneStatus: {
    currentZone: 'London Open' | 'New York Open' | 'London Close' | 'Asian Session' | 'Off-Hours';
    isHighVolatilityTiming: boolean;
  };
  institutionalRationale: string;
  executionInstructionsMT5: string[];
  status: SignalStatus;
  closedPrice?: number;
  closedAt?: string;
  learningRecordId?: string;
  learningOutcome?: SelfLearningMemoryRecord;
  engineMetadata?: EngineGenerationMetadata;
}

export interface AdaptiveStrategyEngineWeights {
  orderBlockWeight: number; // e.g. 0.28
  fairValueGapWeight: number; // e.g. 0.24
  liquiditySweepWeight: number; // e.g. 0.20
  newsImpactWeight: number; // e.g. 0.15
  indicatorConfluenceWeight: number; // e.g. 0.13
  atrBufferFactor: number; // e.g. 1.25x ATR
  totalAnalysesLearned: number;
  historicalWinRate: number;
}

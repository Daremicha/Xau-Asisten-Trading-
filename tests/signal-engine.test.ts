import { describe, expect, test } from 'bun:test';
import type { Candle } from '../lib/candles';
import { buildSignal, resolveOrderType, STYLE_PROFILES, type SignalInputs } from '../lib/signal-engine';
import type {
  AdaptiveStrategyEngineWeights,
  SmcStructure,
  TechnicalIndicators,
  TimeframeType,
} from '../lib/types';

const PRICE = 4200;

const BASE_WEIGHTS: AdaptiveStrategyEngineWeights = {
  orderBlockWeight: 0.28,
  fairValueGapWeight: 0.24,
  liquiditySweepWeight: 0.22,
  newsImpactWeight: 0.14,
  indicatorConfluenceWeight: 0.12,
  atrBufferFactor: 1.25,
  totalAnalysesLearned: 0,
  historicalWinRate: 0,
};

function structure(timeframe: TimeframeType, trend: SmcStructure['trend'], bullish: boolean): SmcStructure {
  return {
    timeframe,
    trend,
    bosLevel: PRICE + (bullish ? -5 : 5),
    bosType: bullish ? 'Bullish BOS' : 'Bearish BOS',
    chochDetected: false,
    orderBlock: {
      type: bullish ? 'Bullish OB' : 'Bearish OB',
      high: bullish ? PRICE - 8 : PRICE + 12,
      low: bullish ? PRICE - 14 : PRICE + 8,
      mitigated: false,
      volumeConfirmation: true,
    },
    fairValueGap: {
      detected: true,
      type: bullish ? 'Bullish FVG' : 'Bearish FVG',
      top: bullish ? PRICE - 2 : PRICE + 8,
      bottom: bullish ? PRICE - 6 : PRICE + 4,
      status: 'Open',
    },
    liquidityPools: {
      pdh: PRICE + 20,
      pdl: PRICE - 25,
      asiaHigh: PRICE + 10,
      asiaLow: PRICE - 16,
      swept: true,
      sweepDetail: bullish ? 'Previous Day Low taken.' : 'Previous Day High taken.',
    },
    pricingZone: bullish ? 'Discount' : 'Premium',
  };
}

const INDICATORS: TechnicalIndicators = {
  ema50: PRICE - 4,
  ema200: PRICE - 14,
  trendFromEma: 'Bullish',
  rsi14: 58,
  rsiCondition: 'Neutral',
  stochasticK: 18,
  stochasticD: 22,
  stochasticSignal: 'Oversold Cross',
  atr14: 8,
};

const CANDLES: Candle[] = Array.from({ length: 60 }, (_, i) => ({
  time: i * 900_000,
  open: PRICE - 20 + i * 0.3,
  high: PRICE - 19 + i * 0.3,
  low: PRICE - 21 + i * 0.3,
  close: PRICE - 20 + i * 0.3,
  volume: 100,
}));

function inputs(overrides: Partial<SignalInputs> = {}): SignalInputs {
  const bullish = true;
  return {
    price: PRICE,
    structures: {
      d1: structure('D1', 'Bullish', bullish),
      h4: structure('H4', 'Bullish', bullish),
      h1: structure('H1', 'Bullish', bullish),
      m15: structure('M15', 'Bullish', bullish),
    },
    indicators: INDICATORS,
    weights: BASE_WEIGHTS,
    tradingStyle: 'Intraday',
    candles: CANDLES,
    killZoneActive: true,
    upcomingHighImpactEvents: [],
    minutesToNextEvent: null,
    ...overrides,
  };
}

function bearishInputs(): SignalInputs {
  return inputs({
    structures: {
      d1: structure('D1', 'Bearish', false),
      h4: structure('H4', 'Bearish', false),
      h1: structure('H1', 'Bearish', false),
      m15: structure('M15', 'Bearish', false),
    },
    indicators: { ...INDICATORS, trendFromEma: 'Bearish', rsi14: 38, stochasticSignal: 'Overbought Cross' },
  });
}

describe('direction', () => {
  test('bullish structure across timeframes produces a long', () => {
    expect(buildSignal(inputs()).direction).toBe('long');
  });

  test('bearish structure produces a short, not a hardcoded long', () => {
    expect(buildSignal(bearishInputs()).direction).toBe('short');
  });
});

describe('learned ATR buffer changes the stop', () => {
  test('a larger buffer widens the stop distance', () => {
    const tight = buildSignal(inputs({ weights: { ...BASE_WEIGHTS, atrBufferFactor: 1.0 } }));
    const wide = buildSignal(inputs({ weights: { ...BASE_WEIGHTS, atrBufferFactor: 2.0 } }));

    const tightRisk = Math.abs(tight.entryPrice - tight.stopLoss);
    const wideRisk = Math.abs(wide.entryPrice - wide.stopLoss);
    expect(wideRisk).toBeGreaterThan(tightRisk);
  });

  test('the widened stop is reflected in the reported pip distance', () => {
    const tight = buildSignal(inputs({ weights: { ...BASE_WEIGHTS, atrBufferFactor: 1.0 } }));
    const wide = buildSignal(inputs({ weights: { ...BASE_WEIGHTS, atrBufferFactor: 2.0 } }));
    expect(wide.stopLossPips).toBeGreaterThan(tight.stopLossPips);
  });
});

describe('learned point of interest preference changes the entry', () => {
  test('favouring imbalances anchors the entry to the fair value gap', () => {
    const decision = buildSignal(
      inputs({ weights: { ...BASE_WEIGHTS, fairValueGapWeight: 0.4, orderBlockWeight: 0.1 } })
    );
    expect(decision.anchor).toBe('Fair Value Gap');
    // 50 percent of the gap between 4194 and 4198.
    expect(decision.entryPrice).toBeCloseTo(4196, 2);
  });

  test('favouring order blocks anchors the entry to the block instead', () => {
    const decision = buildSignal(
      inputs({ weights: { ...BASE_WEIGHTS, fairValueGapWeight: 0.1, orderBlockWeight: 0.4 } })
    );
    expect(decision.anchor).toBe('Order Block');
    // Mean threshold of the block between 4186 and 4192.
    expect(decision.entryPrice).toBeCloseTo(4189, 2);
  });

  test('the two preferences genuinely produce different orders', () => {
    const fvg = buildSignal(inputs({ weights: { ...BASE_WEIGHTS, fairValueGapWeight: 0.4, orderBlockWeight: 0.1 } }));
    const ob = buildSignal(inputs({ weights: { ...BASE_WEIGHTS, fairValueGapWeight: 0.1, orderBlockWeight: 0.4 } }));
    expect(fvg.entryPrice).not.toBe(ob.entryPrice);
  });
});

describe('news weighting', () => {
  test('an imminent release widens the stop', () => {
    const calm = buildSignal(inputs({ minutesToNextEvent: null }));
    const imminent = buildSignal(inputs({ minutesToNextEvent: 20 }));
    expect(Math.abs(imminent.entryPrice - imminent.stopLoss)).toBeGreaterThan(
      Math.abs(calm.entryPrice - calm.stopLoss)
    );
  });

  test('a heavier news weight widens it further still', () => {
    const light = buildSignal(inputs({ minutesToNextEvent: 20, weights: { ...BASE_WEIGHTS, newsImpactWeight: 0.05 } }));
    const heavy = buildSignal(inputs({ minutesToNextEvent: 20, weights: { ...BASE_WEIGHTS, newsImpactWeight: 0.3 } }));
    expect(Math.abs(heavy.entryPrice - heavy.stopLoss)).toBeGreaterThan(
      Math.abs(light.entryPrice - light.stopLoss)
    );
  });
});

describe('order type is always executable in MetaTrader', () => {
  test('a buy below market is a limit, above market is a stop', () => {
    expect(resolveOrderType('long', 4190, 4200, 1.2)).toBe('BUY LIMIT');
    expect(resolveOrderType('long', 4210, 4200, 1.2)).toBe('BUY STOP');
  });

  test('a sell above market is a limit, below market is a stop', () => {
    expect(resolveOrderType('short', 4210, 4200, 1.2)).toBe('SELL LIMIT');
    expect(resolveOrderType('short', 4190, 4200, 1.2)).toBe('SELL STOP');
  });

  test('an entry at market becomes an instant order', () => {
    expect(resolveOrderType('long', 4200.4, 4200, 1.2)).toBe('BUY INSTANT');
    expect(resolveOrderType('short', 4199.6, 4200, 1.2)).toBe('SELL INSTANT');
  });

  test('a generated buy limit never sits above live price', () => {
    for (const style of ['Scalping', 'Intraday', 'Swing'] as const) {
      const d = buildSignal(inputs({ tradingStyle: style }));
      if (d.orderType === 'BUY LIMIT') expect(d.entryPrice).toBeLessThan(PRICE);
      if (d.orderType === 'BUY STOP') expect(d.entryPrice).toBeGreaterThan(PRICE);
      if (d.orderType === 'SELL LIMIT') expect(d.entryPrice).toBeGreaterThan(PRICE);
      if (d.orderType === 'SELL STOP') expect(d.entryPrice).toBeLessThan(PRICE);
    }
  });
});

describe('order geometry is always valid', () => {
  const cases: Array<[string, SignalInputs]> = [
    ['bullish intraday', inputs()],
    ['bearish intraday', bearishInputs()],
    ['bullish scalping', inputs({ tradingStyle: 'Scalping' })],
    ['bearish swing', { ...bearishInputs(), tradingStyle: 'Swing' as const }],
  ];

  for (const [name, input] of cases) {
    test(`${name}: stop and targets sit on the correct side of entry`, () => {
      const d = buildSignal(input);
      if (d.direction === 'long') {
        expect(d.stopLoss).toBeLessThan(d.entryPrice);
        expect(d.takeProfit1).toBeGreaterThan(d.entryPrice);
        expect(d.takeProfit2).toBeGreaterThan(d.takeProfit1);
        expect(d.takeProfit3).toBeGreaterThan(d.takeProfit2);
      } else {
        expect(d.stopLoss).toBeGreaterThan(d.entryPrice);
        expect(d.takeProfit1).toBeLessThan(d.entryPrice);
        expect(d.takeProfit2).toBeLessThan(d.takeProfit1);
        expect(d.takeProfit3).toBeLessThan(d.takeProfit2);
      }
    });
  }

  test('the stop always clears the style minimum', () => {
    for (const style of ['Scalping', 'Intraday', 'Swing'] as const) {
      const d = buildSignal(inputs({ tradingStyle: style }));
      expect(Math.abs(d.entryPrice - d.stopLoss)).toBeGreaterThanOrEqual(
        STYLE_PROFILES[style].minStopDollars - 0.01
      );
    }
  });

  test('scalping risks less than swing on the same market', () => {
    const scalp = buildSignal(inputs({ tradingStyle: 'Scalping' }));
    const swing = buildSignal(inputs({ tradingStyle: 'Swing' }));
    expect(Math.abs(scalp.entryPrice - scalp.stopLoss)).toBeLessThan(
      Math.abs(swing.entryPrice - swing.stopLoss)
    );
  });

  test('confidence stays inside nought to one hundred', () => {
    const d = buildSignal(inputs());
    expect(d.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(d.confidenceScore).toBeLessThanOrEqual(100);
  });
});

describe('the learned buffer cannot escape the style', () => {
  test('a runaway buffer is capped at the style ceiling', () => {
    const runaway = buildSignal(
      inputs({ weights: { ...BASE_WEIGHTS, atrBufferFactor: 2.5 }, indicators: { ...INDICATORS, atr14: 40 } })
    );
    expect(Math.abs(runaway.entryPrice - runaway.stopLoss)).toBeLessThanOrEqual(
      STYLE_PROFILES.Intraday.maxStopDollars + 0.01
    );
    expect(runaway.stopWasCapped).toBe(true);
    expect(runaway.rationale).toContain('capped');
  });

  test('an intraday stop never reaches swing proportions', () => {
    for (const factor of [1.0, 1.5, 2.0, 2.5]) {
      const d = buildSignal(inputs({ weights: { ...BASE_WEIGHTS, atrBufferFactor: factor } }));
      expect(Math.abs(d.entryPrice - d.stopLoss)).toBeLessThanOrEqual(
        STYLE_PROFILES.Intraday.maxStopDollars + 0.01
      );
    }
  });

  test('a normal buffer is not flagged as capped', () => {
    expect(buildSignal(inputs()).stopWasCapped).toBe(false);
  });

  test('targets stay ordered even when the stop is capped', () => {
    const d = buildSignal(
      inputs({ weights: { ...BASE_WEIGHTS, atrBufferFactor: 2.5 }, indicators: { ...INDICATORS, atr14: 40 } })
    );
    expect(d.takeProfit1).toBeGreaterThan(d.entryPrice);
    expect(d.takeProfit3).toBeGreaterThan(d.takeProfit2);
  });
});

describe('the style ceiling is absolute', () => {
  test('news proximity cannot push the stop past the style maximum', () => {
    const d = buildSignal(
      inputs({
        minutesToNextEvent: 5,
        weights: { ...BASE_WEIGHTS, atrBufferFactor: 2.5, newsImpactWeight: 0.3 },
        indicators: { ...INDICATORS, atr14: 40 },
      })
    );
    expect(Math.abs(d.entryPrice - d.stopLoss)).toBeLessThanOrEqual(
      STYLE_PROFILES.Intraday.maxStopDollars + 0.01
    );
  });

  test('the worst case across every style still respects its own ceiling', () => {
    for (const style of ['Scalping', 'Intraday', 'Swing'] as const) {
      const d = buildSignal(
        inputs({
          tradingStyle: style,
          minutesToNextEvent: 1,
          weights: { ...BASE_WEIGHTS, atrBufferFactor: 2.5, newsImpactWeight: 0.3 },
          indicators: { ...INDICATORS, atr14: 60 },
        })
      );
      expect(Math.abs(d.entryPrice - d.stopLoss)).toBeLessThanOrEqual(
        STYLE_PROFILES[style].maxStopDollars + 0.01
      );
      // Geometry must survive the clamp.
      if (d.direction === 'long') expect(d.takeProfit1).toBeGreaterThan(d.entryPrice);
      else expect(d.takeProfit1).toBeLessThan(d.entryPrice);
    }
  });
});

import { describe, expect, test } from 'bun:test';
import type { Candle } from '../lib/candles';
import {
  buildSignal,
  maxEntryDistance,
  resolveOrderType,
  scoreConfluence,
  STYLE_PROFILES,
  type SignalInputs,
} from '../lib/signal-engine';
import { calculateXAUUSDLotSize } from '../lib/market-engine';
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
  emaFastPeriod: 50,
  emaSlowPeriod: 200,
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

describe('the entry must be reachable, not merely correct', () => {
  /**
   * Places a bullish FVG whose midpoint sits a chosen distance below price,
   * like a rally that ran away from its own imbalance. halfWidth stays small
   * enough that the whole gap remains below price.
   */
  function withFvgAt(
    distanceBelow: number,
    style: 'Scalping' | 'Intraday' | 'Swing' = 'Intraday',
    halfWidth = Math.min(1.5, distanceBelow / 3)
  ) {
    const far = structure('H1', 'Bullish', true);
    far.fairValueGap = {
      detected: true,
      type: 'Bullish FVG',
      top: PRICE - distanceBelow + halfWidth,
      bottom: PRICE - distanceBelow - halfWidth,
      status: 'Open',
    };
    // Push the order block out of the way so the gap is the only candidate.
    far.orderBlock = { ...far.orderBlock, high: PRICE + 50, low: PRICE + 40 };
    return inputs({
      tradingStyle: style,
      structures: {
        d1: structure('D1', 'Bullish', true),
        h4: structure('H4', 'Bullish', true),
        h1: far,
        m15: structure('M15', 'Bullish', true),
      },
    });
  }

  test('a level far below price is not silently used as an intraday entry', () => {
    // The reported case: market 4338, the H1 imbalance midpoint at 4306, an
    // order 315 pips away that would not fill inside the session.
    const d = buildSignal(withFvgAt(31.5, 'Intraday', 11.5));
    expect(d.entryOutOfReach).toBe(true);
    expect(d.rationale).toContain('may not fill');
  });

  test('when nothing is in reach it still picks the closest level available', () => {
    // Gap spans PRICE-43 to PRICE-20. Its midpoint is 31.5 away, its near edge
    // only 20, so the near edge is what gets quoted.
    const d = buildSignal(withFvgAt(31.5, 'Intraday', 11.5));
    expect(d.entryPrice).toBeCloseTo(PRICE - 20, 2);
    expect(d.entryDistancePips).toBeCloseTo(200, 0);
  });

  test('when the midpoint is out of reach the near edge is used instead', () => {
    // Gap from PRICE-14 to PRICE-2: midpoint is 8 away, near edge only 2.
    const near = structure('H1', 'Bullish', true);
    near.fairValueGap = { detected: true, type: 'Bullish FVG', top: PRICE - 2, bottom: PRICE - 14, status: 'Open' };
    near.orderBlock = { ...near.orderBlock, high: PRICE + 50, low: PRICE + 40 };
    const d = buildSignal(
      inputs({
        tradingStyle: 'Scalping',
        structures: {
          d1: structure('D1', 'Bullish', true),
          h4: structure('H4', 'Bullish', true),
          h1: near,
          m15: structure('M15', 'Bullish', true),
        },
      })
    );
    expect(d.entryOutOfReach).toBe(false);
    expect(d.entryPrice).toBeCloseTo(PRICE - 2, 2);
    expect(d.rationale).toContain('near edge');
  });

  test('a swing trade tolerates a distance an intraday trade rejects', () => {
    expect(buildSignal(withFvgAt(22, 'Intraday')).entryOutOfReach).toBe(true);
    expect(buildSignal(withFvgAt(22, 'Swing')).entryOutOfReach).toBe(false);
  });

  test('a scalp rejects a distance an intraday trade accepts', () => {
    // At ATR 8 the scalp reach is 6.40 and the intraday reach is 12.00, so a
    // level 9 dollars away separates the two styles.
    expect(buildSignal(withFvgAt(9, 'Scalping')).entryOutOfReach).toBe(true);
    expect(buildSignal(withFvgAt(9, 'Intraday')).entryOutOfReach).toBe(false);
  });

  test('reach scales with volatility, so a quiet market is not over-restricted', () => {
    const calm = maxEntryDistance(STYLE_PROFILES.Intraday, 2);
    const wild = maxEntryDistance(STYLE_PROFILES.Intraday, 30);
    expect(wild).toBeGreaterThan(calm);
    // The floor keeps a very quiet market tradeable.
    expect(calm).toBe(STYLE_PROFILES.Intraday.minEntryReachDollars);
  });

  test('an unreachable entry is reported with less conviction', () => {
    const reachable = buildSignal(withFvgAt(6));
    const unreachable = buildSignal(withFvgAt(31.5));
    expect(unreachable.confidenceScore).toBeLessThan(reachable.confidenceScore);
  });

  test('the distance to the entry is always reported', () => {
    const d = buildSignal(withFvgAt(9, 'Swing'));
    expect(d.entryDistancePips).toBeCloseTo(90, 0);
  });

  test('a normal setup is not flagged', () => {
    const d = buildSignal(inputs());
    expect(d.entryOutOfReach).toBe(false);
    expect(d.rationale).not.toContain('may not fill');
  });

  test('order geometry survives an out of reach entry', () => {
    const d = buildSignal(withFvgAt(31.5));
    expect(d.stopLoss).toBeLessThan(d.entryPrice);
    expect(d.takeProfit1).toBeGreaterThan(d.entryPrice);
    expect(d.takeProfit3).toBeGreaterThan(d.takeProfit2);
  });
});

describe('the learned entry buffer moves entries closer', () => {
  test('a buffer learned from missed orders shifts the entry toward price', () => {
    const without = buildSignal(inputs());
    const withBuffer = buildSignal(
      inputs({ weights: { ...BASE_WEIGHTS, entryBufferPips: 30 } })
    );
    expect(withBuffer.entryDistancePips).toBeLessThan(without.entryDistancePips);
  });

  test('a bigger buffer moves it further', () => {
    const small = buildSignal(inputs({ weights: { ...BASE_WEIGHTS, entryBufferPips: 10 } }));
    const large = buildSignal(inputs({ weights: { ...BASE_WEIGHTS, entryBufferPips: 40 } }));
    expect(large.entryDistancePips).toBeLessThan(small.entryDistancePips);
  });

  test('the buffer can never push a long entry above live price', () => {
    for (const pips of [50, 200, 5000]) {
      const d = buildSignal(inputs({ weights: { ...BASE_WEIGHTS, entryBufferPips: pips } }));
      expect(d.entryPrice).toBeLessThanOrEqual(PRICE);
      expect(d.stopLoss).toBeLessThan(d.entryPrice);
      expect(d.takeProfit1).toBeGreaterThan(d.entryPrice);
    }
  });

  test('the buffer can never push a short entry below live price', () => {
    const d = buildSignal({ ...bearishInputs(), weights: { ...BASE_WEIGHTS, entryBufferPips: 5000 } });
    expect(d.entryPrice).toBeGreaterThanOrEqual(PRICE);
    expect(d.stopLoss).toBeGreaterThan(d.entryPrice);
  });

  test('no buffer leaves the entry exactly where the level sits', () => {
    expect(buildSignal(inputs({ weights: { ...BASE_WEIGHTS, entryBufferPips: 0 } })).entryPrice).toBe(
      buildSignal(inputs()).entryPrice
    );
  });
});

describe('lot sizing reports the risk actually taken', () => {
  test('a normal account risks what the budget allows', () => {
    const calc = calculateXAUUSDLotSize(5000, 1, 4200, 4190, 'Standard', 'Intraday', 'EXNESS');
    expect(calc.exceedsRiskBudget).toBe(false);
    expect(calc.actualRiskDollars).toBeLessThanOrEqual(calc.riskDollars);
  });

  test('a balance too small for the minimum lot is flagged, not glossed over', () => {
    // The reported screen: $10 cent account, 1% budget, a 180 pip stop. The
    // minimum 0.01 lot risks $0.18, which is 1.8%, not the 1% displayed.
    const calc = calculateXAUUSDLotSize(10, 1, 4200, 4182, 'Cent', 'Intraday', 'EXNESS');
    expect(calc.lotSize).toBe(0.01);
    expect(calc.riskDollars).toBeCloseTo(0.1, 2);
    expect(calc.actualRiskDollars).toBeCloseTo(0.18, 2);
    expect(calc.exceedsRiskBudget).toBe(true);
  });

  test('the actual risk always matches lot times stop distance', () => {
    for (const account of ['Standard', 'Cent', 'Pro'] as const) {
      const calc = calculateXAUUSDLotSize(5000, 2, 4200, 4185, account, 'Intraday', 'EXNESS');
      const perLot = account === 'Cent' ? 15 : 15 * 100 + calc.contractSpecs.commissionPerLot;
      expect(calc.actualRiskDollars).toBeCloseTo(calc.lotSize * perLot, 1);
    }
  });

  test('a zero balance is handled without dividing by zero', () => {
    const calc = calculateXAUUSDLotSize(0, 1, 4200, 4190, 'Standard', 'Intraday', 'EXNESS');
    expect(calc.actualRiskDollars).toBe(0);
    expect(calc.exceedsRiskBudget).toBe(false);
  });
});

describe('EMA structure and RSI genuinely steer the signal', () => {
  /** Reads a named confluence factor out of a decision. */
  const factor = (d: ReturnType<typeof buildSignal>, name: string) =>
    d.factors.find((f) => f.name === name)!;

  test('EMA 50 is no longer ignored: the stack is read, not just EMA 200', () => {
    const stacked = buildSignal(inputs({ indicators: { ...INDICATORS, ema50: PRICE - 4, ema200: PRICE - 14 } }));
    const pullback = buildSignal(inputs({ indicators: { ...INDICATORS, ema50: PRICE + 4, ema200: PRICE - 14 } }));
    // Same EMA 200 relationship, different EMA 50, so the vote must differ.
    expect(factor(stacked, 'EMA structure').direction).not.toBe(
      factor(pullback, 'EMA structure').direction
    );
  });

  test('a fully stacked uptrend votes strongly long', () => {
    const d = buildSignal(inputs({ indicators: { ...INDICATORS, ema50: PRICE - 4, ema200: PRICE - 14 } }));
    expect(factor(d, 'EMA structure').direction).toBe(1);
    expect(factor(d, 'EMA structure').detail).toContain('stacked uptrend');
  });

  test('a fully stacked downtrend votes strongly short', () => {
    const d = buildSignal(inputs({ indicators: { ...INDICATORS, ema50: PRICE + 4, ema200: PRICE + 14 } }));
    expect(factor(d, 'EMA structure').direction).toBe(-1);
  });

  test('a pullback inside an uptrend is recognised as a retracement, not a reversal', () => {
    const d = buildSignal(inputs({ indicators: { ...INDICATORS, ema50: PRICE + 2, ema200: PRICE - 14 } }));
    const v = factor(d, 'EMA structure');
    expect(v.direction).toBeGreaterThan(0);
    expect(v.direction).toBeLessThan(1);
    expect(v.detail).toContain('retracement inside an uptrend');
  });

  test('an overbought RSI argues against buying, not for it', () => {
    const d = buildSignal(inputs({ indicators: { ...INDICATORS, rsi14: 78 } }));
    expect(factor(d, 'RSI').direction).toBeLessThan(0);
    expect(factor(d, 'RSI').detail).toContain('overbought');
  });

  test('an oversold RSI argues against selling', () => {
    const d = buildSignal(inputs({ indicators: { ...INDICATORS, rsi14: 22 } }));
    expect(factor(d, 'RSI').direction).toBeGreaterThan(0);
  });

  test('RSI between the extremes is graded, not a single threshold', () => {
    const mild = buildSignal(inputs({ indicators: { ...INDICATORS, rsi14: 55 } }));
    const strong = buildSignal(inputs({ indicators: { ...INDICATORS, rsi14: 65 } }));
    expect(factor(strong, 'RSI').direction).toBeGreaterThan(factor(mild, 'RSI').direction);
  });

  test('a divergence shifts the RSI vote', () => {
    const plain = buildSignal(inputs({ indicators: { ...INDICATORS, rsi14: 50, rsiCondition: 'Neutral' } }));
    const diverging = buildSignal(
      inputs({ indicators: { ...INDICATORS, rsi14: 50, rsiCondition: 'Bullish Divergence' } })
    );
    expect(factor(diverging, 'RSI').direction).toBeGreaterThan(factor(plain, 'RSI').direction);
  });

  test('all three indicator readings are reported separately to the user', () => {
    const d = buildSignal(inputs());
    for (const name of ['EMA structure', 'RSI', 'Stochastic']) {
      expect(d.factors.some((f) => f.name === name)).toBe(true);
    }
  });
});

describe('an entry price has already left behind', () => {
  /**
   * The failure from the screen recording. The order block sits far under a
   * market that has run, so the entry is further away than the stop the trade
   * would carry — and the app's own rule records such an order as a missed
   * entry the moment it is placed.
   */
  function stranded(): SignalInputs {
    const far = (timeframe: TimeframeType): SmcStructure => {
      const base = structure(timeframe, 'Bullish', true);
      return {
        ...base,
        orderBlock: { ...base.orderBlock, high: PRICE - 28, low: PRICE - 36 },
        fairValueGap: { ...base.fairValueGap, top: PRICE - 30, bottom: PRICE - 34 },
        liquidityPools: { ...base.liquidityPools, asiaLow: PRICE - 40 },
      };
    };
    return inputs({
      structures: { d1: far('D1'), h4: far('H4'), h1: far('H1'), m15: far('M15') },
      // A fast market, so the volatility reach alone would have allowed it.
      indicators: { ...INDICATORS, atr14: 20 },
    });
  }

  test('the engine refuses it rather than issuing an order that dies at once', () => {
    const decision = buildSignal(stranded());
    expect(decision.entryUnfillable).toBe(true);
    expect(decision.unfillableReason).toContain('missed entry the moment it was placed');
  });

  test('a reachable level is still offered normally', () => {
    const decision = buildSignal(inputs());
    expect(decision.entryUnfillable).toBe(false);
    expect(decision.unfillableReason).toBe('');
  });

  test('reach can never exceed the widest stop the style permits', () => {
    for (const style of ['Scalping', 'Intraday', 'Swing'] as const) {
      const profile = STYLE_PROFILES[style];
      // A very volatile market, where the volatility reach alone would run past
      // the stop ceiling and produce orders that cannot survive being placed.
      expect(maxEntryDistance(profile, 200)).toBeLessThanOrEqual(profile.maxStopDollars);
    }
  });
});

describe('the risk budget keeps cent precision', () => {
  test('a budget smaller than a whole cent is not rounded to one', () => {
    // A 901 cent balance at half a percent is 4.5 cent. Two decimals of a
    // dollar rounds that to 5, so the number on screen disagreed with the
    // percentage that produced it.
    const calc = calculateXAUUSDLotSize(9.01, 0.5, 4300, 4290, 'Cent', 'Intraday', 'EXNESS');
    // Four decimals of a dollar is two decimals of a cent: 4.50 cent, not 5.
    expect(calc.riskDollars).toBeCloseTo(0.045, 6);
    expect(calc.riskDollars).not.toBe(0.05);
  });

  test('what the lot actually risks is reported at the same precision', () => {
    const calc = calculateXAUUSDLotSize(9.01, 0.5, 4300, 4290.45, 'Cent', 'Intraday', 'EXNESS');
    // The minimum lot of 0.01 over a 9.55 dollar stop risks 9.55 cent.
    expect(calc.actualRiskDollars).toBeCloseTo(0.0955, 6);
    expect(calc.exceedsRiskBudget).toBe(true);
  });
});

describe('the main trend, and how honestly it is counted', () => {
  test('a real daily read carries the heaviest weight in the score', () => {
    const { factors } = scoreConfluence(inputs());
    const htf = factors.find((f) => f.name === 'Higher timeframe order flow');
    expect(htf).toBeDefined();
    // Every other factor is a learned weight, none above 0.3.
    const others = factors.filter((f) => f.name !== 'Higher timeframe order flow');
    expect(htf!.weight).toBe(1);
    for (const factor of others) expect(factor.weight).toBeLessThan(htf!.weight);
    expect(htf!.detail).toContain('D1 Bullish');
  });

  test('a borrowed daily read is not counted as a second opinion', () => {
    // When no daily series is available the D1 slot holds the same H4 candles.
    // Counting both at full strength would let one read vote twice with the
    // heaviest weight on the table.
    const borrowed = inputs({
      structures: {
        d1: { ...structure('D1', 'Bullish', true), derivedFrom: 'H4' as const },
        h4: structure('H4', 'Bullish', true),
        h1: structure('H1', 'Bullish', true),
        m15: structure('M15', 'Bullish', true),
      },
    });
    const htf = scoreConfluence(borrowed).factors.find((f) => f.name === 'Higher timeframe order flow')!;
    const honest = scoreConfluence(inputs()).factors.find(
      (f) => f.name === 'Higher timeframe order flow'
    )!;
    // Same direction, and no larger than the genuine two-timeframe agreement.
    expect(htf.direction).toBeLessThanOrEqual(honest.direction);
    expect(htf.detail).toContain('not counted twice');
  });

  test('the averages are named by the period they were actually computed over', () => {
    const short = inputs({
      indicators: { ...INDICATORS, emaFastPeriod: 50, emaSlowPeriod: 125 },
    });
    const ema = scoreConfluence(short).factors.find((f) => f.name.includes('EMA'))!;
    expect(ema.detail).toContain('EMA 125');
    expect(ema.detail).not.toContain('EMA 200');
  });
});

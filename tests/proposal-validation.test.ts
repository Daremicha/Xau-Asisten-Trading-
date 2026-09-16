import { describe, expect, test } from 'bun:test';
import {
  parseProposal,
  structuralLevels,
  validateProposal,
  type ProposalContext,
  type ProposedOrder,
} from '../lib/proposal-validation';
import type { SmcStructure, TechnicalIndicators, TimeframeType } from '../lib/types';

const PRICE = 4200;

function structure(timeframe: TimeframeType): SmcStructure {
  return {
    timeframe,
    trend: 'Bullish',
    bosLevel: PRICE - 5,
    bosType: 'Bullish BOS',
    chochDetected: false,
    orderBlock: { type: 'Bullish OB', high: PRICE - 8, low: PRICE - 14, mitigated: false, volumeConfirmation: true },
    fairValueGap: { detected: true, type: 'Bullish FVG', top: PRICE - 2, bottom: PRICE - 6, status: 'Open' },
    liquidityPools: { pdh: PRICE + 20, pdl: PRICE - 25, asiaHigh: PRICE + 10, asiaLow: PRICE - 16, swept: true },
    pricingZone: 'Discount',
  };
}

const INDICATORS: TechnicalIndicators = {
  ema50: PRICE - 4, ema200: PRICE - 14, trendFromEma: 'Bullish', rsi14: 58, rsiCondition: 'Neutral',
  stochasticK: 20, stochasticD: 25, stochasticSignal: 'Oversold Cross', atr14: 8,
};

const CTX: ProposalContext = {
  price: PRICE,
  indicators: INDICATORS,
  structures: { d1: structure('D1'), h4: structure('H4'), h1: structure('H1'), m15: structure('M15') },
  tradingStyle: 'Intraday',
};

/** A proposal anchored to the H1 order block mean, with sane geometry. */
const GOOD: ProposedOrder = {
  direction: 'long',
  entryPrice: PRICE - 11,
  stopLoss: PRICE - 19,
  takeProfit1: PRICE + 1,
  takeProfit2: PRICE + 9,
  takeProfit3: PRICE + 17,
  rationale: 'Long from the H1 order block mean threshold after the Asian low was swept.',
};

describe('a sound proposal is accepted', () => {
  test('it passes every rule', () => {
    const v = validateProposal(GOOD, CTX);
    expect(v.reasons).toEqual([]);
    expect(v.accepted).toBe(true);
  });

  test('it reports which level the entry was matched to', () => {
    expect(validateProposal(GOOD, CTX).anchoredTo).toBeTruthy();
  });
});

describe('geometry that would be rejected by a broker', () => {
  test('a long stop above the entry is caught', () => {
    const v = validateProposal({ ...GOOD, stopLoss: PRICE - 5 }, CTX);
    expect(v.accepted).toBe(false);
    expect(v.reasons.join(' ')).toContain('stop loss must sit below');
  });

  test('a long target below the entry is caught', () => {
    expect(validateProposal({ ...GOOD, takeProfit1: PRICE - 15 }, CTX).accepted).toBe(false);
  });

  test('targets out of order are caught', () => {
    const v = validateProposal({ ...GOOD, takeProfit3: PRICE + 2 }, CTX);
    expect(v.reasons.join(' ')).toContain('ascend');
  });

  test('the mirror rules apply to a short', () => {
    const short: ProposedOrder = {
      direction: 'short', entryPrice: PRICE + 10, stopLoss: PRICE + 2,
      takeProfit1: PRICE - 2, takeProfit2: PRICE - 10, takeProfit3: PRICE - 18,
      rationale: 'Short from the Asian high after a failed reclaim of the level.',
    };
    expect(validateProposal(short, CTX).reasons.join(' ')).toContain('stop loss must sit above');
  });
});

describe('risk that does not fit the chosen style', () => {
  test('a stop tighter than the style minimum is rejected', () => {
    const v = validateProposal({ ...GOOD, stopLoss: PRICE - 12 }, CTX);
    expect(v.reasons.join(' ')).toContain('tighter than');
  });

  test('a stop wider than the style ceiling is rejected', () => {
    const v = validateProposal({ ...GOOD, stopLoss: PRICE - 60, takeProfit1: PRICE + 60 }, CTX);
    expect(v.reasons.join(' ')).toContain('wider than');
  });

  test('a first target that does not pay for the risk is rejected', () => {
    const v = validateProposal({ ...GOOD, takeProfit1: PRICE - 9 }, CTX);
    expect(v.accepted).toBe(false);
  });
});

describe('an entry the market will never reach', () => {
  test('a level beyond the style reach is rejected', () => {
    const v = validateProposal({ ...GOOD, entryPrice: PRICE - 60, stopLoss: PRICE - 70, takeProfit1: PRICE - 40 }, CTX);
    expect(v.reasons.join(' ')).toContain('beyond the');
  });
});

describe('levels the model invented', () => {
  test('an entry matching no measured level is rejected', () => {
    // Geometrically valid and within reach, but anchored to nothing real.
    const v = validateProposal(
      { ...GOOD, entryPrice: PRICE - 10.5, stopLoss: PRICE - 19, takeProfit1: PRICE + 1 },
      { ...CTX, structures: {
        d1: { ...structure('D1'), orderBlock: { type: 'Bullish OB', high: PRICE - 30, low: PRICE - 34, mitigated: false, volumeConfirmation: true }, fairValueGap: { detected: false, type: 'Bullish FVG', top: PRICE, bottom: PRICE, status: 'Mitigated' }, liquidityPools: { pdh: PRICE + 40, pdl: PRICE - 40, asiaHigh: PRICE + 35, asiaLow: PRICE - 35, swept: false }, bosLevel: undefined },
        h4: { ...structure('H4'), orderBlock: { type: 'Bullish OB', high: PRICE - 30, low: PRICE - 34, mitigated: false, volumeConfirmation: true }, fairValueGap: { detected: false, type: 'Bullish FVG', top: PRICE, bottom: PRICE, status: 'Mitigated' }, liquidityPools: { pdh: PRICE + 40, pdl: PRICE - 40, asiaHigh: PRICE + 35, asiaLow: PRICE - 35, swept: false }, bosLevel: undefined },
        h1: { ...structure('H1'), orderBlock: { type: 'Bullish OB', high: PRICE - 30, low: PRICE - 34, mitigated: false, volumeConfirmation: true }, fairValueGap: { detected: false, type: 'Bullish FVG', top: PRICE, bottom: PRICE, status: 'Mitigated' }, liquidityPools: { pdh: PRICE + 40, pdl: PRICE - 40, asiaHigh: PRICE + 35, asiaLow: PRICE - 35, swept: false }, bosLevel: undefined },
        m15: { ...structure('M15'), orderBlock: { type: 'Bullish OB', high: PRICE - 30, low: PRICE - 34, mitigated: false, volumeConfirmation: true }, fairValueGap: { detected: false, type: 'Bullish FVG', top: PRICE, bottom: PRICE, status: 'Mitigated' }, liquidityPools: { pdh: PRICE + 40, pdl: PRICE - 40, asiaHigh: PRICE + 35, asiaLow: PRICE - 35, swept: false }, bosLevel: undefined },
      }, indicators: { ...INDICATORS, ema50: PRICE - 40, ema200: PRICE - 45 } }
    );
    expect(v.accepted).toBe(false);
    expect(v.reasons.join(' ')).toContain('matches no measured level');
  });

  test('a price far outside the sanity band is rejected', () => {
    const v = validateProposal({ ...GOOD, takeProfit3: 42000 }, CTX);
    expect(v.reasons.join(' ')).toContain('sanity band');
  });

  test('the level list covers every timeframe the engine measured', () => {
    const names = structuralLevels(CTX).map((l) => l.name);
    for (const tf of ['D1', 'H4', 'H1', 'M15']) {
      expect(names.some((n) => n.startsWith(tf))).toBe(true);
    }
    expect(names).toContain('EMA 200');
  });
});

describe('parsing what the model replied', () => {
  const valid = JSON.stringify({
    direction: 'long', entryPrice: 4189, stopLoss: 4181, takeProfit1: 4201,
    takeProfit2: 4209, takeProfit3: 4217,
    rationale: 'Long from the order block after the sweep of the Asian session low.',
  });

  test('a well formed reply parses', () => {
    const { proposal, reasons } = parseProposal(valid);
    expect(reasons).toEqual([]);
    expect(proposal!.direction).toBe('long');
  });

  test('text that is not JSON is reported, not thrown', () => {
    expect(parseProposal('I think you should buy gold').proposal).toBeNull();
  });

  test('a missing price is reported by name', () => {
    const { proposal, reasons } = parseProposal(JSON.stringify({ direction: 'long', rationale: 'a'.repeat(30) }));
    expect(proposal).toBeNull();
    expect(reasons.join(' ')).toContain('entryPrice');
  });

  test('a price sent as a string is rejected rather than coerced', () => {
    const body = JSON.parse(valid);
    body.entryPrice = '4189';
    expect(parseProposal(JSON.stringify(body)).proposal).toBeNull();
  });

  test('a direction outside long or short is rejected', () => {
    const body = JSON.parse(valid);
    body.direction = 'maybe';
    expect(parseProposal(JSON.stringify(body)).reasons.join(' ')).toContain('long');
  });

  test('a proposal with no reasoning is rejected', () => {
    const body = JSON.parse(valid);
    body.rationale = 'buy';
    expect(parseProposal(JSON.stringify(body)).proposal).toBeNull();
  });
});

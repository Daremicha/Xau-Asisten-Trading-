import { describe, expect, test } from 'bun:test';
import {
  createBacktest,
  runBacktest,
  simulateOrder,
  type BacktestConfig,
  type OrderPlan,
} from '../lib/backtest-engine';
import type { Candle } from '../lib/candles';

const M15 = 15 * 60_000;
const START = Date.UTC(2024, 0, 1);

function bar(index: number, open: number, high: number, low: number, close: number): Candle {
  return { time: START + index * M15, open, high, low, close, volume: 1000 };
}

function plan(overrides: Partial<OrderPlan> = {}): OrderPlan {
  return {
    direction: 'long',
    instant: false,
    entryPrice: 2000,
    stopLoss: 1990,
    takeProfit1: 2015,
    decidedAt: 0,
    expiresAt: START + 8 * 60 * 60_000,
    maxHoldMs: 3 * 24 * 60 * 60_000,
    ...overrides,
  };
}

describe('order simulation', () => {
  test('a resting order fills when a bar trades through its price', () => {
    const candles = [
      bar(0, 2010, 2012, 2008, 2010),
      bar(1, 2010, 2011, 1999, 2002), // touches 2000
      bar(2, 2002, 2016, 2001, 2015), // reaches the target
    ];
    const result = simulateOrder(candles, plan());
    expect(result.kind).toBe('filled');
    if (result.kind !== 'filled') return;
    expect(result.fillIndex).toBe(1);
    expect(result.fillPrice).toBe(2000);
    expect(result.outcome).toBe('TP');
    expect(result.exitPrice).toBe(2015);
  });

  test('a resting order that is never reached expires', () => {
    const candles = [
      bar(0, 2010, 2012, 2008, 2010),
      // Hours of drift that never touch the 2000 entry and never run a full
      // stop distance past it either, so only the clock can end this order.
      ...Array.from({ length: 40 }, (_, i) => bar(i + 1, 2006, 2008, 2003, 2006)),
    ];
    const result = simulateOrder(candles, plan());
    expect(result.kind).toBe('missed');
    if (result.kind !== 'missed') return;
    expect(result.reason).toContain('expired');
  });

  test('an order is dead once price trades through its invalidation without it', () => {
    const candles = [
      bar(0, 2006, 2008, 2004, 2006),
      bar(1, 2006, 2007, 2003, 2004),
      // A weekend gap: the whole bar prints below the stop, so the resting
      // order at 2000 was never touched on the way down.
      bar(2, 1975, 1978, 1970, 1972),
    ];
    const result = simulateOrder(candles, plan());
    expect(result.kind).toBe('missed');
    if (result.kind !== 'missed') return;
    expect(result.reason).toContain('invalidation');
  });

  test('an order is dead once the move happens without it', () => {
    const candles = [
      bar(0, 2006, 2008, 2004, 2006),
      // A full stop distance past the 2000 entry, which was never touched.
      bar(1, 2006, 2016, 2005, 2015),
    ];
    const result = simulateOrder(candles, plan());
    expect(result.kind).toBe('missed');
    if (result.kind !== 'missed') return;
    expect(result.reason).toContain('full stop distance');
  });

  test('a bar holding both the stop and the target is recorded as a stop', () => {
    const candles = [
      bar(0, 2010, 2012, 2008, 2010),
      bar(1, 2005, 2016, 1985, 2010), // contains entry, stop and target at once
    ];
    const result = simulateOrder(candles, plan());
    expect(result.kind).toBe('filled');
    if (result.kind !== 'filled') return;
    // The intrabar path is unknown, so the losing side is assumed first.
    expect(result.outcome).toBe('SL');
    expect(result.exitPrice).toBe(1990);
  });

  test('a market order opens at the close of its own bar and is not judged by it', () => {
    const candles = [
      // This bar dipped below the stop before the close the order opened at.
      bar(0, 2010, 2012, 1985, 2005),
      bar(1, 2005, 2016, 2004, 2015),
    ];
    const result = simulateOrder(candles, plan({ instant: true, entryPrice: 2005 }));
    expect(result.kind).toBe('filled');
    if (result.kind !== 'filled') return;
    expect(result.fillPrice).toBe(2005);
    expect(result.outcome).toBe('TP');
  });

  test('a position still open when the data ends is not a result', () => {
    const candles = [bar(0, 2010, 2012, 2008, 2010), bar(1, 2010, 2011, 1999, 2002)];
    const result = simulateOrder(candles, plan());
    expect(result.kind).toBe('unresolved');
  });

  test('the holding limit closes at market, with the sign of the move', () => {
    const candles = [
      bar(0, 2010, 2012, 2008, 2010),
      bar(1, 2010, 2011, 1999, 2002),
      // Drifts sideways above the fill for longer than the holding limit.
      ...Array.from({ length: 30 }, (_, i) => bar(i + 2, 2003, 2004, 2001, 2003)),
    ];
    const result = simulateOrder(candles, plan({ maxHoldMs: 2 * 60 * 60_000 }));
    expect(result.kind).toBe('filled');
    if (result.kind !== 'filled') return;
    expect(result.reason).toContain('holding limit');
    expect(result.outcome).toBe('TP'); // closed above the fill
    expect(result.exitPrice).toBe(2003);
  });

  test('a short order mirrors every rule', () => {
    const candles = [
      bar(0, 2000, 2002, 1998, 2000),
      bar(1, 2000, 2006, 1999, 2004), // fills the sell limit at 2005? no: high 2006 covers it
      bar(2, 2004, 2005, 1984, 1985),
    ];
    const result = simulateOrder(
      candles,
      plan({ direction: 'short', entryPrice: 2005, stopLoss: 2015, takeProfit1: 1990 })
    );
    expect(result.kind).toBe('filled');
    if (result.kind !== 'filled') return;
    expect(result.fillIndex).toBe(1);
    expect(result.outcome).toBe('TP');
    expect(result.exitPrice).toBe(1990);
  });
});

/** Deterministic walk, so every assertion below is reproducible. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function walk(count: number, seed = 11): Candle[] {
  const rnd = mulberry32(seed);
  const candles: Candle[] = [];
  let price = 2050;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + (rnd() - 0.5) * 2.4;
    const wick = rnd() * 1.6;
    candles.push({
      time: START + i * M15,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      volume: 900,
    });
    price = close;
  }
  return candles;
}

function config(candles: Candle[], overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    candles,
    intervalMs: M15,
    tradingStyle: 'Intraday',
    accountType: 'Standard',
    brokerId: 'EXNESS',
    startingEquity: 5000,
    riskPercentage: 1,
    adaptive: false,
    ...overrides,
  };
}

describe('replay', () => {
  const candles = walk(6000);
  const result = runBacktest(config(candles, { warmupBars: 1400 }));

  test('the run produces trades from real candles', () => {
    expect(result.trades.length).toBeGreaterThan(5);
    expect(result.summary.bars).toBe(candles.length);
  });

  test('trades never overlap', () => {
    for (let i = 1; i < result.trades.length; i++) {
      expect(result.trades[i].openedAt).toBeGreaterThanOrEqual(result.trades[i - 1].closedAt);
    }
  });

  test('every trade closes at or after it opened', () => {
    for (const trade of result.trades) {
      expect(trade.closedAt).toBeGreaterThanOrEqual(trade.openedAt);
    }
  });

  test('an order that never filled moved no money', () => {
    const missed = result.trades.filter((t) => !t.filled);
    expect(missed.length).toBeGreaterThan(0);
    for (const trade of missed) {
      expect(trade.outcome).toBe('MISSED');
      expect(trade.netDollars).toBe(0);
      expect(trade.pips).toBe(0);
    }
  });

  test('a filled trade is labelled by what it actually earned', () => {
    const filled = result.trades.filter((t) => t.filled);
    expect(filled.length).toBeGreaterThan(0);
    for (const trade of filled) {
      expect(trade.outcome).toBe(trade.netDollars > 0 ? 'TP' : 'SL');
      // Spread is always charged, so the net can never beat the gross.
      expect(trade.netDollars).toBeLessThanOrEqual(trade.grossDollars);
      expect(trade.costDollars).toBeGreaterThan(0);
    }
  });

  test('equity is the running sum of the results', () => {
    // Four decimals, matching what the engine keeps: two would be a whole unit
    // on a cent account and the sum would drift away from the ledger.
    let equity = 5000;
    for (const trade of result.trades) {
      equity = parseFloat((equity + trade.netDollars).toFixed(4));
      expect(trade.equityAfter).toBeCloseTo(equity, 4);
    }
  });

  test('the control run never changes its weights', () => {
    expect(result.finalWeights.entryBufferPips).toBe(0);
    expect(result.finalWeights.atrBufferFactor).toBe(1.25);
  });

  test('the adaptive run records everything the engine learns from', () => {
    const adaptive = runBacktest(config(candles, { adaptive: true, warmupBars: 1400 }));
    expect(adaptive.records.length).toBe(adaptive.trades.length);

    // Conditions, not just outcomes: a replay has to exercise the same
    // conditional learning the live app does, or the lab is testing a reduced
    // version of the engine.
    for (const entry of adaptive.records) {
      expect(entry.context).toBeDefined();
      expect(['Order Block', 'Fair Value Gap', 'Market']).toContain(entry.context!.anchor);
      expect(entry.context!.convictionScore).toBeGreaterThanOrEqual(0);
      expect(typeof entry.context!.killZoneActive).toBe('boolean');
    }
  });

  test('no decision can see a candle that had not printed yet', () => {
    // Re-running over a series truncated just after the first trade closed must
    // produce the identical first trade. If the analysis were reading ahead, the
    // missing future would change it.
    const first = result.trades[0];
    const cutoff = candles.findIndex((c) => c.time === first.closedAt);
    expect(cutoff).toBeGreaterThan(0);

    const truncated = runBacktest(config(candles.slice(0, cutoff + 1), { warmupBars: 1400 }));
    expect(truncated.trades.length).toBeGreaterThan(0);
    const replayed = truncated.trades[0];
    expect(replayed.openedAt).toBe(first.openedAt);
    expect(replayed.entryPrice).toBe(first.entryPrice);
    expect(replayed.stopLoss).toBe(first.stopLoss);
    expect(replayed.takeProfit1).toBe(first.takeProfit1);
    expect(replayed.outcome).toBe(first.outcome);
    expect(replayed.netDollars).toBe(first.netDollars);
  });

  test('stepping in slices gives the same answer as running it in one go', () => {
    const run = createBacktest(config(candles, { warmupBars: 1400 }));
    let guard = 0;
    while (!run.progress().done && guard < 10_000) {
      run.step(3);
      guard += 1;
    }
    const sliced = run.result();
    expect(sliced.trades.length).toBe(result.trades.length);
    expect(sliced.trades.at(-1)?.equityAfter).toBe(result.trades.at(-1)?.equityAfter);
  });

  test('a series too short to read structure produces nothing rather than guesses', () => {
    // Below the candles the structural read needs, so there is nothing to
    // analyse rather than a thin read presented as one.
    const shortRun = runBacktest(config(walk(30)));
    expect(shortRun.trades).toHaveLength(0);
  });

  test('a blown account stops the run instead of trading a negative balance', () => {
    const broke = runBacktest(config(candles, { startingEquity: 1, riskPercentage: 3, warmupBars: 1400 }));
    for (const trade of broke.trades) {
      expect(trade.equityAfter).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('a conviction floor', () => {
  const candles = walk(6000);

  test('refusing weak setups leaves only the strong ones', () => {
    // A shorter series: closer targets resolve trades faster, so a replay makes
    // several times as many decisions as it used to for the same candles.
    const slice = candles.slice(0, 3200);
    const all = runBacktest(config(slice, { warmupBars: 1400 }));
    const picky = runBacktest(config(slice, { warmupBars: 1400, minConviction: 60 }));

    expect(picky.trades.length).toBeLessThan(all.trades.length);
    for (const trade of picky.trades) {
      expect(trade.convictionScore).toBeGreaterThanOrEqual(60);
    }
    expect(picky.summary.minConviction).toBe(60);
    expect(picky.summary.belowConviction).toBeGreaterThan(0);
  });

  test('a floor of zero changes nothing', () => {
    const open = runBacktest(config(candles, { warmupBars: 1400, minConviction: 0 }));
    const none = runBacktest(config(candles, { warmupBars: 1400 }));
    expect(open.trades.length).toBe(none.trades.length);
    expect(open.summary.belowConviction).toBe(0);
  });

  test('a floor nothing can reach produces no trades rather than an error', () => {
    // A short series: rejecting every setup means re-analysing every cooldown
    // for the whole run, which is the slowest path the engine has.
    const impossible = runBacktest(config(walk(2200), { warmupBars: 1400, minConviction: 100 }));
    expect(impossible.trades).toHaveLength(0);
    expect(impossible.summary.belowConviction).toBeGreaterThan(0);
  });

  test('every trade records the conviction it was taken on', () => {
    const run = runBacktest(config(candles, { warmupBars: 1400 }));
    for (const trade of run.trades) {
      expect(trade.convictionScore).toBeGreaterThanOrEqual(0);
      expect(trade.convictionScore).toBeLessThanOrEqual(100);
    }
  });
});

describe('replaying with parameters already adopted', () => {
  const candles = walk(6000);

  test('a run started from a prior uses it instead of the engine defaults', () => {
    const frozen = runBacktest(
      config(candles, {
        warmupBars: 1400,
        startingPrior: { atrBufferFactor: 2.2, entryBufferPips: 30 },
      })
    );
    expect(frozen.finalWeights.atrBufferFactor).toBe(2.2);
    expect(frozen.finalWeights.entryBufferPips).toBe(30);
  });

  test('a wider stop prior actually changes the trades, not just the report', () => {
    const defaults = runBacktest(config(candles, { warmupBars: 1400 }));
    const wider = runBacktest(
      config(candles, { warmupBars: 1400, startingPrior: { atrBufferFactor: 2.5 } })
    );
    const sameStops = defaults.trades
      .slice(0, 5)
      .every((t, i) => wider.trades[i] && wider.trades[i].stopLoss === t.stopLoss);
    expect(sameStops).toBe(false);
  });

  test('an adaptive run starts from the prior and leaves it alone when nothing is wrong', () => {
    const fromPrior = runBacktest(
      config(candles, {
        warmupBars: 1400,
        adaptive: true,
        startingPrior: { atrBufferFactor: 1.0 },
      })
    );
    // The prior is the starting point, and a run that is winning gives the
    // engine no reason to move it. That the evidence can move it is covered
    // where the rule lives, in the learning engine's own tests.
    expect(fromPrior.finalWeights.atrBufferFactor).toBe(1.0);
    expect(fromPrior.trades.length).toBeGreaterThan(0);
  });
});

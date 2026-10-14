import { describe, expect, test } from 'bun:test';
import { getICTKillZoneStatus } from '../lib/market-engine';
import { ASIAN_SESSION_MIN_CONVICTION } from '../lib/session-rules';
import {
  createBacktest,
  runBacktest,
  simulateOrder,
  type BacktestConfig,
  type OrderPlan,
  DEFAULT_SLIPPAGE_DOLLARS,
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

describe('how far a resting order may run away before it is missed', () => {
  // Buy 2000, stop 1990: risk 10. Price rises 12 without filling, then dips into the entry.
  const candles = [
    bar(0, 2003, 2004, 2002, 2003),
    bar(1, 2003, 2012, 2002, 2011),
    bar(2, 2011, 2011, 1999, 2001),
    bar(3, 2001, 2016, 2000, 2016),
  ];

  test('one stop distance by default', () => {
    expect(simulateOrder(candles, plan()).kind).toBe('missed');
  });

  test('one and a half with the quick target, so the later fill is traded', () => {
    expect(simulateOrder(candles, plan({ missAtR: 1.5 })).kind).toBe('filled');
  });
});

describe('slippage and gaps', () => {
  const filled = (o: ReturnType<typeof simulateOrder>) => {
    if (o.kind !== 'filled') throw new Error(`expected a fill, got ${o.kind}`);
    return o;
  };

  test('a market entry fills against the trader by the slippage', () => {
    const candles = [bar(0, 2000, 2001, 1999, 2000), bar(1, 2000, 2016, 1999, 2015)];
    const long = filled(simulateOrder(candles, plan({ instant: true, slippageDollars: 0.2 })));
    expect(long.fillPrice).toBeCloseTo(2000.2, 6);
    const short = filled(
      simulateOrder([bar(0, 2000, 2001, 1999, 2000), bar(1, 2000, 2001, 1984, 1985)], plan({
        direction: 'short', instant: true, stopLoss: 2010, takeProfit1: 1985, slippageDollars: 0.2,
      }))
    );
    expect(short.fillPrice).toBeCloseTo(1999.8, 6);
  });

  test('a limit entry and its target fill at their own prices', () => {
    const candles = [bar(0, 2003, 2004, 2002, 2003), bar(1, 2002, 2003, 1999, 2001), bar(2, 2001, 2016, 2000, 2015)];
    const trade = filled(simulateOrder(candles, plan({ slippageDollars: 0.5 })));
    expect(trade.fillPrice).toBe(2000);
    expect(trade.outcome).toBe('TP');
    expect(trade.exitPrice).toBe(2015);
  });

  test('a stop fills past its level by the slippage', () => {
    const candles = [bar(0, 2003, 2004, 2002, 2003), bar(1, 2002, 2003, 1999, 2001), bar(2, 2000, 2001, 1989, 1990)];
    const trade = filled(simulateOrder(candles, plan({ slippageDollars: 0.2 })));
    expect(trade.outcome).toBe('SL');
    expect(trade.exitPrice).toBeCloseTo(1989.8, 6);
  });

  test('a stop gapped through at the open fills at that open, not at the level', () => {
    const candles = [bar(0, 2003, 2004, 2002, 2003), bar(1, 2002, 2003, 1999, 2001), bar(2, 1985, 1987, 1983, 1986)];
    const trade = filled(simulateOrder(candles, plan({ slippageDollars: 0.2 })));
    expect(trade.exitPrice).toBeCloseTo(1984.8, 6);
  });

  test('the bar a resting order fills on is not treated as a gap', () => {
    // Opens below the stop, trades up through the entry: the open came first.
    const candles = [bar(0, 2003, 2004, 2002, 2003), bar(1, 1988, 2001, 1987, 2000)];
    const trade = filled(simulateOrder(candles, plan({ slippageDollars: 0 })));
    expect(trade.exitPrice).toBe(1990);
  });

  test('the engine charges two pips by default', () => {
    expect(DEFAULT_SLIPPAGE_DOLLARS).toBe(0.2);
  });
});

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

  test('every record keeps how each factor voted, so factor trust can be learned from it', () => {
    // The live app records the same map; without it a two year replay could
    // not tell the engine which of its factors had been misleading it.
    expect(result.records.length).toBeGreaterThan(0);
    for (const record of result.records) {
      const votes = record.context?.factorVotes;
      expect(votes).toBeDefined();
      expect(Object.keys(votes!)).toContain('Higher timeframe order flow');
      for (const vote of Object.values(votes!)) expect(Number.isFinite(vote)).toBe(true);
    }
  });

  test('a filled trade\u2019s votes face the direction it was taken in', () => {
    // The higher timeframe carries weight one, so it decides most directions:
    // across the run it must agree with far more trades than it opposes.
    const htf = result.records
      .filter((r) => r.outcome !== 'MISSED')
      .map((r) => r.context!.factorVotes!['Higher timeframe order flow']);
    const agreed = htf.filter((v) => v > 0).length;
    const opposed = htf.filter((v) => v < 0).length;
    expect(agreed).toBeGreaterThan(opposed);
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

describe('the risk guard', () => {
  const candles = walk(3200);

  test('refuses every setup the smallest lot cannot size within the risk', () => {
    // Ten cent at one percent is a tenth of a cent; no stop fits that.
    const small = { accountType: 'Cent' as const, startingEquity: 0.1, riskPercentage: 1, warmupBars: 1400 };
    const guarded = runBacktest(config(candles, { ...small, riskGuard: true }));
    const open = runBacktest(config(candles, small));
    expect(open.trades.length).toBeGreaterThan(0);
    expect(guarded.trades).toHaveLength(0);
    expect(guarded.summary.riskCapSkips).toBeGreaterThan(0);
  });

  test('changes nothing on an account the budget can size', () => {
    const guarded = runBacktest(config(candles, { warmupBars: 1400, riskGuard: true }));
    const open = runBacktest(config(candles, { warmupBars: 1400 }));
    expect(guarded.trades.length).toBe(open.trades.length);
    expect(guarded.summary.riskCapSkips).toBe(0);
    for (const t of guarded.trades) expect(t.minimumLotForced).toBe(false);
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
    // The only setups a zero floor declines are the weak Asian-session ones.
    expect(open.summary.belowConviction).toBe(none.summary.belowConviction);
  });

  test('with no floor, a setup under 40 is only traded when the pivot bias agrees', () => {
    const run = runBacktest(config(candles, { warmupBars: 1400, minConviction: 0 }));
    const weak = run.records.filter((r) => r.context && r.context.convictionScore < 40);
    for (const r of weak) expect(r.context!.factorVotes!['Pivot and directional bias']).toBeGreaterThan(0.15);
  });

  test('even with no floor, no weak setup is traded in the Asian session', () => {
    // A series that trades in the Asian session at all, so the check has something to check.
    const run = runBacktest(config(walk(6000, 12), { warmupBars: 1400, minConviction: 0 }));
    const asian = run.trades.filter((t) => getICTKillZoneStatus(new Date(t.openedAt)).currentZone === 'Asian Session');
    expect(asian.length).toBeGreaterThan(0);
    expect(asian.every((t) => t.convictionScore >= ASIAN_SESSION_MIN_CONVICTION)).toBe(true);
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

describe('refusing one conviction band', () => {
  const candles = walk(4000);

  test('setups inside the band are never traded', () => {
    const all = runBacktest(config(candles, { warmupBars: 1400 }));
    const skipped = runBacktest(
      config(candles, { warmupBars: 1400, skipConvictionBand: { min: 40, max: 55 } })
    );
    expect(all.trades.some((t) => t.convictionScore >= 40 && t.convictionScore < 55)).toBe(true);
    expect(skipped.trades.some((t) => t.convictionScore >= 40 && t.convictionScore < 55)).toBe(false);
    // And the ones outside it are still taken, which is the point of a band
    // rather than a floor.
    expect(skipped.trades.some((t) => t.convictionScore < 40)).toBe(true);
  });

  test('a refused setup is counted, not silently dropped', () => {
    const skipped = runBacktest(
      config(candles, { warmupBars: 1400, skipConvictionBand: { min: 0, max: 101 } })
    );
    expect(skipped.trades.length).toBe(0);
    expect(skipped.summary.belowConviction).toBeGreaterThan(0);
  });
});

describe('moving the stop to entry once a trade has paid', () => {
  test('a trade that ran a full R and came back costs the spread, not the stop', () => {
    const candles = [
      bar(0, 2010, 2012, 2008, 2010),
      bar(1, 2004, 2004, 1999, 2002), // fills at 2000, still well short of 1R
      bar(2, 2002, 2010.5, 2001, 2010), // runs a full R in favour, so the stop moves up
      bar(3, 2010, 2011, 1989, 1990), // comes all the way back through the old stop
    ];
    const result = simulateOrder(candles, plan({ breakEvenAtR: 1 }));
    expect(result.kind).toBe('filled');
    if (result.kind !== 'filled') return;
    expect(result.exitPrice).toBe(2000);
    expect(result.protectedExit).toBe(true);
    expect(result.reason).toContain('moved there');
  });

  test('without the rule the same trade is a full stop out', () => {
    const candles = [
      bar(0, 2010, 2012, 2008, 2010),
      bar(1, 2004, 2004, 1999, 2002),
      bar(2, 2002, 2010.5, 2001, 2010),
      bar(3, 2010, 2011, 1989, 1990),
    ];
    const result = simulateOrder(candles, plan());
    expect(result.kind).toBe('filled');
    if (result.kind !== 'filled') return;
    expect(result.exitPrice).toBe(1990);
    expect(result.protectedExit).toBeFalsy();
  });

  test('a trade that never travels far enough keeps the stop it was given', () => {
    const candles = [
      bar(0, 2010, 2012, 2008, 2010),
      bar(1, 2004, 2004, 1999, 2002),
      bar(2, 2002, 2004, 2001, 2003), // only 0.4R in favour
      bar(3, 2003, 2004, 1989, 1990),
    ];
    const result = simulateOrder(candles, plan({ breakEvenAtR: 1 }));
    expect(result.kind).toBe('filled');
    if (result.kind !== 'filled') return;
    expect(result.exitPrice).toBe(1990);
    expect(result.protectedExit).toBeFalsy();
  });

  test('the bar that arms the stop cannot also be saved by it', () => {
    // High and low in one bar, and which came first is unknowable, so the
    // simulator takes the loss rather than assuming the favourable order.
    const candles = [
      bar(0, 2010, 2012, 2008, 2010),
      bar(1, 2004, 2004, 1999, 2002),
      bar(2, 2002, 2011, 1989, 1991),
    ];
    const result = simulateOrder(candles, plan({ breakEvenAtR: 1 }));
    expect(result.kind).toBe('filled');
    if (result.kind !== 'filled') return;
    expect(result.exitPrice).toBe(1990);
    expect(result.protectedExit).toBeFalsy();
  });

  test('a short trade is protected the same way', () => {
    const candles = [
      bar(0, 1990, 1992, 1988, 1990),
      bar(1, 1996, 2001, 1995, 1998), // fills the sell at 2000
      bar(2, 1998, 1999, 1989.5, 1990), // runs 1R in favour
      bar(3, 1990, 2002, 1990, 2001), // comes back through the entry
    ];
    const result = simulateOrder(
      candles,
      plan({ direction: 'short', entryPrice: 2000, stopLoss: 2010, takeProfit1: 1985, breakEvenAtR: 1 })
    );
    expect(result.kind).toBe('filled');
    if (result.kind !== 'filled') return;
    expect(result.exitPrice).toBe(2000);
    expect(result.protectedExit).toBe(true);
  });

  test('a protected run and the control trade the same setups', () => {
    // A series where some trade reaches 1R and then comes back, so the rule acts.
    const candles = walk(4000, 12);
    const control = runBacktest(config(candles, { warmupBars: 1400 }));
    const guarded = runBacktest(config(candles, { warmupBars: 1400, breakEvenAtR: 1 }));
    // The rule manages trades, it does not decide them: the first order of both
    // runs is the same order.
    expect(guarded.trades[0].entryPrice).toBe(control.trades[0].entryPrice);
    expect(guarded.trades[0].stopLoss).toBe(control.trades[0].stopLoss);
    // And it does change outcomes, or there would be nothing to measure.
    expect(guarded.trades.some((t) => t.protectedExit)).toBe(true);
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

  test('an adaptive run starts from the prior and drifts from it, not from the defaults', () => {
    const prior = { atrBufferFactor: 1.0 };
    const frozen = runBacktest(config(candles, { warmupBars: 1400, startingPrior: prior }));
    const fromPrior = runBacktest(config(candles, { warmupBars: 1400, adaptive: true, startingPrior: prior }));

    // The prior is where the run begins: before any evidence has accumulated
    // the two runs place the same order.
    expect(fromPrior.trades[0].stopLoss).toBe(frozen.trades[0].stopLoss);
    expect(fromPrior.trades.length).toBeGreaterThan(0);

    // On a random walk the engine is losing, so the stop rule is entitled to
    // widen. What it is not entitled to do is wander: the drift is bounded
    // against the prior it started from, never reset to the engine defaults.
    const drift = Math.abs(fromPrior.finalWeights.atrBufferFactor - prior.atrBufferFactor);
    expect(drift).toBeLessThanOrEqual(0.9);
  });
});

describe('news in a replay', () => {
  const candles = walk(3000, 12);
  const release = (at: number, currency: 'USD' | 'EUR' = 'USD') => ({
    id: `r-${at}-${currency}`,
    title: 'Release',
    country: currency,
    currency,
    impact: 'High' as const,
    date: '',
    time: '',
    scheduledTimestamp: new Date(at).toISOString(),
    forecast: '',
    previous: '',
    marketImplication: '',
  });
  // A dollar release every three hours through the whole series.
  const hourly = candles.filter((_, i) => i % 12 === 0).map((c) => release(c.time));

  test('decisions within an hour of a dollar release are recorded as near news', () => {
    const withNews = runBacktest(config(candles, { economicEvents: hourly }));
    expect(withNews.records.some((r) => r.context?.newsNearby)).toBe(true);
  });

  test('no calendar, or only foreign releases, means no news at all', () => {
    const none = runBacktest(config(candles));
    const foreign = runBacktest(config(candles, { economicEvents: hourly.map((e) => release(Date.parse(e.scheduledTimestamp), 'EUR')) }));
    expect(none.records.every((r) => !r.context?.newsNearby)).toBe(true);
    expect(foreign.records.every((r) => !r.context?.newsNearby)).toBe(true);
    expect(foreign.trades.map((t) => t.stopLoss)).toEqual(none.trades.map((t) => t.stopLoss));
  });
});

describe('the daily loss limit in a replay', () => {
  const candles = walk(3000, 12);

  test('a tight limit stops trading for the rest of the day, and trades less', () => {
    const free = runBacktest(config(candles));
    const limited = runBacktest(config(candles, { dailyLossLimitPercent: 0.5 }));
    expect(free.summary.dailyLimitSkips).toBe(0);
    expect(limited.summary.dailyLimitSkips).toBeGreaterThan(0);
    expect(limited.trades.length).toBeLessThan(free.trades.length);
  });
});

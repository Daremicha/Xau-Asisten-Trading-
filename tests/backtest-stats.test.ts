import { describe, expect, test } from 'bun:test';
import {
  assessAdoption,
  assessDeadBand,
  assessFloors,
  MIN_FLOOR_TRADES,
  assessProtection,
  assessRiskFloor,
  comparePhases,
  compareRuns,
  convictionBreakdown,
  netAboveThreshold,
  rollingWinRate,
  summariseTrades,
} from '../lib/backtest-stats';
import type { BacktestResult, BacktestTrade } from '../lib/backtest-engine';

function trade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    sequence: 1,
    openedAt: 0,
    closedAt: 3_600_000,
    orderType: 'BUY LIMIT',
    direction: 'long',
    entryPrice: 2000,
    fillPrice: 2000,
    stopLoss: 1990,
    takeProfit1: 2015,
    filled: true,
    outcome: 'TP',
    exitPrice: 2015,
    reason: 'The first target was reached.',
    lotSize: 0.1,
    grossDollars: 150,
    costDollars: 18,
    netDollars: 132,
    pips: 150,
    rMultiple: 1.3,
    equityAfter: 5132,
    confidenceScore: 60,
    convictionScore: 60,
    holdingHours: 1,
    riskBudgetDollars: 100,
    actualRiskDollars: 100,
    minimumLotForced: false,
    ...overrides,
  };
}

const win = (net: number) => trade({ outcome: 'TP', netDollars: net, rMultiple: net / 100 });
const loss = (net: number) => trade({ outcome: 'SL', netDollars: net, rMultiple: net / 100 });
const miss = () =>
  trade({ filled: false, outcome: 'MISSED', netDollars: 0, pips: 0, rMultiple: 0, costDollars: 0, grossDollars: 0 });

describe('trade statistics', () => {
  test('an empty run reports nothing rather than zero percent', () => {
    const stats = summariseTrades([], 5000);
    expect(stats.winRate).toBeNull();
    expect(stats.expectancyDollars).toBeNull();
    expect(stats.profitFactor).toBeNull();
    expect(stats.finalEquity).toBe(5000);
  });

  test('win rate counts filled trades only', () => {
    const stats = summariseTrades([win(100), loss(-50), miss(), miss()], 5000);
    expect(stats.totalSignals).toBe(4);
    expect(stats.filled).toBe(2);
    expect(stats.winRate).toBe(50);
    expect(stats.missRate).toBe(50);
  });

  test('profit factor is gross profit over gross loss', () => {
    const stats = summariseTrades([win(200), loss(-100), win(100), loss(-100)], 5000);
    expect(stats.profitFactor).toBe(1.5);
    expect(stats.netDollars).toBe(100);
    expect(stats.returnPercent).toBe(2);
    expect(stats.expectancyDollars).toBe(25);
  });

  test('drawdown is measured from the running peak', () => {
    const stats = summariseTrades([win(500), loss(-250), loss(-250), win(100)], 5000);
    // Peak 5500, trough 5000, so the worst drawdown is 500 of 5500.
    expect(stats.maxDrawdownPercent).toBe(9.1);
    expect(stats.worstLosingStreak).toBe(2);
  });

  test('a run with no losses has no profit factor to report', () => {
    const stats = summariseTrades([win(50), win(70)], 5000);
    expect(stats.profitFactor).toBeNull();
    expect(stats.wins).toBe(2);
  });
});

function result(trades: BacktestTrade[], startingEquity = 5000): BacktestResult {
  return {
    summary: {
      from: 0,
      to: 1,
      bars: 100,
      intervalMs: 900_000,
      tradingStyle: 'Intraday',
      accountType: 'Standard',
      brokerId: 'EXNESS',
      startingEquity,
      riskPercentage: 1,
      adaptive: true,
      skipped: 0,
      minConviction: 0,
      belowConviction: 0,
    },
    trades,
    equityCurve: [],
    finalWeights: {
      orderBlockWeight: 0.28,
      fairValueGapWeight: 0.24,
      liquiditySweepWeight: 0.22,
      newsImpactWeight: 0.14,
      indicatorConfluenceWeight: 0.12,
      atrBufferFactor: 1.25,
      totalAnalysesLearned: trades.length,
      historicalWinRate: 0,
    },
    records: [],
  };
}

describe('did the later trades go better', () => {
  test('a thin sample refuses to draw a conclusion', () => {
    const comparison = comparePhases(result([win(100), loss(-50), win(80), loss(-40)]));
    expect(comparison.verdict).toBe('insufficient');
    expect(comparison.explanation).toContain('Too few');
  });

  test('a better second half is reported as an improvement', () => {
    const early = Array.from({ length: 12 }, () => loss(-100));
    const late = Array.from({ length: 12 }, () => win(150));
    const comparison = comparePhases(result([...early, ...late]));
    expect(comparison.verdict).toBe('improved');
    expect(comparison.expectancyDelta).toBe(250);
    expect(comparison.winRateDelta).toBe(100);
  });

  test('a worse second half is not dressed up', () => {
    const early = Array.from({ length: 12 }, () => win(150));
    const late = Array.from({ length: 12 }, () => loss(-100));
    const comparison = comparePhases(result([...early, ...late]));
    expect(comparison.verdict).toBe('declined');
    expect(comparison.explanation).toContain('not the better ones');
  });
});

describe('learning against a control', () => {
  const control = result(Array.from({ length: 20 }, () => loss(-40)));

  test('an adaptive run that earned more is called better', () => {
    const adaptive = result(Array.from({ length: 20 }, () => win(60)));
    const comparison = compareRuns(control, adaptive);
    expect(comparison.verdict).toBe('better');
    expect(comparison.netDelta).toBe(2000);
    expect(comparison.winRateDelta).toBe(100);
  });

  test('an adaptive run that earned less is called worse', () => {
    const adaptive = result(Array.from({ length: 20 }, () => loss(-90)));
    const comparison = compareRuns(control, adaptive);
    expect(comparison.verdict).toBe('worse');
    expect(comparison.explanation).toContain('did not pay');
  });

  test('a difference smaller than a tenth of a percent is called noise', () => {
    const adaptive = result([...Array.from({ length: 19 }, () => loss(-40)), loss(-40.5)]);
    const comparison = compareRuns(control, adaptive);
    expect(comparison.verdict).toBe('same');
  });
});

describe('learning curve', () => {
  test('the rolling win rate follows the sequence', () => {
    const trades = [
      ...Array.from({ length: 5 }, () => loss(-50)),
      ...Array.from({ length: 5 }, () => win(50)),
    ].map((t, i) => ({ ...t, sequence: i + 1 }));

    const curve = rollingWinRate(trades, 5);
    expect(curve[0]).toEqual({ sequence: 5, winRate: 0 });
    expect(curve.at(-1)).toEqual({ sequence: 10, winRate: 100 });
  });

  test('a run shorter than the window produces no points rather than a fake one', () => {
    expect(rollingWinRate([win(10), loss(-10)], 20)).toHaveLength(0);
  });
});

describe('a cent account average that used to read zero', () => {
  test('an average under one cent is reported, not rounded away', () => {
    // The user's own run: 6.55 dollars over 1457 filled trades is 0.45 cent a
    // trade, which two decimal rounding turned into "+0.00 Cent" beside a net
    // of +655 Cent.
    const trades = Array.from({ length: 1457 }, (_, i) =>
      trade({ sequence: i + 1, netDollars: 6.55 / 1457, outcome: 'TP' })
    );
    const stats = summariseTrades(trades, 9.1);
    expect(stats.expectancyDollars).toBe(0.0045);
    expect(stats.netDollars).toBeCloseTo(6.55, 3);
  });
});

describe('which conviction bands actually paid', () => {
  const trades = [
    trade({ convictionScore: 30, netDollars: -50, outcome: 'SL' }),
    trade({ convictionScore: 35, netDollars: -70, outcome: 'SL' }),
    trade({ convictionScore: 45, netDollars: 20, outcome: 'TP' }),
    trade({ convictionScore: 60, netDollars: 90, outcome: 'TP' }),
    trade({ convictionScore: 75, netDollars: 120, outcome: 'TP' }),
    trade({ convictionScore: 80, filled: false, outcome: 'MISSED', netDollars: 0 }),
  ];

  test('each band reports only its own trades', () => {
    const buckets = convictionBreakdown(trades);
    expect(buckets.map((b) => b.signals)).toEqual([2, 1, 1, 2]);
    expect(buckets[0].netDollars).toBe(-120);
    expect(buckets[0].winRate).toBe(0);
    expect(buckets[3].filled).toBe(1);
    expect(buckets[3].winRate).toBe(100);
  });

  test('a band with no trades reports nothing rather than zero percent', () => {
    const buckets = convictionBreakdown([trade({ convictionScore: 80, netDollars: 10 })]);
    expect(buckets[0].signals).toBe(0);
    expect(buckets[0].winRate).toBeNull();
    expect(buckets[0].expectancyDollars).toBeNull();
  });

  test('a threshold drops everything below it', () => {
    // The losers sit under 40, so refusing them turns -120 into the rest.
    expect(netAboveThreshold(trades, 0)).toBe(110);
    expect(netAboveThreshold(trades, 40)).toBe(230);
    expect(netAboveThreshold(trades, 70)).toBe(120);
    expect(netAboveThreshold(trades, 101)).toBe(0);
  });

  test('an unfilled order contributes nothing at any threshold', () => {
    expect(netAboveThreshold([trades[5]], 0)).toBe(0);
  });
});

describe('whether the learned parameters are worth adopting', () => {
  /** A frozen run carrying parameters that differ from the defaults. */
  function frozenRun(trades: BacktestTrade[], startingEquity = 5000): BacktestResult {
    const run = result(trades, startingEquity);
    run.finalWeights = { ...run.finalWeights, atrBufferFactor: 1.9 };
    return run;
  }

  const control = result(Array.from({ length: 20 }, () => win(100)));

  test('parameters that are simply the defaults are nothing to adopt', () => {
    const frozen = result(Array.from({ length: 20 }, () => win(400)));
    // finalWeights left at the engine defaults, as a run that changed nothing.
    const verdict = assessAdoption(control, frozen);
    expect(verdict.worthAdopting).toBe(false);
    expect(verdict.reason).toContain('nothing here to adopt');
  });

  test('parameters that lost money are refused', () => {
    const verdict = assessAdoption(control, frozenRun(Array.from({ length: 20 }, () => win(40))));
    expect(verdict.worthAdopting).toBe(false);
    expect(verdict.reason).toContain('would have cost money');
  });

  test('a win too small to separate from luck is refused', () => {
    // Two percent better over one period is an accident, not an edge.
    const frozen = frozenRun([...Array.from({ length: 19 }, () => win(100)), win(140)]);
    const verdict = assessAdoption(control, frozen);
    expect(verdict.worthAdopting).toBe(false);
    expect(verdict.reason).toContain('too small a margin');
  });

  test('a win bought with a deeper drawdown is refused', () => {
    // Same money in the end, reached through a hole the control never dug.
    const frozen = frozenRun([loss(-900), ...Array.from({ length: 20 }, () => win(180))]);
    const verdict = assessAdoption(control, frozen);
    expect(verdict.drawdownDelta).toBeGreaterThan(0);
    expect(verdict.worthAdopting).toBe(false);
    expect(verdict.reason).toContain('deeper worst drawdown');
  });

  test('a clear win with no worse drawdown is what the button is for', () => {
    const frozen = frozenRun(Array.from({ length: 20 }, () => win(160)));
    const verdict = assessAdoption(control, frozen);
    expect(verdict.worthAdopting).toBe(true);
    expect(verdict.netDelta).toBe(1200);
    expect(verdict.reason).toContain('supports adopting them');
  });

  test('money in the verdict follows the account, not the dollar', () => {
    const centControl = result(Array.from({ length: 20 }, () => win(0.1)), 9.1);
    centControl.summary.accountType = 'Cent';
    const centFrozen = frozenRun(Array.from({ length: 20 }, () => win(0.3)), 9.1);
    centFrozen.summary.accountType = 'Cent';
    const verdict = assessAdoption(centControl, centFrozen);
    expect(verdict.reason).toContain('Cent');
    expect(verdict.reason).not.toContain('$');
  });
});

describe('whether moving the stop to entry is worth doing', () => {
  /** A trade that ended on a stop already moved to entry: the spread, not the stop. */
  const scratch = (net: number) => trade({ outcome: 'SL', netDollars: net, rMultiple: net / 100, protectedExit: true });

  const control = result([...Array.from({ length: 10 }, () => win(100)), ...Array.from({ length: 10 }, () => loss(-100))]);

  test('a period where no trade ever got far enough says so plainly', () => {
    const guarded = result(Array.from({ length: 20 }, () => win(100)));
    const verdict = assessProtection(control, guarded);
    expect(verdict.savedTrades).toBe(0);
    expect(verdict.worthUsing).toBe(false);
    expect(verdict.reason).toContain('would have changed nothing');
  });

  test('turning full losses into scratches for more money is what the button is for', () => {
    const guarded = result([
      ...Array.from({ length: 10 }, () => win(100)),
      ...Array.from({ length: 10 }, () => scratch(-5)),
    ]);
    const verdict = assessProtection(control, guarded);
    expect(verdict.savedTrades).toBe(10);
    expect(verdict.netDelta).toBe(950);
    expect(verdict.worthUsing).toBe(true);
    expect(verdict.reason).toContain('supports using it');
  });

  test('scratching trades that were on their way to the target is refused', () => {
    // The rule caught six losers and cut four winners off at nothing.
    const guarded = result([
      ...Array.from({ length: 6 }, () => win(100)),
      ...Array.from({ length: 4 }, () => scratch(-5)),
      ...Array.from({ length: 6 }, () => loss(-100)),
      ...Array.from({ length: 4 }, () => scratch(-5)),
    ]);
    const verdict = assessProtection(control, guarded);
    expect(verdict.netDelta).toBeLessThan(0);
    expect(verdict.worthUsing).toBe(false);
    expect(verdict.reason).toContain('cost');
  });

  test('a gain too small to separate from luck is refused', () => {
    const guarded = result([
      ...Array.from({ length: 10 }, () => win(100)),
      ...Array.from({ length: 9 }, () => loss(-100)),
      scratch(-97),
    ]);
    const verdict = assessProtection(control, guarded);
    expect(verdict.netDelta).toBeGreaterThan(0);
    expect(verdict.worthUsing).toBe(false);
    expect(verdict.reason).toContain('too small a margin');
  });

  test('the same money through a shallower hole passes', () => {
    // Identical net, but the losing stretch is scratches rather than stops.
    const rough = result([
      ...Array.from({ length: 6 }, () => loss(-100)),
      ...Array.from({ length: 10 }, () => win(100)),
      ...Array.from({ length: 4 }, () => loss(-100)),
    ]);
    const calm = result([
      ...Array.from({ length: 6 }, () => scratch(-20)),
      ...Array.from({ length: 10 }, () => win(20)),
      ...Array.from({ length: 4 }, () => scratch(-20)),
    ]);
    const verdict = assessProtection(rough, calm);
    expect(verdict.netDelta).toBeGreaterThanOrEqual(0);
    expect(verdict.drawdownDelta).toBeLessThanOrEqual(-1);
    expect(verdict.worthUsing).toBe(true);
    expect(verdict.reason).toContain('calmer ride');
  });

  test('money in the verdict follows the account, not the dollar', () => {
    const centControl = result(Array.from({ length: 10 }, () => loss(-0.5)), 9.1);
    centControl.summary.accountType = 'Cent';
    const centGuarded = result(Array.from({ length: 10 }, () => scratch(-0.02)), 9.1);
    centGuarded.summary.accountType = 'Cent';
    const verdict = assessProtection(centControl, centGuarded);
    expect(verdict.reason).toContain('Cent');
    expect(verdict.reason).not.toContain('$');
  });
});

describe('whether the risk setting was real', () => {
  test('a run where every lot fitted the budget says nothing', () => {
    const run = result(Array.from({ length: 10 }, () => win(100)));
    const report = assessRiskFloor(run);
    expect(report.forced).toBe(false);
    expect(report.message).toBe('');
  });

  test('a minimum lot above the budget is reported with the balance that would fix it', () => {
    // Asked for 0.5% of 9.01, which is about 4.5 cent; the smallest lot risked
    // 10 cent instead, so the setting was decorative.
    const run = result(
      Array.from({ length: 10 }, (_, i) =>
        trade({
          sequence: i + 1,
          outcome: 'SL',
          netDollars: -0.1,
          equityAfter: 9.01 - 0.1 * (i + 1),
          riskBudgetDollars: 0.045,
          actualRiskDollars: 0.1,
          minimumLotForced: true,
        })
      ),
      9.01
    );
    run.summary.riskPercentage = 0.5;
    run.summary.accountType = 'Cent';

    const report = assessRiskFloor(run);
    expect(report.forced).toBe(true);
    expect(report.forcedTrades).toBe(10);
    expect(report.actualPercent).toBeGreaterThan(1);
    // Ten cent of risk is half a percent of twenty dollars, which in cent terms
    // is what the balance would have to reach.
    expect(report.balanceNeeded).toBeCloseTo(20, 1);
    expect(report.message).toContain('Cent');
    expect(report.message).toContain('changing the risk percentage changes nothing');
  });

  test('unfilled orders are not counted, since nothing was risked', () => {
    const run = result([miss(), miss()]);
    expect(assessRiskFloor(run).forced).toBe(false);
    expect(assessRiskFloor(run).filledTrades).toBe(0);
  });
});

describe('whether one conviction band is worth refusing', () => {
  const HOUR = 3_600_000;
  /** A trade in a band, placed at a known point on the run's timeline. */
  const at = (hour: number, conviction: number, net: number) =>
    trade({
      sequence: hour,
      openedAt: hour * HOUR,
      closedAt: hour * HOUR + HOUR,
      convictionScore: conviction,
      outcome: net > 0 ? 'TP' : 'SL',
      netDollars: net,
      rMultiple: net / 100,
    });

  /** Winners spread across the whole period, so the run itself makes money. */
  const backbone = Array.from({ length: 120 }, (_, i) => at(i * 4, 20, 100));

  test('a band that loses in both halves, on enough trades, is refused', () => {
    const bad = Array.from({ length: 60 }, (_, i) => at(i * 8, 45, -60));
    const verdict = assessDeadBand(result([...backbone, ...bad]));
    expect(verdict.worthSkipping).toBe(true);
    expect(verdict.band?.min).toBe(40);
    expect(verdict.band?.max).toBe(55);
    expect(verdict.estimatedGain).toBe(3600);
    expect(verdict.reason).toContain('in the first half');
    expect(verdict.reason).toContain('in the second');
  });

  test('a band that only lost in one stretch is left alone', () => {
    // All the damage is in the first half; the second half paid it back.
    const early = Array.from({ length: 30 }, (_, i) => at(i * 2, 45, -200));
    const late = Array.from({ length: 30 }, (_, i) => at(300 + i * 2, 45, 100));
    const verdict = assessDeadBand(result([...backbone, ...early, ...late]));
    expect(verdict.worthSkipping).toBe(false);
    expect(verdict.reason).toContain('not consistently across both halves');
  });

  test('a losing band with too few trades is a bad stretch, not a rule', () => {
    const few = Array.from({ length: 12 }, (_, i) => at(i * 20, 45, -80));
    const verdict = assessDeadBand(result([...backbone, ...few]));
    expect(verdict.worthSkipping).toBe(false);
    expect(verdict.band).toBeNull();
  });

  test('a run where every band paid says there is nothing to refuse', () => {
    const verdict = assessDeadBand(result(backbone));
    expect(verdict.worthSkipping).toBe(false);
    expect(verdict.reason).toContain('nothing to refuse');
  });

  test('the halves are cut on the run, so each band is judged over the same market', () => {
    const buckets = convictionBreakdown([
      ...backbone,
      ...Array.from({ length: 40 }, (_, i) => at(i * 12, 45, -50)),
    ]);
    const band = buckets.find((b) => b.min === 40);
    expect(band?.firstHalfPerTrade).toBeLessThan(0);
    expect(band?.secondHalfPerTrade).toBeLessThan(0);
    expect(buckets[0].firstHalfPerTrade).toBeGreaterThan(0);
  });
});

describe('a conviction floor is judged on the risk it saves, not only the money it leaves', () => {
  const HOUR = 3_600_000;
  /** A trade at hour `at` with conviction `score` that made `net`. */
  const at = (hour: number, score: number, net: number) =>
    trade({ openedAt: hour * HOUR, closedAt: hour * HOUR + HOUR, convictionScore: score, netDollars: net, outcome: net > 0 ? 'TP' : 'SL' });

  /**
   * The shape of a real 24 month replay: the weak setups make money early,
   * give most of it back in one long slide, and end slightly up; the strong
   * ones pay steadily through both halves.
   */
  function period(strongCount = 60, strongSpread: 'both' | 'first' = 'both') {
    const out: BacktestTrade[] = [];
    for (let i = 0; i < 100; i++) out.push(at(i * 2, 30, 5));
    for (let i = 0; i < 60; i++) out.push(at(200 + i * 2, 30, -8));
    for (let i = 0; i < 40; i++) out.push(at(320 + i * 2, 30, 5));
    // The halves are cut by trade count, so 'first' keeps them inside the first quarter.
    const span = strongSpread === 'both' ? 400 : 100;
    for (let i = 0; i < strongCount; i++) out.push(at(1 + Math.floor((i * span) / strongCount), 75, 4));
    return out.sort((a, b) => a.openedAt - b.openedAt);
  }

  test('a floor that earns less but falls far less is the one recommended', () => {
    const verdict = assessFloors(period(), 1000, [0, 70], 'Cent');
    const [all, strong] = verdict.floors;
    // Taking everything left more money...
    expect(all.netDollars).toBeGreaterThan(strong.netDollars);
    // ...and took a far deeper fall to get it.
    expect(all.maxDrawdownPercent).toBeGreaterThan(strong.maxDrawdownPercent * 5);
    expect(verdict.recommended).toBe(70);
    expect(verdict.reason).toContain('made money in both halves');
  });

  test('the drawdown is measured on the trades the floor keeps', () => {
    const verdict = assessFloors(period(), 1000, [0, 70], 'Cent');
    // Sixty steady winners never fall from a high.
    expect(verdict.floors[1].maxDrawdownPercent).toBe(0);
    expect(verdict.floors[1].trades).toBe(60);
  });

  test('a floor with too few trades to judge is never recommended', () => {
    const verdict = assessFloors(period(MIN_FLOOR_TRADES - 1), 1000, [0, 70], 'Cent');
    expect(verdict.floors[1].trades).toBe(MIN_FLOOR_TRADES - 1);
    expect(verdict.recommended).toBe(0);
  });

  test('a floor that only made money in one half is a stretch of luck, not a rule', () => {
    const verdict = assessFloors(period(60, 'first'), 1000, [0, 70], 'Cent');
    expect(verdict.floors[1].consistent).toBe(false);
    expect(verdict.recommended).toBe(0);
  });

  test('when taking everything was already smooth, no floor is worth the signals it refuses', () => {
    const steady = Array.from({ length: 200 }, (_, i) => at(i, i % 2 ? 30 : 75, 5));
    const verdict = assessFloors(steady, 1000, [0, 70], 'Cent');
    expect(verdict.recommended).toBe(0);
    expect(verdict.reason).toContain('a floor would not have helped');
  });

  test('when nothing made money in both halves, it says so rather than naming a winner', () => {
    const decaying = [
      ...Array.from({ length: 100 }, (_, i) => at(i, i % 2 ? 30 : 75, 5)),
      ...Array.from({ length: 100 }, (_, i) => at(100 + i, i % 2 ? 30 : 75, -6)),
    ];
    const verdict = assessFloors(decaying, 1000, [0, 70], 'Cent');
    expect(verdict.recommended).toBe(0);
    expect(verdict.reason).toContain('No floor made money in both halves');
  });
});

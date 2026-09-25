import { describe, expect, test } from 'bun:test';
import { replayOrder, resolveClose, resolveMiss } from '../lib/order-replay';
import type { Candle } from '../lib/candles';

const M15 = 15 * 60_000;
const START = Date.UTC(2026, 8, 17, 12, 0, 0);

function bar(index: number, high: number, low: number, close = (high + low) / 2): Candle {
  return { time: START + index * M15, open: (high + low) / 2, high, low, close, volume: 100 };
}

/** A resting buy: entry 4300, stop 4290 (risk 10), targets 4315 / 4325 / 4340. */
function buyLimit(overrides: Record<string, unknown> = {}) {
  return {
    orderType: 'BUY LIMIT',
    entryPrice: 4300,
    stopLoss: 4290,
    takeProfit1: 4315,
    takeProfit2: 4325,
    takeProfit3: 4340,
    timestamp: new Date(START).toISOString(),
    validUntil: new Date(START + 100 * M15).toISOString(),
    ...overrides,
  } as never;
}

function sellLimit(overrides: Record<string, unknown> = {}) {
  return {
    orderType: 'SELL LIMIT',
    entryPrice: 4300,
    stopLoss: 4310,
    takeProfit1: 4285,
    takeProfit2: 4275,
    takeProfit3: 4260,
    timestamp: new Date(START).toISOString(),
    validUntil: new Date(START + 100 * M15).toISOString(),
    ...overrides,
  } as never;
}

describe('the trade that filled and won while the tab was closed', () => {
  test('is a win, not the missed entry a single tick makes it look like', () => {
    const candles = [
      bar(0, 4306, 4302), // above the entry, nothing yet
      bar(1, 4303, 4298), // dips through 4300: filled
      bar(2, 4312, 4301),
      bar(3, 4318, 4310), // reaches TP1 at 4315
      bar(4, 4313, 4308), // drifts back down
      bar(5, 4312, 4309), // where the user finds it in the morning: 4311
    ];
    const verdict = replayOrder(buyLimit(), candles, START + 6 * M15);
    expect(verdict.kind).toBe('closed');
    if (verdict.kind !== 'closed') throw new Error('expected a close');
    expect(verdict.trigger).toBe('TP1');
    expect(verdict.level).toBe(1);
    expect(verdict.exitPrice).toBe(4315);
  });

  test('the same path read from the last tick alone is what produced the false miss', () => {
    // 4311 is a full stop distance past a 4300 entry, which is the live
    // screen's runaway rule. The path says otherwise, and the path is right.
    const candles = [bar(0, 4306, 4302), bar(1, 4303, 4298), bar(2, 4318, 4310), bar(3, 4312, 4309)];
    const verdict = replayOrder(buyLimit(), candles, START + 4 * M15);
    expect(verdict.kind).not.toBe('missed');
  });
});

describe('the furthest target the path actually reached', () => {
  test('a run through every target records the third, not the first', () => {
    const candles = [bar(0, 4303, 4298), bar(1, 4345, 4310)];
    const verdict = replayOrder(buyLimit(), candles, START + 2 * M15);
    if (verdict.kind !== 'closed') throw new Error('expected a close');
    expect(verdict.level).toBe(3);
    expect(verdict.exitPrice).toBe(4340);
  });

  test('a short reads its targets downward', () => {
    const candles = [bar(0, 4302, 4299), bar(1, 4301, 4270)];
    const verdict = replayOrder(sellLimit(), candles, START + 2 * M15);
    if (verdict.kind !== 'closed') throw new Error('expected a close');
    expect(verdict.trigger).toBe('TP2');
    expect(verdict.exitPrice).toBe(4275);
  });
});

describe('what a bar that held both sides is taken to mean', () => {
  test('a bar containing the stop and a target is recorded as the loss', () => {
    // The order of events inside a candle cannot be recovered, so the losing
    // side is assumed first — the same reading the live screen uses.
    const candles = [bar(0, 4303, 4298), bar(1, 4320, 4289)];
    const verdict = replayOrder(buyLimit(), candles, START + 2 * M15);
    if (verdict.kind !== 'closed') throw new Error('expected a close');
    expect(verdict.trigger).toBe('SL');
  });

  test('a resting order can be stopped out by the very bar that filled it', () => {
    const candles = [bar(0, 4301, 4288)];
    const verdict = replayOrder(buyLimit(), candles, START + M15);
    if (verdict.kind !== 'closed') throw new Error('expected a close');
    expect(verdict.trigger).toBe('SL');
  });
});

describe('the ways a resting order dies without filling', () => {
  test('price through the invalidation is an invalidated miss', () => {
    const candles = [bar(0, 4308, 4304), bar(1, 4301, 4289)];
    const verdict = replayOrder(buyLimit({ entryPrice: 4302, stopLoss: 4290 }), candles, START + 2 * M15);
    expect(verdict.kind).toBe('missed');
    if (verdict.kind !== 'missed') throw new Error('expected a miss');
    expect(verdict.cause).toBe('invalidated');
  });

  test('a full stop distance past the entry without a fill is a runaway', () => {
    const candles = [bar(0, 4305, 4302), bar(1, 4311, 4306)];
    const verdict = replayOrder(buyLimit(), candles, START + 2 * M15);
    expect(verdict.kind).toBe('missed');
    if (verdict.kind !== 'missed') throw new Error('expected a miss');
    expect(verdict.cause).toBe('ran-away');
  });

  test('the window closing with price never arriving is an expiry', () => {
    const candles = [bar(0, 4306, 4303), bar(1, 4307, 4304)];
    const verdict = replayOrder(
      buyLimit({ validUntil: new Date(START + M15).toISOString() }),
      candles,
      START + 5 * M15
    );
    expect(verdict.kind).toBe('missed');
    if (verdict.kind !== 'missed') throw new Error('expected a miss');
    expect(verdict.cause).toBe('expired');
  });

  test('a window that runs out after the last candle still expires', () => {
    // The feed stops, the clock does not.
    const candles = [bar(0, 4306, 4303)];
    const verdict = replayOrder(
      buyLimit({ validUntil: new Date(START + 2 * M15).toISOString() }),
      candles,
      START + 10 * M15
    );
    expect(verdict.kind).toBe('missed');
  });
});

describe('an order still doing what it was meant to', () => {
  test('never filled and nothing has ended it is still pending', () => {
    const candles = [bar(0, 4306, 4303), bar(1, 4305, 4302)];
    const verdict = replayOrder(buyLimit(), candles, START + 2 * M15);
    expect(verdict.kind).toBe('pending');
  });

  test('filled and between its levels is still running', () => {
    const candles = [bar(0, 4303, 4298), bar(1, 4308, 4301)];
    const verdict = replayOrder(buyLimit(), candles, START + 2 * M15);
    expect(verdict.kind).toBe('running');
    if (verdict.kind !== 'running') throw new Error('expected a running position');
    expect(verdict.fillPrice).toBe(4300);
  });

  test('a market order is open from the moment it was issued', () => {
    const candles = [bar(0, 4302, 4298), bar(1, 4318, 4305)];
    const verdict = replayOrder(
      buyLimit({ orderType: 'BUY INSTANT', entryPrice: 4300 }),
      candles,
      START + 2 * M15
    );
    if (verdict.kind !== 'closed') throw new Error('expected a close');
    expect(verdict.trigger).toBe('TP1');
  });

  test('a market order is not closed by its own decision bar', () => {
    // That bar's range is already history at the moment the order opens.
    const candles = [bar(0, 4320, 4285), bar(1, 4302, 4299)];
    const verdict = replayOrder(
      buyLimit({ orderType: 'BUY INSTANT', entryPrice: 4300 }),
      candles,
      START + 2 * M15
    );
    expect(verdict.kind).toBe('running');
  });
});

describe('what it refuses to conclude', () => {
  test('an order older than the history is unknown, not a miss', () => {
    // The honest answer. A guess here is what wrote the false records.
    const candles = [bar(0, 4306, 4302), bar(1, 4312, 4308)];
    const verdict = replayOrder(
      buyLimit({ timestamp: new Date(START - 50 * M15).toISOString() }),
      candles,
      START + 2 * M15
    );
    expect(verdict.kind).toBe('unknown');
  });

  test('no candles at all is unknown', () => {
    expect(replayOrder(buyLimit(), [], START).kind).toBe('unknown');
  });

  test('an unreadable timestamp is unknown', () => {
    const verdict = replayOrder(buyLimit({ timestamp: 'not a date' }), [bar(0, 4303, 4298)], START);
    expect(verdict.kind).toBe('unknown');
  });

  test('an order issued moments before the first candle is still readable', () => {
    // A setup stamped seconds before its own candle opened is the ordinary
    // case, not a gap in the history.
    const verdict = replayOrder(
      buyLimit({ timestamp: new Date(START - 20_000).toISOString() }),
      [bar(0, 4303, 4298), bar(1, 4318, 4305)],
      START + 2 * M15
    );
    expect(verdict.kind).toBe('closed');
  });
});

describe('candles from before the order do not decide it', () => {
  test('a stop touched an hour before the order was issued is not its stop', () => {
    const candles = [
      bar(0, 4295, 4285), // long before: dips under 4290
      bar(1, 4306, 4302),
      bar(2, 4303, 4298), // the fill, after the order exists
      bar(3, 4318, 4310),
    ];
    const verdict = replayOrder(
      buyLimit({ timestamp: new Date(START + 1 * M15).toISOString() }),
      candles,
      START + 4 * M15
    );
    if (verdict.kind !== 'closed') throw new Error('expected a close');
    expect(verdict.trigger).toBe('TP1');
  });
});

describe('which witness decides, when they disagree', () => {
  const closed = {
    kind: 'closed' as const,
    trigger: 'TP1' as const,
    level: 1 as const,
    fillPrice: 4300,
    filledAt: new Date(START).toISOString(),
    exitPrice: 4315,
    at: new Date(START + M15).toISOString(),
    reason: 'path',
  };
  const running = {
    kind: 'running' as const,
    fillPrice: 4300,
    filledAt: new Date(START).toISOString(),
    reason: 'path',
  };
  const ranAway = { kind: 'missed' as const, cause: 'ran-away' as const, reason: 'path', at: '' };
  const stillPending = { kind: 'pending' as const, reason: 'path' };
  const unknown = { kind: 'unknown' as const, reason: 'path' };
  const tickRanAway = { state: 'ran-away' as const, reason: 'tick' };
  const tickWaiting = { state: 'waiting' as const, minutesLeft: 30, reason: 'tick' };

  describe('closing a trade — either may see it', () => {
    test('the tick closes a trade the candles have not recorded yet', () => {
      // The bar still forming is where a live close happens first.
      expect(resolveClose(running, 'TP2')).toEqual({ trigger: 'TP2', level: 2, at: null, breakEven: false });
    });

    test('with no candles at all the tick still closes', () => {
      expect(resolveClose(null, 'SL')).toEqual({ trigger: 'SL', level: 1, at: null, breakEven: false });
    });

    test('the candles win when both saw it, because they know the order of a bar', () => {
      const out = resolveClose(closed, 'TP3');
      expect(out?.trigger).toBe('TP1');
      expect(out?.at).not.toBeNull();
    });

    test('neither saw anything, so nothing closes', () => {
      expect(resolveClose(stillPending, null)).toBeNull();
    });
  });

  describe('recording a miss — the candles have the final word', () => {
    test('an order the candles show as filled is never a miss, whatever the tick says', () => {
      // The exact false record: price a stop's distance past an entry that had
      // already filled reads, on the tick alone, as a runaway.
      expect(resolveMiss(running, tickRanAway)).toBeNull();
    });

    test('nor is one they show as already closed', () => {
      expect(resolveMiss(closed, tickRanAway)).toBeNull();
    });

    test('an order that outran the history records nothing, rather than guessing', () => {
      expect(resolveMiss(unknown, tickRanAway)).toBeNull();
    });

    test('the candles’ own miss is recorded, with their cause', () => {
      expect(resolveMiss(ranAway, tickWaiting)?.cause).toBe('ran-away');
    });

    test('the candles confirm no fill, so the tick may end it', () => {
      // They agree it never filled; the tick sees the bar still forming.
      expect(resolveMiss(stillPending, tickRanAway)?.reason).toBe('tick');
    });

    test('with no candles the tick decides, as it always did', () => {
      expect(resolveMiss(null, tickRanAway)?.cause).toBe('ran-away');
    });

    test('a tick that is still waiting ends nothing', () => {
      expect(resolveMiss(stillPending, tickWaiting)).toBeNull();
      expect(resolveMiss(null, null)).toBeNull();
    });
  });
});

describe('the stop moved to entry at 1R', () => {
  // Buy at 4300, stop 4290: 1R is 4310. Fill, run to 4311, come back to 4300.
  const path = [bar(1, 4304, 4299), bar(2, 4311, 4303), bar(3, 4306, 4299.5)];

  test('a trade that came back to its entry after 1R closed at break-even, not at the stop', () => {
    const verdict = replayOrder(buyLimit({ protectAtR: 1 }), path, START + 4 * M15);
    expect(verdict.kind).toBe('closed');
    if (verdict.kind !== 'closed') return;
    expect(verdict.trigger).toBe('SL');
    expect(verdict.breakEven).toBe(true);
    expect(verdict.exitPrice).toBe(4300);
  });

  test('without the rule the same path is still open', () => {
    expect(replayOrder(buyLimit(), path, START + 4 * M15).kind).toBe('running');
  });

  test('once armed and still open, the replay says so', () => {
    const verdict = replayOrder(buyLimit({ protectAtR: 1 }), path.slice(0, 2), START + 3 * M15);
    expect(verdict.kind).toBe('running');
    if (verdict.kind === 'running') expect(verdict.protectedAt).toBe(new Date(START + 2 * M15).toISOString());
  });

  test('the bar that arms it is judged against the old stop first, as the backtest does', () => {
    // Reaches 1R and the original stop in one bar: taken as the full loss.
    const verdict = replayOrder(buyLimit({ protectAtR: 1 }), [bar(1, 4304, 4299), bar(2, 4311, 4289)], START + 3 * M15);
    expect(verdict.kind === 'closed' && verdict.breakEven).toBe(false);
    expect(verdict.kind === 'closed' && verdict.exitPrice).toBe(4290);
  });

  test('a short arms and closes the same way', () => {
    const shortPath = [bar(1, 4301, 4296), bar(2, 4297, 4289), bar(3, 4300.5, 4294)];
    const verdict = replayOrder(sellLimit({ protectAtR: 1 }), shortPath, START + 4 * M15);
    expect(verdict.kind === 'closed' && verdict.breakEven).toBe(true);
  });

  test('the tick sees a break-even close too', () => {
    expect(resolveClose(null, 'SL', true)).toEqual({ trigger: 'SL', level: 1, at: null, breakEven: true });
  });
});

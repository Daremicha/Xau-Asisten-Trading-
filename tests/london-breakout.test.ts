import { describe, expect, test } from 'bun:test';
import { londonBreakoutPlan, londonHour } from '../lib/london-breakout';
import { simulateOrder } from '../lib/backtest-engine';
import type { Candle } from '../lib/candles';

const M15 = 15 * 60_000;
const DAY = Date.UTC(2026, 0, 14); // a Wednesday in January: London is on UTC

/**
 * Three hundred rising candles before the day, so the 200 period average sits
 * well under the range; an Asian session between 100 and 110; then quiet
 * candles inside the range until the moment asked about.
 */
function market(until: number, { rising = true, asiaLow = 100, asiaHigh = 110, swing = 1 } = {}): Candle[] {
  const out: Candle[] = [];
  for (let k = 300; k > 0; k--) {
    const mid = rising ? 105 - k * 0.15 : 105 + k * 0.15;
    out.push({ time: DAY - k * M15, open: mid, high: mid + 1, low: mid - 1, close: mid, volume: 0 });
  }
  for (let t = DAY; t < until; t += M15) {
    const inAsia = t < DAY + 6 * 3_600_000;
    const first = t === DAY;
    const mid = (asiaLow + asiaHigh) / 2;
    // Inside the range during Asia; `swing` either side of the middle after it.
    const reach = inAsia ? Math.min(1, (asiaHigh - asiaLow) / 2) : swing;
    out.push({
      time: t,
      open: mid,
      high: inAsia && first ? asiaHigh : mid + reach,
      low: inAsia && t === DAY + M15 ? asiaLow : mid - reach,
      close: mid,
      volume: 0,
    });
  }
  return out;
}

describe('the London clock', () => {
  test('is UTC in winter and an hour ahead in summer', () => {
    expect(londonHour(Date.UTC(2026, 0, 14, 7, 30))).toBe(7.5);
    expect(londonHour(Date.UTC(2026, 6, 14, 6, 30))).toBe(7.5);
  });
});

describe('the London breakout plan', () => {
  const now = DAY + 7.5 * 3_600_000;

  test('in an uptrend, a buy stop above the Asian high with the stop at the low and the target at 2R', () => {
    const plan = londonBreakoutPlan(market(now), 105, now)!;
    expect(plan.orderType).toBe('BUY STOP');
    expect(plan.entryPrice).toBe(110.3);
    expect(plan.stopLoss).toBe(100);
    expect(plan.takeProfit1).toBeCloseTo(110.3 + 2 * 10.3, 2);
    expect(plan.takeProfit3).toBeGreaterThan(plan.takeProfit2);
    expect(plan.takeProfit2).toBeGreaterThan(plan.takeProfit1);
  });

  test('in a downtrend, a sell stop under the Asian low', () => {
    const plan = londonBreakoutPlan(market(now, { rising: false }), 105, now)!;
    expect(plan.orderType).toBe('SELL STOP');
    expect(plan.entryPrice).toBe(99.7);
    expect(plan.stopLoss).toBe(110);
  });

  test('expires at 10:00 London', () => {
    expect(londonBreakoutPlan(market(now), 105, now)!.expiresAt).toBe(DAY + 10 * 3_600_000);
    const summerDay = Date.UTC(2026, 6, 15);
    const summer = summerDay + 6.5 * 3_600_000; // 07:30 London
    const shifted = market(summer).map((c) => ({ ...c, time: c.time - DAY + summerDay }));
    expect(londonBreakoutPlan(shifted, 105, summer)?.expiresAt).toBe(summerDay + 9 * 3_600_000);
  });

  test('offers nothing outside 07:00 to 10:00 London', () => {
    const early = DAY + 6.5 * 3_600_000;
    const late = DAY + 10.25 * 3_600_000;
    expect(londonBreakoutPlan(market(early), 105, early)).toBeNull();
    expect(londonBreakoutPlan(market(late), 105, late)).toBeNull();
  });

  test('offers nothing once price has already left the range', () => {
    expect(londonBreakoutPlan(market(now), 111, now)).toBeNull();
    expect(londonBreakoutPlan(market(now), 99, now)).toBeNull();
  });

  test('offers nothing when the range is too narrow or too wide for the market', () => {
    // A one dollar range while the market has started moving five dollars a candle.
    expect(londonBreakoutPlan(market(now, { asiaLow: 104.5, asiaHigh: 105.5, swing: 5 }), 105, now)).toBeNull();
    expect(londonBreakoutPlan(market(now, { asiaLow: 60, asiaHigh: 150 }), 105, now)).toBeNull();
  });

  test('offers nothing without an Asian session in the data', () => {
    const candles = market(now).filter((c) => c.time < DAY || c.time >= DAY + 6 * 3_600_000);
    expect(londonBreakoutPlan(candles, 105, now)).toBeNull();
  });
});

describe('a stop order in the replay', () => {
  test('fills with slippage against it, like any order filled as price runs', () => {
    const t0 = Date.UTC(2026, 0, 14, 7);
    const bars: Candle[] = [
      { time: t0, open: 105, high: 106, low: 104, close: 105, volume: 0 },
      { time: t0 + M15, open: 105, high: 111, low: 105, close: 110.8, volume: 0 },
      { time: t0 + 2 * M15, open: 110.8, high: 132, low: 110.5, close: 131, volume: 0 },
    ];
    const plan = {
      direction: 'long' as const,
      instant: false,
      entryPrice: 110.3,
      stopLoss: 100,
      takeProfit1: 130.9,
      decidedAt: 0,
      expiresAt: t0 + 3 * 3_600_000,
      maxHoldMs: 24 * 3_600_000,
      slippageDollars: 0.2,
    };
    const asStop = simulateOrder(bars, { ...plan, stopEntry: true });
    const asLimit = simulateOrder(bars, plan);
    expect(asStop.kind === 'filled' && asStop.fillPrice).toBeCloseTo(110.5, 5);
    expect(asLimit.kind === 'filled' && asLimit.fillPrice).toBe(110.3);
  });
});

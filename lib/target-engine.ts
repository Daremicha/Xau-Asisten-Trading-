/**
 * Where a take profit actually belongs.
 *
 * Targets used to be a fixed multiple of the stop: 1.5R, 2.6R, 4R, whatever the
 * chart looked like. That is a tidy way to describe a trade and a poor way to
 * get paid. Price does not stop at multiples of your risk; it stops at levels,
 * and it only reaches the ones inside the distance it usually covers before the
 * idea expires.
 *
 * So a target here is a real level, close enough to be reached in the time the
 * style holds for, and placed just short of it so the order fills before the
 * queue that gathers at the level itself.
 */

import { Candle, findSwingPoints, priceToPips, round2 } from './candles';
import {
  QuasimodoPattern,
  SmcStructure,
  TradingCentralInsight,
  TradingStyle,
} from './types';

/** A level price might actually stop at, with the reason it is one. */
export interface TargetLevel {
  price: number;
  label: string;
}

/**
 * How far price usually travels before a setup of this style is done with,
 * expressed in ATR of the execution timeframe.
 *
 * A scalp lives for an hour or two, a swing for days, and the distance a target
 * may sit at has to follow that or it is decoration. These are deliberately
 * conservative: the point is a target that gets hit, not one that looks good.
 */
const REACH_IN_ATR: Record<TradingStyle, number> = {
  Scalping: 1.6,
  Intraday: 3.2,
  Swing: 6.0,
};

/**
 * Share of that reach each target may sit at.
 *
 * The first target is the one that matters: it is where most of a position is
 * closed, so it sits well inside what the market covers routinely. The third is
 * allowed to be ambitious because it is the runner.
 */
const TARGET_REACH_SHARE: [number, number, number] = [0.6, 0.9, 1.25];

/**
 * How far in front of a level a target sits, as a share of the distance to it.
 *
 * Everyone can see the previous day's high. Orders pile up there, and price
 * frequently turns a few tenths short of it. Paying that toll is the difference
 * between a target that fills and one that watches price reverse two dollars
 * away.
 */
const FRONT_RUN_SHARE = 0.12;
/** Never give up more than this to front running, in dollars. */
const MAX_FRONT_RUN_DOLLARS = 3.0;

/**
 * Closest the first target may sit, as a multiple of the risk taken.
 *
 * A target nearer than half the stop needs better than two wins in three just
 * to break even, which is not a trade that gets more certain by being closer.
 */
const MIN_FIRST_TARGET_R = 0.5;

export interface TargetInputs {
  entry: number;
  stop: number;
  direction: 'long' | 'short';
  tradingStyle: TradingStyle;
  atr: number;
  structures: { d1: SmcStructure; h4: SmcStructure; h1: SmcStructure; m15: SmcStructure };
  candles: Candle[];
  pivotBias?: TradingCentralInsight | null;
  quasimodo?: QuasimodoPattern | null;
}

/**
 * Every level in front of the trade that price has a reason to react to.
 *
 * Drawn from the same reads the rest of the engine uses, so a target is never
 * somewhere the analysis has not already looked.
 */
export function collectTargetLevels(inputs: TargetInputs): TargetLevel[] {
  const { entry, direction, structures, pivotBias, quasimodo, candles } = inputs;
  const ahead = (price: number) => (direction === 'long' ? price > entry : price < entry);
  const levels: TargetLevel[] = [];

  const add = (price: number | undefined | null, label: string) => {
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return;
    if (!ahead(price)) return;
    levels.push({ price, label });
  };

  // Liquidity resting above and below: the pools price is drawn toward.
  for (const [timeframe, structure] of [
    ['H1', structures.h1],
    ['H4', structures.h4],
    ['D1', structures.d1],
  ] as const) {
    const pools = structure.liquidityPools;
    add(direction === 'long' ? pools.pdh : pools.pdl, `${timeframe} previous day ${direction === 'long' ? 'high' : 'low'}`);
    add(direction === 'long' ? pools.asiaHigh : pools.asiaLow, `${timeframe} Asia session ${direction === 'long' ? 'high' : 'low'}`);

    // The far side of an opposing order block is where the move is likely to be
    // met by the other side.
    const block = structure.orderBlock;
    add(direction === 'long' ? block.low : block.high, `${timeframe} opposing order block edge`);

    // An unfilled imbalance ahead tends to be filled.
    if (structure.fairValueGap.detected) {
      add(
        direction === 'long' ? structure.fairValueGap.bottom : structure.fairValueGap.top,
        `${timeframe} imbalance edge`
      );
    }
  }

  // Classic pivots: published levels that a great many desks watch.
  if (pivotBias) {
    const pivotLevels = direction === 'long' ? pivotBias.keyResistanceLevels : pivotBias.keySupportLevels;
    pivotLevels.forEach((level, index) => add(level, `Pivot ${direction === 'long' ? 'R' : 'S'}${index + 1}`));
    add(pivotBias.pivotPoint, 'Daily pivot');
  }

  // The level a Quasimodo break projects toward.
  if (quasimodo?.detected) add(quasimodo.breakLevel, 'Quasimodo break level');

  // Recent swings, which is where a move most often pauses.
  const swings = findSwingPoints(candles.slice(-120), 2);
  for (const swing of swings.slice(-8)) {
    if (direction === 'long' && swing.kind === 'high') add(swing.price, 'Recent swing high');
    if (direction === 'short' && swing.kind === 'low') add(swing.price, 'Recent swing low');
  }

  // Nearest first, and never two targets on top of each other.
  const sorted = levels.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const distinct: TargetLevel[] = [];
  for (const level of sorted) {
    if (distinct.some((kept) => Math.abs(kept.price - level.price) < Math.max(0.2, inputs.atr * 0.08))) {
      continue;
    }
    distinct.push(level);
  }
  return distinct;
}

export interface SelectedTargets {
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  /** Why each target sits where it does, in the order of the targets. */
  basis: string[];
  /** Reward to risk on the first target, which is the one that gets hit. */
  riskReward: number;
  /**
   * True when no level was close enough to reach, so the targets fall back to
   * the distance the market typically covers rather than to a level.
   */
  usedFallback: boolean;
}

/** Distance price covers routinely for this style, in dollars. */
export function reachDistance(tradingStyle: TradingStyle, atr: number): number {
  return Math.max(atr, 0.01) * REACH_IN_ATR[tradingStyle];
}

/**
 * Places the three targets.
 *
 * Each one is the best level inside its share of the reach, moved a little
 * nearer so it fills before the crowd. When nothing real sits inside that
 * distance the target falls back to the distance itself, which is still a
 * statement about what the market does rather than about the size of the stop.
 */
export function selectTargets(inputs: TargetInputs): SelectedTargets {
  const { entry, stop, direction, tradingStyle, atr } = inputs;
  const sign = direction === 'long' ? 1 : -1;
  const risk = Math.abs(entry - stop);
  const reach = reachDistance(tradingStyle, atr);

  const levels = collectTargetLevels(inputs);
  const basis: string[] = [];
  const chosen: number[] = [];
  // A level pays out once. Without this the second target lands on the same
  // level as the first, separated only by the minimum spacing, which is two
  // targets pretending to be one.
  const spent = new Set<number>();
  let usedFallback = false;

  // A target has to be far enough away to be worth the stop it carries. Half
  // the risk is the floor: below that even a very high strike rate loses money,
  // so a level closer than this is skipped rather than used.
  const minimumFirst = Math.max(risk * MIN_FIRST_TARGET_R, atr * 0.3, 0.2);
  const separation = Math.max(0.3, atr * 0.15);

  for (let i = 0; i < 3; i++) {
    const floor = i === 0 ? minimumFirst : Math.abs(chosen[i - 1] - entry) + separation;
    // The ceiling can never sit below the floor, or a quiet market would put a
    // target on top of the entry.
    const ceiling = Math.max(reach * TARGET_REACH_SHARE[i], floor + separation);

    const inWindow = levels
      .filter((level) => {
        if (spent.has(level.price)) return false;
        const distance = Math.abs(level.price - entry);
        return distance > floor && distance <= ceiling;
      })
      // The nearest qualifying level, not the furthest. The point of placing a
      // target on structure is that price reaches it, and the nearest one is
      // the one it reaches most often.
      .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));

    // Among those, prefer the nearest that still pays for its stop. A target
    // inside one to one needs better than even odds just to break even, so it
    // is taken only when the market is offering nothing further inside reach.
    const paysForItself =
      i === 0 && risk > 0 ? inWindow.find((level) => Math.abs(level.price - entry) >= risk) : undefined;
    const candidate = paysForItself ?? inWindow[0];

    if (candidate) {
      spent.add(candidate.price);
      const distance = Math.abs(candidate.price - entry);
      const toll = Math.min(distance * FRONT_RUN_SHARE, MAX_FRONT_RUN_DOLLARS);
      // Paying the toll must not drag the target back inside the floor.
      const placed = Math.max(distance - toll, floor);
      chosen.push(round2(entry + sign * placed));
      basis.push(`${candidate.label} at ${candidate.price.toFixed(2)}, entered ${toll.toFixed(2)} in front of it`);
    } else {
      usedFallback = true;
      const distance = Math.max(ceiling, floor + Math.max(0.3, atr * 0.2));
      chosen.push(round2(entry + sign * distance));
      basis.push(
        `No level inside ${ceiling.toFixed(2)} dollars, so the target sits at the distance a ${tradingStyle.toLowerCase()} move usually covers`
      );
    }
  }

  return {
    takeProfit1: chosen[0],
    takeProfit2: chosen[1],
    takeProfit3: chosen[2],
    basis,
    riskReward: risk > 0 ? parseFloat((Math.abs(chosen[0] - entry) / risk).toFixed(2)) : 0,
    usedFallback,
  };
}

/** Distance to the first target, in pips, for display. */
export function targetDistancePips(entry: number, target: number): number {
  return priceToPips(Math.abs(target - entry));
}

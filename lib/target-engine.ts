/**
 * Where a take profit actually belongs.
 *
 * Two things are true at once, and the engine has now been burned by each of
 * them in turn.
 *
 * Price does not stop at multiples of your risk; it stops at levels. A target
 * that ignores structure sits in empty space and watches price turn a dollar
 * short of it.
 *
 * But a target also has to pay for the stop it carries. Placing targets purely
 * on the nearest level raised the strike rate and lost money anyway: winners
 * that small cannot cover the losers, whatever fraction of them come in.
 *
 * So the distance comes first, from the style's reward multiple, and structure
 * decides only where inside a window around that distance the order actually
 * sits. Reward to risk can never fall below three quarters of the multiple, and
 * when a real level sits near it the target is placed just in front of that
 * level instead of on the round number.
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
 * How far either side of the reward multiple a level may sit and still be used.
 *
 * Wide enough that most trades find real structure to sit in front of, narrow
 * enough that the trade keeps its arithmetic: at the bottom of the window a
 * 1.5R target is still 1.125R, which breaks even at 47 percent rather than the
 * 62 percent a 0.6R target needs.
 */
const SNAP_WINDOW: [number, number] = [0.75, 1.25];

export interface TargetInputs {
  entry: number;
  stop: number;
  direction: 'long' | 'short';
  tradingStyle: TradingStyle;
  atr: number;
  /**
   * The style's reward multiples, which set the distance of each target.
   *
   * Passed in rather than imported so the style profiles stay in one place and
   * the signal engine keeps owning them.
   */
  rewardMultiples: [number, number, number];
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
    add(direction === 'long' ? pools.pdh : pools.pdl, `${timeframe} ${direction === 'long' ? 'high' : 'low'} hari sebelumnya`);
    add(direction === 'long' ? pools.asiaHigh : pools.asiaLow, `${timeframe} ${direction === 'long' ? 'high' : 'low'} sesi Asia`);

    // The far side of an opposing order block is where the move is likely to be
    // met by the other side.
    const block = structure.orderBlock;
    add(direction === 'long' ? block.low : block.high, `${timeframe} tepi order block lawan`);

    // An unfilled imbalance ahead tends to be filled.
    if (structure.fairValueGap.detected) {
      add(
        direction === 'long' ? structure.fairValueGap.bottom : structure.fairValueGap.top,
        `${timeframe} tepi imbalance`
      );
    }
  }

  // Classic pivots: published levels that a great many desks watch.
  if (pivotBias) {
    const pivotLevels = direction === 'long' ? pivotBias.keyResistanceLevels : pivotBias.keySupportLevels;
    pivotLevels.forEach((level, index) => add(level, `Pivot ${direction === 'long' ? 'R' : 'S'}${index + 1}`));
    add(pivotBias.pivotPoint, 'Pivot harian');
  }

  // The level a Quasimodo break projects toward.
  if (quasimodo?.detected) add(quasimodo.breakLevel, 'Level break Quasimodo');

  // Recent swings, which is where a move most often pauses.
  const swings = findSwingPoints(candles.slice(-120), 2);
  for (const swing of swings.slice(-8)) {
    if (direction === 'long' && swing.kind === 'high') add(swing.price, 'Swing high terakhir');
    if (direction === 'short' && swing.kind === 'low') add(swing.price, 'Swing low terakhir');
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
   * True when at least one target found no level near its reward multiple and
   * so sits on the multiple itself.
   */
  usedFallback: boolean;
}

/**
 * Places the three targets.
 *
 * The reward multiple sets the distance. Structure then gets one chance to move
 * the target, to a level inside a window around that distance, where it sits
 * just in front of the level rather than on it. When no level is in the window
 * the target stays on the multiple, which is a worse looking target and a
 * better trade than one dragged in to the first thing price might touch.
 */
export function selectTargets(inputs: TargetInputs): SelectedTargets {
  const { entry, stop, direction, atr, rewardMultiples } = inputs;
  const sign = direction === 'long' ? 1 : -1;
  const risk = Math.abs(entry - stop);

  const levels = collectTargetLevels(inputs);
  const basis: string[] = [];
  const chosen: number[] = [];
  // A level pays out once. Without this the second target lands on the same
  // level as the first, separated only by the minimum spacing, which is two
  // targets pretending to be one.
  const spent = new Set<number>();
  let usedFallback = false;

  const separation = Math.max(0.3, atr * 0.15);

  for (let i = 0; i < 3; i++) {
    // Where the target belongs before the chart gets a say: the risk taken,
    // multiplied by what this style asks to be paid for taking it.
    const previous = i === 0 ? 0 : Math.abs(chosen[i - 1] - entry);
    const base = Math.max(risk * rewardMultiples[i], previous + separation, atr * 0.3, 0.2);

    // The window structure may move the target within. The stop already
    // carries the market's volatility, so a window around the multiple is a
    // window around what this market does, without a second distance rule to
    // fight it.
    const low = Math.max(base * SNAP_WINDOW[0], previous + separation);
    const ceiling = Math.max(base * SNAP_WINDOW[1], low);

    const candidate = levels
      .filter((level) => {
        if (spent.has(level.price)) return false;
        const distance = Math.abs(level.price - entry);
        return distance >= low && distance <= ceiling;
      })
      // Nearest to the multiple, so the snap is a nudge onto structure rather
      // than a different trade.
      .sort((a, b) => Math.abs(Math.abs(a.price - entry) - base) - Math.abs(Math.abs(b.price - entry) - base))[0];

    if (candidate) {
      spent.add(candidate.price);
      const distance = Math.abs(candidate.price - entry);
      const toll = Math.min(distance * FRONT_RUN_SHARE, MAX_FRONT_RUN_DOLLARS);
      // Paying the toll must not drag the target back below the window.
      const placed = Math.max(distance - toll, low);
      chosen.push(round2(entry + sign * placed));
      basis.push(
        `${(placed / Math.max(risk, 0.0001)).toFixed(2)}R, di depan ${candidate.label.toLowerCase()} di ${candidate.price.toFixed(2)}`
      );
    } else {
      usedFallback = true;
      chosen.push(round2(entry + sign * base));
      basis.push(
        `${rewardMultiples[i].toFixed(1)}R, tanpa level di dekatnya untuk dijadikan patokan`
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

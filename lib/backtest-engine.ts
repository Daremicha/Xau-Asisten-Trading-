/**
 * Replays the live engine over historical candles.
 *
 * The point of this module is that it is not a second trading engine. Every
 * decision runs through the same pipeline the live app uses — the same
 * structure reader, the same signal builder, the same conviction sizing, the
 * same validity windows and the same learning engine — with one difference: it
 * is shown only the candles that existed at the moment being replayed.
 *
 * Rules that keep the result honest:
 *
 *  - No lookahead. Each decision sees `candles[0..i]` and nothing after it.
 *  - No invented data. Candles come from the provider; when history stops, the
 *    run stops with it.
 *  - The intrabar path is unknown, so when a bar contains both the stop and the
 *    target the stop is taken. A backtest that assumes otherwise flatters
 *    itself.
 *  - Spread is charged on every filled trade, and commission wherever the
 *    account charges it.
 *  - No economic calendar. Historical releases are not available to the app, so
 *    the news shield is inactive here and the run says so rather than pretending
 *    it was applied.
 */

import { Candle } from './candles';
import { buildInstitutionalRead } from './analysis-pipeline';
import { buildSignal } from './signal-engine';
import { assessConviction, effectiveRiskPercentage } from './position-sizing';
import { calculateXAUUSDLotSize, getICTKillZoneStatus } from './market-engine';
import { computeValidity } from './order-validity';
import { deriveAdaptiveWeights, type PriorWeights } from './learning-engine';
import { resultFromMove, roundMoney } from './trade-result';
import type { MarketSnapshot } from './price-feed';
import {
  AccountType,
  AdaptiveStrategyEngineWeights,
  BrokerId,
  OrderExecutionType,
  SelfLearningMemoryRecord,
  TradeContext,
  TradingStyle,
} from './types';

const MINUTE_MS = 60_000;

export interface BacktestConfig {
  /** Chronological candles of the base timeframe, oldest first. */
  candles: Candle[];
  /** Length of one base candle, in milliseconds. */
  intervalMs: number;
  tradingStyle: TradingStyle;
  accountType: AccountType;
  brokerId: BrokerId;
  startingEquity: number;
  riskPercentage: number;
  /**
   * When true the learning engine re-derives its weights after every closed
   * trade, exactly as the live app does. When false the engine runs on its
   * starting parameters for the whole period, which is the control run.
   */
  adaptive: boolean;
  /**
   * Parameters the run starts from. Defaults to the engine's own. Passing the
   * weights a learning run ended on, with `adaptive` false, replays the period
   * as it would have gone had those parameters been adopted from the first
   * candle, which is the only honest test of adopting them.
   */
  startingPrior?: Partial<PriorWeights> | null;
  /** Candles each analysis may look back over. */
  windowBars?: number;
  /** Bars to wait after a trade closes before looking for the next setup. */
  cooldownBars?: number;
  /**
   * Lowest conviction worth trading, zero to one hundred. A setup scoring below
   * it is skipped rather than taken, which is what a trader does when nothing
   * on the chart is good enough. Zero takes everything.
   */
  minConviction?: number;
  /**
   * Move the stop to entry once a trade is this many multiples of its risk in
   * profit. Null leaves every stop where the engine put it, which is the
   * control. See `OrderPlan.breakEvenAtR`.
   */
  breakEvenAtR?: number | null;
  /**
   * Bars of history required before the first decision. Defaults to what the
   * timeframe needs; pinning it makes two runs over different slice lengths
   * directly comparable.
   */
  warmupBars?: number;
}

export interface BacktestTrade {
  sequence: number;
  openedAt: number;
  closedAt: number;
  orderType: OrderExecutionType;
  direction: 'long' | 'short';
  /** The price the engine quoted for the order. */
  entryPrice: number;
  /**
   * Where the position actually opened. A resting order fills at its own price;
   * a market order fills at the close of the bar it was decided on, which is
   * what the user would have paid.
   */
  fillPrice: number;
  stopLoss: number;
  takeProfit1: number;
  /** False when the order expired without price ever reaching the entry. */
  filled: boolean;
  outcome: 'TP' | 'SL' | 'MISSED';
  exitPrice: number;
  /** Plain reason the trade ended, for the ledger. */
  reason: string;
  lotSize: number;
  /** Result before trading costs. */
  grossDollars: number;
  /** Spread, and commission where the account charges it. */
  costDollars: number;
  netDollars: number;
  pips: number;
  /** Result as a multiple of the risk taken, the only cross-trade comparison. */
  rMultiple: number;
  equityAfter: number;
  confidenceScore: number;
  /** Conviction the setup scored when it was taken, for quality analysis. */
  convictionScore: number;
  /** Hours the order was on the book or in the market. */
  holdingHours: number;
  /**
   * True when the trade ended on a stop that had already been moved to entry,
   * so what would have been a full loss cost only the spread.
   */
  protectedExit?: boolean;
  /** What the risk percentage asked this trade to risk, in dollars. */
  riskBudgetDollars: number;
  /** What the lot actually risked, which the minimum lot can force higher. */
  actualRiskDollars: number;
  /**
   * True when the broker's minimum lot was larger than the budget allowed, so
   * the trade risked more than the setting asked for.
   */
  minimumLotForced: boolean;
}

export interface BacktestProgress {
  barsProcessed: number;
  totalBars: number;
  decisions: number;
  trades: number;
  equity: number;
  done: boolean;
}

export interface BacktestRunSummary {
  from: number | null;
  to: number | null;
  bars: number;
  intervalMs: number;
  tradingStyle: TradingStyle;
  accountType: AccountType;
  brokerId: BrokerId;
  startingEquity: number;
  riskPercentage: number;
  adaptive: boolean;
  /** Decisions where the data did not support a setup at all. */
  skipped: number;
  /** Conviction floor the run traded with. */
  minConviction: number;
  /** Setups the conviction floor rejected. */
  belowConviction: number;
}

export interface BacktestResult {
  summary: BacktestRunSummary;
  trades: BacktestTrade[];
  equityCurve: Array<{ sequence: number; time: number; equity: number }>;
  /** Weights the engine ended on, which is what a learning run produces. */
  finalWeights: AdaptiveStrategyEngineWeights;
  /** Records the run generated, so the learning engine can be primed with them. */
  records: SelfLearningMemoryRecord[];
}

/** How long a filled position may stay open before it is closed at market. */
const MAX_HOLD_MINUTES: Record<TradingStyle, number> = {
  Scalping: 24 * 60,
  Intraday: 3 * 24 * 60,
  Swing: 15 * 24 * 60,
};

export function defaultWindowBars(intervalMs: number): number {
  // Roughly six weeks of history either way: enough for a daily read to have
  // real swing points without re-analysing two years on every decision.
  return intervalMs >= 60 * MINUTE_MS ? 1000 : 4000;
}

export function defaultCooldownBars(intervalMs: number): number {
  return intervalMs >= 60 * MINUTE_MS ? 1 : 4;
}

/** Bars of history before the first decision, so nothing is read from a stub. */
export function warmupBars(intervalMs: number): number {
  return intervalMs >= 60 * MINUTE_MS ? 400 : 1400;
}

/** A historical window presented in the shape the live pipeline consumes. */
function snapshotFor(window: Candle[]): MarketSnapshot {
  const last = window[window.length - 1];
  return {
    status: 'live',
    source: 'Backtest replay',
    fetchedAt: new Date(last.time).toISOString(),
    ageMs: 0,
    price: last.close,
    dayHigh: null,
    dayLow: null,
    previousClose: null,
    candlesM15: window,
    message: 'Historical replay.',
  };
}

function rootCauseFor(
  outcome: 'TP' | 'SL' | 'MISSED',
  reason: string,
  anchor: string
): SelfLearningMemoryRecord['rootCauseAnalysis'] {
  return {
    primaryFactor:
      outcome === 'TP'
        ? `${anchor} held and the target was reached.`
        : outcome === 'SL'
        ? `${anchor} failed and the invalidation was traded through.`
        : `Price never returned to the ${anchor.toLowerCase()}.`,
    institutionalFlowExplanation: reason,
    liquidityBehavior:
      outcome === 'MISSED'
        ? 'The order rested outside the range price actually traded.'
        : 'The level was traded through in the direction recorded.',
  };
}

/** Builds the record the learning engine reads from a finished simulated trade. */
export function recordFor(
  trade: BacktestTrade,
  style: TradingStyle,
  anchor: string,
  context?: TradeContext
): SelfLearningMemoryRecord {
  return {
    id: `bt_${trade.sequence}_${trade.closedAt}`,
    analysisId: `bt_setup_${trade.sequence}`,
    timestamp: new Date(trade.closedAt).toISOString(),
    outcome: trade.outcome,
    symbol: 'XAUUSD',
    orderType: trade.orderType,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    profitOrLossPips: trade.pips,
    profitOrLossDollars: trade.netDollars,
    rootCauseAnalysis: rootCauseFor(trade.outcome, trade.reason, anchor),
    strategyEvolutionLesson: trade.reason,
    tradingStyle: style,
    autoResolved: true,
    // The same conditions the live app records, so a replay exercises the
    // conditional learning rather than a reduced version of the engine.
    context,
    adaptiveWeightAdjustments: {
      fvgWeightDelta: 0,
      orderBlockWeightDelta: 0,
      newsFilterWeightDelta: 0,
      atrBufferMultiplier: 1,
    },
  };
}


/** An order handed to the simulator, exactly as the engine quoted it. */
export interface OrderPlan {
  direction: 'long' | 'short';
  /** True for a market order, which opens at the close of the decision bar. */
  instant: boolean;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  /** Index of the bar the decision was made on. */
  decidedAt: number;
  /** Milliseconds after which an unfilled order is void. */
  expiresAt: number;
  /** Milliseconds a filled position may stay open before it is closed at market. */
  maxHoldMs: number;
  /**
   * Move the stop to the fill price once price has travelled this multiple of
   * the risk in favour. Null or zero leaves the stop where the engine put it.
   *
   * This is the only management rule the simulator knows, and it exists because
   * it is the one traders reach for when a run of stop outs hurts: a trade that
   * has already paid once should not be allowed to become a full loss. Whether
   * it actually earns more is a question for the data, not for an opinion,
   * which is why it is an option here rather than a default.
   */
  breakEvenAtR?: number | null;
}

export type OrderOutcome =
  | { kind: 'missed'; index: number; reason: string }
  | {
      kind: 'filled';
      fillIndex: number;
      fillPrice: number;
      exitIndex: number;
      exitPrice: number;
      outcome: 'TP' | 'SL';
      reason: string;
      /** True when the trade ended on a stop that had been moved to entry. */
      protectedExit?: boolean;
    }
  /** History ran out before the order resolved, so there is nothing to record. */
  | { kind: 'unresolved' };

/**
 * Walks an order forward through the candles that followed it.
 *
 * Separated from the decision loop because this is where a backtest usually
 * lies to itself, and it is the part worth testing directly: when an order
 * fills, when it is declared missed, and which level is taken when a single bar
 * contains both.
 */
export function simulateOrder(candles: Candle[], plan: OrderPlan): OrderOutcome {
  const isLong = plan.direction === 'long';
  const decisionBar = candles[plan.decidedAt];
  if (!decisionBar) return { kind: 'unresolved' };

  let fillIndex = plan.instant ? plan.decidedAt : -1;

  if (!plan.instant) {
    for (let j = plan.decidedAt + 1; j < candles.length; j++) {
      const c = candles[j];
      if (c.low <= plan.entryPrice && plan.entryPrice <= c.high) {
        fillIndex = j;
        break;
      }
      // The same three ways the live app calls a resting order dead.
      if (isLong ? c.low <= plan.stopLoss : c.high >= plan.stopLoss) {
        return {
          kind: 'missed',
          index: j,
          reason: 'Price traded through the invalidation without ever reaching the entry.',
        };
      }
      // The same rule the live app uses: a full stop distance beyond the entry
      // without a fill means the move happened without the trade.
      const risk = Math.abs(plan.entryPrice - plan.stopLoss);
      const ranPast = isLong ? c.high - plan.entryPrice : plan.entryPrice - c.low;
      if (risk > 0 && ranPast >= risk) {
        return {
          kind: 'missed',
          index: j,
          reason: 'Price ran a full stop distance past the entry without ever filling it.',
        };
      }
      if (c.time > plan.expiresAt) {
        return { kind: 'missed', index: j, reason: 'The order expired without filling.' };
      }
    }
    if (fillIndex === -1) return { kind: 'unresolved' };
  }

  const fillBar = candles[fillIndex];
  const fillPrice = plan.instant ? decisionBar.close : plan.entryPrice;
  const riskDistance = Math.abs(fillPrice - plan.stopLoss);
  const armAt = plan.breakEvenAtR && plan.breakEvenAtR > 0 && riskDistance > 0
    ? riskDistance * plan.breakEvenAtR
    : null;
  // The stop can move once, from where the engine put it to the fill price.
  let stop = plan.stopLoss;
  let protectedStop = false;
  // A market order opens at the close of its decision bar, so that bar's own
  // high and low are already history and cannot close the trade. A resting
  // order fills inside its bar, which can also take it out.
  const scanStart = plan.instant ? fillIndex + 1 : fillIndex;
  const deadline = fillBar.time + plan.maxHoldMs;

  for (let j = scanStart; j < candles.length; j++) {
    const c = candles[j];
    // The order of events inside a bar cannot be recovered from open, high, low
    // and close, so the losing side is assumed to come first.
    if (isLong ? c.low <= stop : c.high >= stop) {
      return {
        kind: 'filled',
        fillIndex,
        fillPrice,
        exitIndex: j,
        exitPrice: stop,
        outcome: 'SL',
        reason: protectedStop
          ? 'Price came back to the entry after the stop had been moved there, so the trade cost only its spread.'
          : 'Price traded through the invalidation.',
        protectedExit: protectedStop,
      };
    }
    // Arming happens after this bar's stop has been checked, so a bar that
    // reaches the trigger and the old stop is taken as a loss. The intrabar
    // order is unknown and the simulator does not get to guess in its favour.
    if (armAt !== null && !protectedStop) {
      const travelled = isLong ? c.high - fillPrice : fillPrice - c.low;
      if (travelled >= armAt) {
        stop = fillPrice;
        protectedStop = true;
      }
    }
    if (isLong ? c.high >= plan.takeProfit1 : c.low <= plan.takeProfit1) {
      return {
        kind: 'filled',
        fillIndex,
        fillPrice,
        exitIndex: j,
        exitPrice: plan.takeProfit1,
        outcome: 'TP',
        reason: 'The first target was reached.',
      };
    }
    if (c.time >= deadline) {
      const profitable = isLong ? c.close > fillPrice : c.close < fillPrice;
      return {
        kind: 'filled',
        fillIndex,
        fillPrice,
        exitIndex: j,
        exitPrice: c.close,
        outcome: profitable ? 'TP' : 'SL',
        reason: `Closed at market after the ${Math.round(plan.maxHoldMs / 3_600_000)} hour holding limit.`,
      };
    }
  }

  return { kind: 'unresolved' };
}

interface Runner {
  step(maxDecisions?: number): BacktestProgress;
  progress(): BacktestProgress;
  result(): BacktestResult;
}

/**
 * Creates a run that advances in slices.
 *
 * A two year replay is thousands of full analyses. Stepping lets the caller
 * yield to the browser between slices so the progress bar actually moves
 * instead of the tab freezing.
 */
export function createBacktest(config: BacktestConfig): Runner {
  const {
    candles,
    intervalMs,
    tradingStyle,
    accountType,
    brokerId,
    startingEquity,
    riskPercentage,
    adaptive,
  } = config;

  const windowBars = config.windowBars ?? defaultWindowBars(intervalMs);
  const cooldownBars = config.cooldownBars ?? defaultCooldownBars(intervalMs);
  // An explicit warmup is honoured as given, so two runs over different slice
  // lengths still make their first decision on the same bar. The default backs
  // off on a short series rather than refusing to trade it at all.
  const warmup =
    config.warmupBars !== undefined
      ? Math.max(1, Math.min(config.warmupBars, candles.length - 1))
      : Math.min(warmupBars(intervalMs), Math.max(1, Math.floor(candles.length / 3)));
  const maxHoldMs = MAX_HOLD_MINUTES[tradingStyle] * MINUTE_MS;

  let cursor = warmup;
  let equity = startingEquity;
  let sequence = 0;
  let decisions = 0;
  let skipped = 0;
  let belowConviction = 0;
  const minConviction = Math.max(0, Math.min(100, config.minConviction ?? 0));

  const trades: BacktestTrade[] = [];
  const records: SelfLearningMemoryRecord[] = [];
  const equityCurve: Array<{ sequence: number; time: number; equity: number }> = candles.length
    ? [{ sequence: 0, time: candles[warmup]?.time ?? candles[0].time, equity: startingEquity }]
    : [];

  const startingPrior = config.startingPrior ?? null;
  let weights: AdaptiveStrategyEngineWeights = deriveAdaptiveWeights([], tradingStyle, startingPrior);

  function progress(): BacktestProgress {
    return {
      barsProcessed: Math.min(cursor, candles.length),
      totalBars: candles.length,
      decisions,
      trades: trades.length,
      equity,
      done: cursor >= candles.length - 1,
    };
  }

  /** Runs one decision at `cursor` and advances past whatever it produced. */
  function decide(): void {
    const i = cursor;
    const bar = candles[i];
    const window = candles.slice(Math.max(0, i + 1 - windowBars), i + 1);

    const read = buildInstitutionalRead(snapshotFor(window));
    if (!read) {
      skipped += 1;
      cursor = i + cooldownBars;
      return;
    }

    decisions += 1;
    const at = new Date(bar.time);
    const killZone = getICTKillZoneStatus(at);

    const decision = buildSignal({
      price: bar.close,
      structures: read.multiTimeframe,
      indicators: read.indicators,
      weights,
      tradingStyle,
      candles: read.executionCandles,
      // The same panels the live engine reads, so the replay tests the engine
      // that actually runs rather than a reduced version of it.
      pivotBias: read.tradingCentral,
      wyckoff: read.wyckoff,
      quasimodo: read.quasimodo,
      killZoneActive: killZone.isHighVolatilityTiming,
      // A historical economic calendar is not available to the app, so the news
      // shield is deliberately inactive rather than guessed at.
      upcomingHighImpactEvents: [],
      minutesToNextEvent: null,
    });

    const trends = [read.multiTimeframe.d1.trend, read.multiTimeframe.h4.trend, read.multiTimeframe.h1.trend];
    const conviction = assessConviction({
      confidenceScore: decision.confidenceScore,
      timeframesAligned: new Set(trends).size === 1 && trends[0] !== 'Ranging',
      killZoneActive: killZone.isHighVolatilityTiming,
      entryOutOfReach: decision.entryOutOfReach,
      dataStale: false,
      proposalRejected: false,
    });
    // Nothing on this chart is good enough, so nothing is traded. Skipping is
    // free; a bad fill is not.
    if (conviction.convictionScore < minConviction) {
      belowConviction += 1;
      cursor = i + cooldownBars;
      return;
    }

    const riskUsed = effectiveRiskPercentage(riskPercentage, conviction.multiplier);
    const lot = calculateXAUUSDLotSize(
      equity,
      riskUsed,
      decision.entryPrice,
      decision.stopLoss,
      accountType,
      tradingStyle,
      brokerId
    );

    const validity = computeValidity(tradingStyle, killZone.isHighVolatilityTiming, at);
    const instant = decision.orderType.includes('INSTANT');

    const outcome = simulateOrder(candles, {
      direction: decision.direction,
      instant,
      entryPrice: decision.entryPrice,
      stopLoss: decision.stopLoss,
      takeProfit1: decision.takeProfit1,
      decidedAt: i,
      expiresAt: bar.time + validity.validForMinutes * MINUTE_MS,
      maxHoldMs,
      breakEvenAtR: config.breakEvenAtR ?? null,
    });

    if (outcome.kind === 'unresolved') {
      // History ran out with the order still live. Nothing is recorded from a
      // trade whose result the data cannot show.
      cursor = candles.length;
      return;
    }

    sequence += 1;

    if (outcome.kind === 'missed') {
      const missBar = candles[outcome.index];
      const trade: BacktestTrade = {
        sequence,
        openedAt: bar.time,
        closedAt: missBar.time,
        orderType: decision.orderType,
        direction: decision.direction,
        entryPrice: decision.entryPrice,
        fillPrice: decision.entryPrice,
        stopLoss: decision.stopLoss,
        takeProfit1: decision.takeProfit1,
        filled: false,
        outcome: 'MISSED',
        // Where price actually was when the order died: the distance the
        // learning engine measures misses by.
        exitPrice: parseFloat(missBar.close.toFixed(2)),
        reason: outcome.reason,
        lotSize: lot.lotSize,
        grossDollars: 0,
        costDollars: 0,
        netDollars: 0,
        pips: 0,
        rMultiple: 0,
        equityAfter: equity,
        confidenceScore: decision.confidenceScore,
        convictionScore: conviction.convictionScore,
        holdingHours: parseFloat(((missBar.time - bar.time) / 3_600_000).toFixed(2)),
        riskBudgetDollars: lot.riskDollars,
        actualRiskDollars: lot.actualRiskDollars,
        minimumLotForced: lot.exceedsRiskBudget,
      };
      trades.push(trade);
      records.push(
        recordFor(trade, tradingStyle, decision.anchor, {
          anchor: decision.anchor,
          convictionScore: conviction.convictionScore,
          session: killZone.currentZone,
          killZoneActive: killZone.isHighVolatilityTiming,
          timeframesAligned: new Set(trends).size === 1 && trends[0] !== 'Ranging',
          // A historical calendar is not available to a replay, so this is
          // recorded as false rather than guessed at.
          newsNearby: false,
          entryDistancePips: Math.abs(decision.entryDistancePips),
          stopLossPips: decision.stopLossPips,
          rMultiple: 0,
        })
      );
      equityCurve.push({ sequence, time: missBar.time, equity });
      if (adaptive) weights = deriveAdaptiveWeights(records, tradingStyle, startingPrior);
      cursor = outcome.index + cooldownBars;
      return;
    }

    const sized = {
      entryPrice: outcome.fillPrice,
      recommendedLotSize: lot.lotSize,
      accountType,
      contractSpecs: lot.contractSpecs,
    };
    const gross = resultFromMove(sized, outcome.exitPrice, decision.direction);
    // Spread is paid once, on entry, across the whole position.
    const spreadCost =
      lot.contractSpecs.typicalSpreadPips * 0.1 * lot.lotSize * lot.contractSpecs.contractSizeOz;
    const net = roundMoney(gross.dollars - spreadCost);
    // The label follows the money: a target reached by a hair that costs more in
    // spread than it paid is not a win.
    const settled: 'TP' | 'SL' = net > 0 ? 'TP' : 'SL';

    equity = Math.max(0, roundMoney(equity + net));

    const fillBar = candles[outcome.fillIndex];
    const exitBar = candles[outcome.exitIndex];
    const trade: BacktestTrade = {
      sequence,
      openedAt: bar.time,
      closedAt: exitBar.time,
      orderType: decision.orderType,
      direction: decision.direction,
      entryPrice: decision.entryPrice,
      fillPrice: parseFloat(outcome.fillPrice.toFixed(2)),
      stopLoss: decision.stopLoss,
      takeProfit1: decision.takeProfit1,
      filled: true,
      outcome: settled,
      exitPrice: parseFloat(outcome.exitPrice.toFixed(2)),
      reason: outcome.reason,
      lotSize: lot.lotSize,
      grossDollars: gross.dollars,
      costDollars: roundMoney(spreadCost),
      netDollars: net,
      pips: gross.pips,
      rMultiple:
        lot.actualRiskDollars > 0 ? parseFloat((net / lot.actualRiskDollars).toFixed(2)) : 0,
      equityAfter: equity,
      confidenceScore: decision.confidenceScore,
      convictionScore: conviction.convictionScore,
      holdingHours: parseFloat(((exitBar.time - fillBar.time) / 3_600_000).toFixed(2)),
      protectedExit: outcome.protectedExit ?? false,
      riskBudgetDollars: lot.riskDollars,
      actualRiskDollars: lot.actualRiskDollars,
      minimumLotForced: lot.exceedsRiskBudget,
    };

    trades.push(trade);
    records.push(
      recordFor(trade, tradingStyle, decision.anchor, {
        anchor: decision.anchor,
        convictionScore: conviction.convictionScore,
        session: killZone.currentZone,
        killZoneActive: killZone.isHighVolatilityTiming,
        timeframesAligned: new Set(trends).size === 1 && trends[0] !== 'Ranging',
        newsNearby: false,
        entryDistancePips: Math.abs(decision.entryDistancePips),
        stopLossPips: decision.stopLossPips,
        rMultiple: trade.rMultiple,
      })
    );
    equityCurve.push({ sequence, time: exitBar.time, equity });
    if (adaptive) weights = deriveAdaptiveWeights(records, tradingStyle, startingPrior);

    cursor = outcome.exitIndex + cooldownBars;
  }

  return {
    step(maxDecisions = 25) {
      let taken = 0;
      while (taken < maxDecisions && cursor < candles.length - 1) {
        const before = cursor;
        decide();
        // Every path must advance the cursor, but a guard costs nothing and an
        // infinite loop in a browser tab costs the user their session.
        if (cursor <= before) cursor = before + 1;
        if (equity <= 0) {
          cursor = candles.length;
          break;
        }
        taken += 1;
      }
      return progress();
    },
    progress,
    result(): BacktestResult {
      return {
        summary: {
          from: candles.length ? candles[Math.min(warmup, candles.length - 1)].time : null,
          to: candles.length ? candles[candles.length - 1].time : null,
          bars: candles.length,
          intervalMs,
          tradingStyle,
          accountType,
          brokerId,
          startingEquity,
          riskPercentage,
          adaptive,
          skipped,
          minConviction,
          belowConviction,
        },
        trades,
        equityCurve,
        finalWeights: adaptive ? deriveAdaptiveWeights(records, tradingStyle, startingPrior) : weights,
        records,
      };
    },
  };
}

/** Runs a backtest to completion. Used by the tests and by short runs. */
export function runBacktest(config: BacktestConfig): BacktestResult {
  const run = createBacktest(config);
  // Bounded so a pathological config can never spin forever.
  let guard = 0;
  while (!run.progress().done && guard < 100_000) {
    run.step(50);
    guard += 1;
  }
  return run.result();
}

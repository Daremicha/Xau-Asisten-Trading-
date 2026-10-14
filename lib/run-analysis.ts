import { after } from 'next/server';
import { effectiveConvictionFloor, sessionDeclineNote, WEAK_SETUP_BELOW, weakSetupDecline } from './session-rules';
import { executeGenerativeSynthesisWithProvider } from './gen-engine';
import { calculateXAUUSDLotSize, getICTKillZoneStatus, recalculateEngineWeights } from './market-engine';
import { alignedVotes, directionOfOrder } from './factor-learning';
import {
  getEconomicCalendar,
  filterUpcoming,
  minutesToNextHighImpact,
  usdOnly,
} from './economic-calendar';
import { getMarketSnapshot } from './price-feed';
import { archiveCalendar } from './calendar-archive';
import { buildInstitutionalRead } from './analysis-pipeline';
import { buildSignal, maxEntryDistance, resolveOrderType, STYLE_PROFILES } from './signal-engine';
import { assessConviction, drawdownFromHistory, effectiveRiskPercentage } from './position-sizing';
import { MIN_BUCKET_SAMPLES, conditionalPerformance } from './learning-engine';
import { computeValidity, isDeadOnArrival, missAtR } from './order-validity';
import { nextCheck } from './next-check';
import { publicErrorMessage, safeProviderNote } from './safe-error';
import {
  normaliseProposal,
  parseProposal,
  structuralLevels,
  validateProposal,
  type ProposalContext,
} from './proposal-validation';
import { priceToPips, round2, type Candle } from './candles';
import { BREAKOUT_ANCHOR, LONDON_BREAKOUT, londonBreakoutPlan, type BreakoutPlan } from './london-breakout';
import { QUICK_TARGET_R, quickTargets } from './quick-target';

/** Distance between live price and the quoted entry, in pips. */
const priceToPipsDistance = (price: number, entry: number) => priceToPips(price - entry);
import { InstitutionalTradingSetup, EngineGenerationMetadata, EngineInputUsed } from './types';
import type { ValidatedAnalyzeRequest } from './request-validation';
import { learningInput } from './tested-configuration';
import { closedResults, dailyLossLimitReached, dailyLossNote, netToday, nextTradingDayStart } from './daily-loss';


export interface AnalysisReply {
  status: number;
  body: Record<string, unknown>;
}

function reply(body: Record<string, unknown>, init?: { status?: number }): AnalysisReply {
  return { status: init?.status ?? 200, body };
}

/**
 * The London breakout order to offer now, with its lot, or null. Intraday
 * only, the style it was tested on; once a day; and only when the minimum lot
 * does not risk more than the user's percentage.
 */
function breakoutFor(
  input: ValidatedAnalyzeRequest,
  candles: Candle[],
  price: number
): { plan: BreakoutPlan; lot: ReturnType<typeof calculateXAUUSDLotSize>; affordable: boolean } | null {
  if (input.tradingStyle !== 'Intraday') return null;
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const tradedToday = input.pastLearningRecords.some(
    (r) => r.context?.anchor === BREAKOUT_ANCHOR && (r.placedAt ?? r.timestamp ?? '').slice(0, 10) === today
  );
  if (tradedToday) return null;
  // Closed candles only: the one still forming would move the range and the average.
  const closed = candles.filter((c) => c.time + 15 * 60_000 <= now);
  const plan = londonBreakoutPlan(closed, price, now);
  if (!plan) return null;
  const lot = calculateXAUUSDLotSize(
    input.equity,
    input.riskPercentage,
    plan.entryPrice,
    plan.stopLoss,
    input.accountType,
    input.tradingStyle,
    input.brokerId
  );
  return { plan, lot, affordable: !lot.exceedsRiskBudget };
}

/** Why a breakout that exists was not offered, and the balance that would carry it. */
function breakoutWaitingNote(
  input: ValidatedAnalyzeRequest,
  found: { plan: BreakoutPlan; lot: ReturnType<typeof calculateXAUUSDLotSize> }
): string {
  const share = (found.lot.actualRiskDollars / input.equity) * 100;
  const needed = found.lot.actualRiskDollars / (input.riskPercentage / 100);
  const money = input.accountType === 'Cent' ? `${Math.ceil(needed * 100).toLocaleString('en-US')} Cent` : `$${Math.ceil(needed)}`;
  return `A London breakout is set up (${found.plan.orderType} ${found.plan.entryPrice.toFixed(2)}), but its ${Math.round(
    Math.abs(found.plan.entryPrice - found.plan.stopLoss) * 10
  )} pip stop would risk ${share.toFixed(1)}% of the balance at the minimum lot, over your ${
    input.riskPercentage
  }%. It is offered from a balance of about ${money}.`;
}

/**
 * One analysis, exactly as the Run button asks for it. Shared by the route and
 * by the server's scheduled scan, so a setup pushed to a closed app is the
 * setup the open app would have been given.
 */
export async function runAnalysis(input: ValidatedAnalyzeRequest): Promise<AnalysisReply> {
  // The daily loss limit comes first: once it is reached there is nothing to
  // analyse today, and asking the data provider anyway only spends quota.
  const now = Date.now();
  const netSoFar = netToday(closedResults(input.pastLearningRecords), now);
  if (input.dailyLossLimitPercent && dailyLossLimitReached(netSoFar, input.equity, input.dailyLossLimitPercent)) {
    const resumesAt = nextTradingDayStart(now);
    return reply({
      success: true,
      setup: null,
      skipped: {
        reason: 'daily-limit',
        convictionScore: 0,
        band: 'Low',
        threshold: input.minConviction,
        direction: 'long',
        notes: [dailyLossNote(netSoFar, input.equity, input.dailyLossLimitPercent, resumesAt)],
        rationale: '',
        nextCheck: {
          at: new Date(resumesAt).toISOString(),
          reason: 'The daily loss limit resets when the next trading day starts, at the daily open of gold.',
          marketClosed: false,
          session: null,
        },
      },
    });
  }

  try {
    // Real market data is a hard requirement. Without it there is no analysis.
    const snapshot = await getMarketSnapshot();
    if (snapshot.price === null) {
      return reply(
        { success: false, error: snapshot.message, dataStatus: snapshot.status },
        { status: 503 }
      );
    }

    const read = buildInstitutionalRead(snapshot);
    if (!read) {
      return reply(
        {
          success: false,
          error: `The feed returned only ${snapshot.candlesM15.length} candles, which is not enough to derive market structure.`,
          dataStatus: snapshot.status,
        },
        { status: 503 }
      );
    }

    const marketPrice = snapshot.price;
    // A backtested prior, when the user has adopted one, replaces the engine's
    // own defaults as the point the live evidence shrinks toward.
    // Live trades re-tune the weights only when the user's self-learning
    // switch is on; see DEFAULT_SELF_LEARNING.
    const engineWeights = recalculateEngineWeights(
      learningInput(input.pastLearningRecords, input.selfLearning),
      input.tradingStyle,
      input.priorWeights
    );
    const killZone = getICTKillZoneStatus();
    // A calendar the app cannot actually see must not move the stop loss, so
    // an unconfigured or unreachable provider yields no events and no news
    // adjustment at all.
    const calendar = await getEconomicCalendar();
    after(() => archiveCalendar(calendar.events));
    // The same dollar-only view the screen shows, so the stop is never widened
    // for a release the user was never told about.
    const economicEvents = usdOnly(filterUpcoming(calendar.events));
    const highImpact = economicEvents.filter((e) => e.impact === 'High');
    const minutesToNextEvent = minutesToNextHighImpact(usdOnly(calendar.events));

    // Deterministic, tested engine owns every price level.
    const decision = buildSignal({
      price: marketPrice,
      structures: read.multiTimeframe,
      indicators: read.indicators,
      weights: engineWeights,
      tradingStyle: input.tradingStyle,
      candles: read.executionCandles,
      // Every panel the screen shows now reaches the decision. The pivot read,
      // the Wyckoff phase and the Quasimodo pattern were computed and displayed
      // from the first version, but the engine never looked at them.
      pivotBias: read.tradingCentral,
      wyckoff: read.wyckoff,
      quasimodo: read.quasimodo,
      killZoneActive: killZone.isHighVolatilityTiming,
      upcomingHighImpactEvents: highImpact,
      minutesToNextEvent,
    });

    let institutionalRationale = decision.rationale;
    let engineMetadata: EngineGenerationMetadata = {
      provider: 'algorithmic',
      model: 'Structural SMC/ICT engine',
      isFallback: false,
      timestamp: new Date().toISOString(),
    };

    // The order the user finally sees. It starts as the deterministic one and
    // is replaced only by a proposal that survives every structural check.
    let finalOrder = {
      orderType: decision.orderType,
      entryPrice: decision.entryPrice,
      stopLoss: decision.stopLoss,
      takeProfit1: decision.takeProfit1,
      takeProfit2: decision.takeProfit2,
      takeProfit3: decision.takeProfit3,
      riskRewardRatio: decision.riskRewardRatio,
    };
    let proposalOutcome: {
      attempted: boolean;
      accepted: boolean;
      reasons: string[];
      anchoredTo?: string;
      model?: string;
      /** True once a proposal actually arrived and was checked against structure. */
      reviewed?: boolean;
    } = { attempted: false, accepted: false, reasons: [] };

    const hasProviderKey = [
      process.env.GEMINI_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.ANTHROPIC_API_KEY,
      process.env.CLAUDE_API_KEY,
    ].some((k) => typeof k === 'string' && k.trim().length > 0);

    // Price levels come from the tested engine. A language model may propose
    // its own only when AI_PRICE_PROPOSALS is turned on: its orders were never
    // part of the replay the settings rest on, and a provider that did not
    // answer used to cost every setup ten points of conviction, enough to push
    // about one setup in eight under the floor.
    const proposalsEnabled = hasProviderKey && process.env.AI_PRICE_PROPOSALS?.trim().toLowerCase() === 'on';

    if (proposalsEnabled) {
      proposalOutcome.attempted = true;

      const proposalContext: ProposalContext = {
        price: marketPrice,
        indicators: read.indicators,
        structures: read.multiTimeframe,
        tradingStyle: input.tradingStyle,
      };

      const levelList = structuralLevels(proposalContext)
        .map((l) => `- ${l.name}: ${l.price.toFixed(2)}`)
        .join('\n');

      const pastLessons = input.pastLearningRecords
        .slice(-8)
        .map(
          (rec, idx) =>
            `[${idx + 1}] Outcome ${rec.outcome}. Lesson: ${rec.strategyEvolutionLesson}`
        )
        .join('\n');

      const styleProfileForPrompt = STYLE_PROFILES[input.tradingStyle];
      const maxEntryReach = maxEntryDistance(styleProfileForPrompt, read.indicators.atr14);

      const prompt = `You are a senior institutional trading strategist working an XAUUSD desk.

Propose one order. Every number you give will be checked against the market
structure below, and the proposal is discarded whole if any rule is broken.

Live price: ${marketPrice.toFixed(2)}
Trading style: ${input.tradingStyle} (${styleProfileForPrompt.label})

Hard rules, all enforced:
- Stop distance must be between ${(styleProfileForPrompt.minStopDollars * 10).toFixed(0)} and ${(styleProfileForPrompt.maxStopDollars * 10).toFixed(0)} pips.
- The entry must be within ${(maxEntryReach * 10).toFixed(0)} pips of live price.
- The entry must sit within ${(read.indicators.atr14 * 0.5 * 10).toFixed(0)} pips of one of the measured levels listed below. Do not invent a level.
- The first target must pay at least 1.0 times the risk.
- A long needs its stop below entry and its targets ascending; a short is the mirror.

Measured structure:
- D1 ${read.multiTimeframe.d1.trend}, H4 ${read.multiTimeframe.h4.trend}, H1 ${read.multiTimeframe.h1.trend}, M15 ${read.multiTimeframe.m15.trend}
- Pricing zone on the execution timeframe: ${read.multiTimeframe.h1.pricingZone}
- Wyckoff phase ${read.wyckoff.phase}, point of control ${read.wyckoff.pointOfControlPOC.toFixed(2)}
- EMA 50 ${read.indicators.ema50.toFixed(2)}, EMA 200 ${read.indicators.ema200.toFixed(2)}, RSI ${read.indicators.rsi14.toFixed(1)}, ATR ${read.indicators.atr14.toFixed(2)}
- Session: ${killZone.currentZone}

Measured levels you may anchor an entry to:
${levelList}

The structural engine's own proposal, for reference:
${decision.orderType} at ${decision.entryPrice.toFixed(2)}, stop ${decision.stopLoss.toFixed(2)}, targets ${decision.takeProfit1.toFixed(2)} / ${decision.takeProfit2.toFixed(2)} / ${decision.takeProfit3.toFixed(2)}

Lessons carried from previous trades:
${pastLessons || 'No resolved trades yet.'}

Reply with JSON only:
{"direction":"long"|"short","entryPrice":number,"stopLoss":number,"takeProfit1":number,"takeProfit2":number,"takeProfit3":number,"rationale":string}`;

      try {
        const synth = await executeGenerativeSynthesisWithProvider(prompt, {
          responseMimeType: 'application/json',
        });

        if (!synth?.text) {
          proposalOutcome.reasons = ['No language model provider returned a reply.'];
        } else {
          proposalOutcome.model = synth.model;
          const { proposal, reasons: parseReasons } = parseProposal(synth.text);

          if (!proposal) {
            proposalOutcome.reasons = parseReasons;
          } else {
            const verdict = validateProposal(proposal, proposalContext);
            proposalOutcome.reviewed = true;
            proposalOutcome.accepted = verdict.accepted;
            proposalOutcome.reasons = verdict.reasons;
            proposalOutcome.anchoredTo = verdict.anchoredTo;

            if (verdict.accepted) {
              const clean = normaliseProposal(proposal);
              const risk = Math.abs(clean.entryPrice - clean.stopLoss);
              const reward = Math.abs(clean.takeProfit1 - clean.entryPrice);

              finalOrder = {
                // The order type is derived, never taken from the model, so it
                // always matches where the entry sits relative to price.
                orderType: resolveOrderType(
                  clean.direction,
                  clean.entryPrice,
                  marketPrice,
                  STYLE_PROFILES[input.tradingStyle].instantToleranceDollars
                ),
                entryPrice: clean.entryPrice,
                stopLoss: clean.stopLoss,
                takeProfit1: clean.takeProfit1,
                takeProfit2: clean.takeProfit2,
                takeProfit3: clean.takeProfit3,
                riskRewardRatio: risk > 0 ? `1:${(reward / risk).toFixed(2)}` : '1:0',
              };

              institutionalRationale = `${clean.rationale}\n\nValidated against ${
                verdict.anchoredTo
              }. Engine reference: ${decision.rationale}`;
              engineMetadata = {
                provider: synth.provider,
                model: synth.model,
                isFallback: synth.isFallback,
                switchReason: synth.switchReason,
                timestamp: new Date().toISOString(),
              };
            } else {
              // A rejected proposal still contributes its reading, but never a price.
              institutionalRationale = `${decision.rationale}\n\nA language model proposal was rejected: ${verdict.reasons.join(
                ' '
              )}`;
            }
          }
        }
      } catch (err) {
        // Never the provider's own words: they can quote the key back.
        proposalOutcome.reasons = [safeProviderNote(err, 'Provider error')];
      }
    }

    // A feed quoting something other than spot XAUUSD. COMEX futures track
    // gold and trade tens of dollars away from it, so an entry, a stop and a
    // target read from that series are all shifted by the basis and none of
    // them line up with the broker the user actually trades at. A wrong level
    // offered confidently is worse than no level.
    if (snapshot.instrument !== 'spot') {
      return reply({
        success: true,
        setup: null,
        skipped: {
          reason: 'feed-mismatch',
          convictionScore: 0,
          band: 'Low',
          threshold: input.minConviction,
          direction: decision.direction,
          notes: [
            `The only market data available right now is ${snapshot.source}.`,
            'That contract settles for future delivery, so it trades at the cost of carry away from spot XAUUSD — commonly tens of dollars.',
            'Entry, stop and target read from it would all be shifted by that difference and would not match your broker, so none are offered.',
          ],
          rationale: decision.rationale,
          nextCheck: nextCheck(input.tradingStyle),
        },
        dataStatus: snapshot.status,
      });
    }

    // The London breakout of the Asian range, offered only when the structural
    // engine has nothing to trade, the same order of priority the replay
    // tested. It waits until the minimum lot keeps the risk inside what the
    // user asked for: its stop is the whole Asian range. See london-breakout.ts.
    const breakoutFound = breakoutFor(input, snapshot.candlesM15, marketPrice);
    const breakoutCandidate = breakoutFound?.affordable ? breakoutFound : null;
    const breakoutNote = breakoutFound && !breakoutFound.affordable ? breakoutWaitingNote(input, breakoutFound) : null;
    // Typed through a cast: it is set inside takeBreakout, which the checker cannot follow.
    let breakout = null as typeof breakoutCandidate;
    const takeBreakout = (): boolean => {
      if (!breakoutCandidate) return false;
      breakout = breakoutCandidate;
      finalOrder = {
        orderType: breakout.plan.orderType,
        entryPrice: breakout.plan.entryPrice,
        stopLoss: breakout.plan.stopLoss,
        takeProfit1: breakout.plan.takeProfit1,
        takeProfit2: breakout.plan.takeProfit2,
        takeProfit3: breakout.plan.takeProfit3,
        riskRewardRatio: `1:${LONDON_BREAKOUT.targetR.toFixed(2)}`,
      };
      institutionalRationale = `${breakout.plan.rationale}\n\nThe structural engine had no setup to offer; its reading, for reference: ${decision.rationale}`;
      engineMetadata = { ...engineMetadata, model: 'London breakout of the Asian range' };
      return true;
    };

    // An order price has already left behind. Checked on the order that would
    // actually be offered, so an accepted model proposal is held to it too.
    // Offering one of these is worse than offering nothing: the app records it
    // as a missed entry within seconds, and the ledger fills with trades that
    // never existed.
    if (isDeadOnArrival(finalOrder, marketPrice) && !takeBreakout()) {
      const risk = Math.abs(finalOrder.entryPrice - finalOrder.stopLoss);
      const away = Math.abs(marketPrice - finalOrder.entryPrice);
      return reply({
        success: true,
        setup: null,
        skipped: {
          reason: 'unfillable',
          convictionScore: decision.confidenceScore,
          band: 'Low',
          threshold: input.minConviction,
          direction: decision.direction,
          notes: [
            `Market is at ${marketPrice.toFixed(2)} and the level this read is built on sits at ${finalOrder.entryPrice.toFixed(
              2
            )}, ${priceToPips(away)} pips away.`,
            `The trade would carry a ${priceToPips(risk)} pip stop, so an order resting there counts as a missed entry the moment it is placed.`,
            'The level is worth watching. There is no order to leave working at it right now.',
          ],
          rationale: decision.rationale,
          nextCheck: nextCheck(input.tradingStyle),
          // Below this price the order would no longer count as a missed entry
          // the moment it was placed, so this is the number to watch for.
          watchPrice: round2(
            decision.direction === 'long'
              ? finalOrder.entryPrice + risk
              : finalOrder.entryPrice - risk
          ),
        },
        dataStatus: snapshot.status,
      });
    }

    // How much of the risk budget this particular setup deserves. The user's
    // percentage is the ceiling for the strongest setups, never a flat rate.
    const trends = [
      read.multiTimeframe.d1.trend,
      read.multiTimeframe.h4.trend,
      read.multiTimeframe.h1.trend,
    ];
    // The account's own state, and what this kind of setup has actually
    // returned. Both were on the screen already; neither reached the decision.
    const drawdownPercent = drawdownFromHistory(input.equity, input.pastLearningRecords);
    const anchorBucket = conditionalPerformance(learningInput(input.pastLearningRecords)).byAnchor.find(
      (bucket) => bucket.label === decision.anchor
    );
    const measuredEdgeR =
      anchorBucket && anchorBucket.samples >= MIN_BUCKET_SAMPLES ? anchorBucket.averageR : null;

    const conviction = assessConviction({
      confidenceScore: decision.confidenceScore,
      timeframesAligned: new Set(trends).size === 1 && trends[0] !== 'Ranging',
      killZoneActive: killZone.isHighVolatilityTiming,
      entryOutOfReach: decision.entryOutOfReach && !proposalOutcome.accepted,
      dataStale: snapshot.status === 'stale',
      // Only a proposal that arrived and broke a structural rule counts
      // against the setup. A provider that never answered says nothing about it.
      proposalRejected: Boolean(proposalOutcome.reviewed) && !proposalOutcome.accepted,
      // The account's drawdown and the first target's reward to risk are not
      // part of the score. The 24 month replay the settings rest on scored
      // setups without them; adding both took profit factor from 1.31 to 1.29
      // and declined twenty setups that paid. The daily loss limit is the
      // brake on a bad run, and the minimum lot already caps a small account.
      measuredEdgeR,
    });
    // A quality floor the user set. Nothing on the chart being good enough is a
    // real answer, and a cheaper one than a bad trade: skipping costs nothing.
    // A band a backtest showed losing money in both halves of a period. This is
    // narrower than a floor on purpose: on this engine the lowest band has paid
    // the most, so refusing everything under a score throws away the good with
    // the bad.
    const dead = input.skipConvictionBand;
    if (
      !breakout &&
      dead &&
      conviction.convictionScore >= dead.min &&
      conviction.convictionScore < dead.max &&
      !takeBreakout()
    ) {
      return reply({
        success: true,
        setup: null,
        skipped: {
          reason: 'dead-band',
          convictionScore: conviction.convictionScore,
          band: conviction.band,
          threshold: input.minConviction,
          deadBand: { label: `${dead.min} to ${dead.max - 1}`, min: dead.min, max: dead.max },
          direction: decision.direction,
          notes: conviction.notes,
          rationale: decision.rationale,
          nextCheck: nextCheck(input.tradingStyle),
        },
        dataStatus: snapshot.status,
      });
    }

    const floorNow = effectiveConvictionFloor(input.minConviction, killZone.currentZone);
    const weakNote = weakSetupDecline(conviction.convictionScore, alignedVotes(decision.factors, decision.direction));
    if (!breakout && (conviction.convictionScore < floorNow || weakNote) && !takeBreakout()) {
      const sessionNote =
        sessionDeclineNote(input.minConviction, killZone.currentZone, conviction.convictionScore) ?? weakNote;
      return reply({
        success: true,
        setup: null,
        skipped: {
          reason: 'below-conviction',
          convictionScore: conviction.convictionScore,
          band: conviction.band,
          threshold: weakNote && conviction.convictionScore >= floorNow ? WEAK_SETUP_BELOW : floorNow,
          // Which rule said no, so the screen does not call the weak-setup
          // rule "your floor" to someone trading with the floor at zero.
          declinedBy:
            conviction.convictionScore < input.minConviction
              ? 'floor'
              : conviction.convictionScore < floorNow
                ? 'session'
                : 'weak-setup',
          direction: decision.direction,
          notes: [...(sessionNote ? [sessionNote] : []), ...conviction.notes, ...(breakoutNote ? [breakoutNote] : [])],
          rationale: decision.rationale,
          nextCheck: nextCheck(input.tradingStyle),
        },
        dataStatus: snapshot.status,
      });
    }

    // A nearer target when the user chose it. The entry, the stop and the lot
    // are the engine's; only where the trade is taken off changes. See
    // quick-target.ts.
    const quick = !breakout && input.quickTarget;
    if (quick) {
      finalOrder = {
        ...finalOrder,
        ...quickTargets(finalOrder.entryPrice, finalOrder.stopLoss, directionOfOrder(finalOrder.orderType)),
        riskRewardRatio: `1:${QUICK_TARGET_R.toFixed(2)}`,
      };
    }

    // The breakout was tested at the full risk asked for; conviction scales
    // only the structural engine's setups.
    const riskPercentUsed = breakout
      ? input.riskPercentage
      : effectiveRiskPercentage(input.riskPercentage, conviction.multiplier);

    // Sized from the order that will actually be placed, which may be the
    // model's proposal rather than the engine's own.
    const lotCalculation = breakout ? breakout.lot : calculateXAUUSDLotSize(
      input.equity,
      riskPercentUsed,
      finalOrder.entryPrice,
      finalOrder.stopLoss,
      input.accountType,
      input.tradingStyle,
      input.brokerId
    );

    // The risk percentage is a ceiling. When the broker's smallest lot loses
    // more than it allows, the honest answer is no trade, not a trade at a
    // size the user never agreed to. The user can turn this off, and the card
    // then shows the real figure instead.
    const budgetDollars = input.equity * (input.riskPercentage / 100);
    if (input.riskGuard && lotCalculation.actualRiskDollars > budgetDollars + 0.005) {
      const actualPercent = (lotCalculation.actualRiskDollars / input.equity) * 100;
      const balanceNeeded = lotCalculation.actualRiskDollars / (input.riskPercentage / 100);
      return reply({
        success: true,
        setup: null,
        skipped: {
          reason: 'risk-cap',
          convictionScore: conviction.convictionScore,
          band: conviction.band,
          threshold: input.minConviction,
          direction: decision.direction,
          notes: [
            `The setup was a ${finalOrder.orderType} at ${finalOrder.entryPrice.toFixed(2)} with the stop at ${finalOrder.stopLoss.toFixed(2)}.`,
            ...conviction.notes,
          ],
          rationale: decision.rationale,
          nextCheck: nextCheck(input.tradingStyle),
          riskCap: {
            actualRiskDollars: lotCalculation.actualRiskDollars,
            budgetDollars,
            actualPercent: parseFloat(actualPercent.toFixed(2)),
            riskPercentage: input.riskPercentage,
            balanceNeeded: parseFloat(balanceNeeded.toFixed(2)),
            accountType: input.accountType,
          },
        },
        dataStatus: snapshot.status,
      });
    }

    const validity = breakout
      ? {
          ...computeValidity(input.tradingStyle, killZone.isHighVolatilityTiming),
          validUntil: new Date(breakout.plan.expiresAt).toISOString(),
          validForMinutes: Math.max(1, Math.round((breakout.plan.expiresAt - Date.now()) / 60_000)),
          basis: 'A London breakout order is only valid until 10:00 London time.',
        }
      : computeValidity(input.tradingStyle, killZone.isHighVolatilityTiming);

    const spreadDollars = (lotCalculation.contractSpecs.typicalSpreadPips * 0.1) / 2;
    const bid = round2(marketPrice - spreadDollars);
    const ask = round2(marketPrice + spreadDollars);

    const symbolHint = input.accountType === 'Cent' ? 'XAUUSDc / GOLDc (Cent Account)' : 'XAUUSD (Gold vs US Dollar)';
    const specs = lotCalculation.contractSpecs;
    const styleProfile = STYLE_PROFILES[input.tradingStyle];

    const mt5Instructions = [
      `1. Open MetaTrader 5 on desktop or mobile.`,
      `2. Select symbol: [ ${symbolHint} ].`,
      `3. Order type: [ ${finalOrder.orderType} ].`,
      lotCalculation.exceedsRiskBudget
        ? `4. Volume: [ ${lotCalculation.lotSize.toFixed(2)} ${specs.lotUnit} ]. WARNING: the broker minimum lot risks $${lotCalculation.actualRiskDollars.toFixed(
            2
          )}, which is ${((lotCalculation.actualRiskDollars / input.equity) * 100).toFixed(
            1
          )}% of your $${input.equity.toLocaleString('en-US')}, above the ${input.riskPercentage}% you asked for. Reduce the stop distance or raise the balance to respect the budget.`
        : `4. Volume: [ ${lotCalculation.lotSize.toFixed(2)} ${specs.lotUnit} ], sized to $${lotCalculation.actualRiskDollars.toFixed(
            2
          )} risk at ${input.riskPercentage}% of $${input.equity.toLocaleString('en-US')}.`,
      `5. Entry price: [ ${finalOrder.entryPrice.toFixed(2)} ] (${breakout ? BREAKOUT_ANCHOR : decision.anchor}).`,
      `6. Stop loss: [ ${finalOrder.stopLoss.toFixed(2)} ], ${lotCalculation.stopLossPips} pips away.`,
      `7. Targets: TP1 [ ${finalOrder.takeProfit1.toFixed(2)} ] | TP2 [ ${finalOrder.takeProfit2.toFixed(
        2
      )} ] | TP3 [ ${finalOrder.takeProfit3.toFixed(2)} ].`,
      breakout
        ? `8. London breakout: a stop order, filled only if price breaks out of the Asian range. Delete it at ${new Date(
            breakout.plan.expiresAt
          ).toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })} WIB (10:00 London) if it has not filled.`
        : `8. Profile: ${styleProfile.label}. Entry sits ${decision.entryDistancePips} pips from the current price${
            decision.entryOutOfReach ? ', which is beyond this style\u2019s usual reach, so it may not fill today' : ''
          }.`,
      `9. Broker: ${specs.brokerName}, ${specs.typicalSpreadPips} pips typical spread.`,
      `10. Data source: ${snapshot.source ?? 'unknown'}${
        snapshot.status === 'stale' ? ` (STALE, ${Math.round(snapshot.ageMs / 1000)}s old)` : ''
      }.`,
    ];

    // What the engine actually read, recorded where the reading happened. Every
    // panel on the screen appears here or says why it could not be used, so the
    // claim that the analysis consults them is checkable rather than asserted.
    const nextRelease = highImpact[0];
    const inputsConsulted: EngineInputUsed[] = [
      {
        label: 'Live chart and structure',
        value: `D1 ${read.multiTimeframe.d1.trend}, H4 ${read.multiTimeframe.h4.trend}, H1 ${read.multiTimeframe.h1.trend}, M15 ${read.multiTimeframe.m15.trend} from ${snapshot.candlesM15.length} candles.`,
        used: true,
      },
      {
        label: 'Indicators',
        value: `EMA 50 ${read.indicators.ema50.toFixed(2)} against EMA 200 ${read.indicators.ema200.toFixed(
          2
        )}, RSI ${read.indicators.rsi14.toFixed(1)}, ATR ${read.indicators.atr14.toFixed(2)}.`,
        used: true,
      },
      {
        label: 'Institutional structure and confluence',
        value: `${read.multiTimeframe.h1.orderBlock.type} with ${
          read.multiTimeframe.h1.fairValueGap.detected ? 'an open imbalance' : 'no imbalance'
        }, ${read.multiTimeframe.h1.pricingZone} pricing, ${
          read.multiTimeframe.h1.liquidityPools.swept ? 'liquidity taken' : 'pools intact'
        }.`,
        used: true,
      },
      {
        label: 'Pivot and directional bias',
        value: `${read.tradingCentral.directionalBias} around the ${read.tradingCentral.pivotPoint.toFixed(
          2
        )} pivot at ${read.tradingCentral.confidenceScore}% confidence.`,
        used: true,
      },
      {
        label: 'Wyckoff and Quasimodo',
        value: `${read.wyckoff.phase} phase${
          read.quasimodo.detected ? `, ${read.quasimodo.type} formed` : ', no Quasimodo pattern'
        }.`,
        used: true,
      },
      {
        label: 'Institutional trading session',
        value: `${killZone.currentZone}${
          killZone.isHighVolatilityTiming ? ', inside a kill zone' : ', outside the kill zones'
        }.`,
        used: true,
      },
      {
        label: 'USD economic calendar',
        value: calendar.configured
          ? nextRelease
            ? `${nextRelease.title} at ${nextRelease.time}${
                minutesToNextEvent !== null ? `, ${Math.round(minutesToNextEvent)} minutes away` : ''
              }.`
            : 'No high impact USD release ahead, so no news widening applied.'
          : calendar.message,
        used: calendar.configured,
      },
      {
        label: 'Adaptive self-learning engine',
        value:
          input.pastLearningRecords.length === 0
            ? 'No closed trades yet, so the engine is on its starting parameters.'
            : `${input.pastLearningRecords.length} closed trades${
                measuredEdgeR === null
                  ? ''
                  : `, and ${decision.anchor.toLowerCase()} entries have returned ${measuredEdgeR}R`
              }.`,
        used: input.pastLearningRecords.length > 0,
      },
      {
        label: 'Strategy backtest lab',
        value: input.priorWeights
          ? 'Starting parameters adopted from a backtest, with live results adjusting from there.'
          : 'No backtested parameters adopted, so the engine defaults are the starting point.',
        used: Boolean(input.priorWeights),
      },
      {
        label: 'Portfolio and equity growth',
        value:
          drawdownPercent > 0
            ? `${drawdownPercent}% below the account high water mark. Shown for information; the daily loss limit, not the score, handles a losing run.`
            : 'Account at its high water mark.',
        used: false,
      },
    ];

    const setupPayload: InstitutionalTradingSetup = {
      id: 'setup_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      userId: input.userId,
      symbol: 'XAUUSD',
      timestamp: new Date().toISOString(),
      currentMarketPrice: marketPrice,
      bidPrice: bid,
      askPrice: ask,
      tradingStyle: input.tradingStyle,
      accountType: input.accountType,
      brokerId: input.brokerId,
      contractSpecs: specs,
      orderType: finalOrder.orderType,
      entryPrice: finalOrder.entryPrice,
      stopLoss: finalOrder.stopLoss,
      takeProfit1: finalOrder.takeProfit1,
      takeProfit2: finalOrder.takeProfit2,
      takeProfit3: finalOrder.takeProfit3,
      riskRewardRatio: finalOrder.riskRewardRatio,
      // Kept on the setup so the result can be learned from by condition, not
      // just by outcome: which level the entry came from, and how far it sat.
      entryAnchor: breakout ? BREAKOUT_ANCHOR : proposalOutcome.accepted ? 'Market' : decision.anchor,
      // How each factor voted against the direction actually placed, so the
      // result can later be credited to the factors that were right about it.
      factorVotes: breakout ? undefined : alignedVotes(decision.factors, directionOfOrder(finalOrder.orderType)),
      // Only the engine's own targets carry a basis; a model proposal that was
      // accepted replaced them, and saying otherwise would be a fabrication.
      targetBasis: breakout
        ? [`TP1 at ${LONDON_BREAKOUT.targetR}R, the target the breakout was tested with; TP2 and TP3 a half and a whole R further.`]
        : quick
          ? [
              `Quick target on: one target at ${QUICK_TARGET_R}R. It wins more often and earns less per trade; turn it off in the settings for the engine's own targets.`,
            ]
          : proposalOutcome.accepted
          ? undefined
          : decision.targetBasis,
      targetsFellBack: breakout || quick || proposalOutcome.accepted ? undefined : decision.targetsFellBack,
      entryDistancePips: priceToPipsDistance(marketPrice, finalOrder.entryPrice),
      stopLossPips: lotCalculation.stopLossPips,
      recommendedLotSize: lotCalculation.lotSize,
      riskDollarAmount: lotCalculation.riskDollars,
      actualRiskDollars: lotCalculation.actualRiskDollars,
      exceedsRiskBudget: lotCalculation.exceedsRiskBudget,
      balanceAtSetup: input.equity,
      missAtR: missAtR(quick),
      riskPercentage: input.riskPercentage,
      effectiveRiskPercentage: riskPercentUsed,
      // A breakout is not scored by the structural engine, so it carries no
      // conviction of its own.
      ...(breakout
        ? {}
        : {
            convictionMultiplier: conviction.multiplier,
            convictionScore: conviction.convictionScore,
            convictionBand: conviction.band,
            convictionNotes: conviction.notes,
          }),
      validUntil: validity.validUntil,
      validityBasis: validity.basis,
      multiTimeframeAlignment: read.multiTimeframe,
      technicalIndicators: read.indicators,
      wyckoffVsa: read.wyckoff,
      quasimodo: read.quasimodo,
      economicEvents,
      tradingCentralBias: read.tradingCentral,
      killZoneStatus: {
        currentZone: killZone.currentZone,
        isHighVolatilityTiming: killZone.isHighVolatilityTiming,
      },
      inputsConsulted,
      institutionalRationale,
      executionInstructionsMT5: mt5Instructions,
      // A resting order is PENDING until price reaches it; only an instant
      // order is live the moment it is placed. The two were previously
      // indistinguishable, which left the pending branches of the UI dead.
      status: finalOrder.orderType.includes('INSTANT') ? 'ACTIVE' : 'PENDING',
      engineMetadata,
      modelProposal: proposalOutcome,
    };

    return reply({
      success: true,
      setup: setupPayload,
      engineWeights,
      confidenceScore: decision.confidenceScore,
      conviction,
      validity,
      confluenceFactors: decision.factors,
      entryDistancePips: priceToPipsDistance(marketPrice, finalOrder.entryPrice),
      entryOutOfReach: !breakout && decision.entryOutOfReach && !proposalOutcome.accepted,
      modelProposal: proposalOutcome,
      actualRiskDollars: lotCalculation.actualRiskDollars,
      exceedsRiskBudget: lotCalculation.exceedsRiskBudget,
      calendarConfigured: calendar.configured,
      calendarMessage: calendar.message,
      dataStatus: snapshot.status,
      dataSource: snapshot.source,
      dataAgeSeconds: Math.round(snapshot.ageMs / 1000),
    });
  } catch (err: unknown) {
    // Logged in full on the server, reported in a form that cannot carry a
    // credential to the browser.
    console.error('Analysis engine error:', err);
    return reply(
      {
        success: false,
        error: publicErrorMessage(err, 'The analysis engine could not complete this request.'),
      },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { executeGenerativeSynthesisWithProvider } from '@/lib/gen-engine';
import { calculateXAUUSDLotSize, getICTKillZoneStatus, recalculateEngineWeights } from '@/lib/market-engine';
import {
  getEconomicCalendar,
  filterUpcoming,
  minutesToNextHighImpact,
  usdOnly,
} from '@/lib/economic-calendar';
import { getMarketSnapshot } from '@/lib/price-feed';
import { buildInstitutionalRead } from '@/lib/analysis-pipeline';
import { buildSignal, maxEntryDistance, resolveOrderType, STYLE_PROFILES } from '@/lib/signal-engine';
import { assessConviction, drawdownFromHistory, effectiveRiskPercentage } from '@/lib/position-sizing';
import { MIN_BUCKET_SAMPLES, conditionalPerformance } from '@/lib/learning-engine';
import { computeValidity } from '@/lib/order-validity';
import {
  normaliseProposal,
  parseProposal,
  structuralLevels,
  validateProposal,
  type ProposalContext,
} from '@/lib/proposal-validation';
import { priceToPips, round2 } from '@/lib/candles';

/** Distance between live price and the quoted entry, in pips. */
const priceToPipsDistance = (price: number, entry: number) => priceToPips(price - entry);
import { InstitutionalTradingSetup, EngineGenerationMetadata, EngineInputUsed } from '@/lib/types';
import { validateAnalyzeBody } from '@/lib/request-validation';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Request body is not valid JSON.' },
      { status: 400 }
    );
  }

  const { value: input, errors } = validateAnalyzeBody(body);
  if (!input) {
    return NextResponse.json({ success: false, error: errors.join(' ') }, { status: 400 });
  }

  try {
    // Real market data is a hard requirement. Without it there is no analysis.
    const snapshot = await getMarketSnapshot();
    if (snapshot.price === null) {
      return NextResponse.json(
        { success: false, error: snapshot.message, dataStatus: snapshot.status },
        { status: 503 }
      );
    }

    const read = buildInstitutionalRead(snapshot);
    if (!read) {
      return NextResponse.json(
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
    const engineWeights = recalculateEngineWeights(
      input.pastLearningRecords,
      input.tradingStyle,
      input.priorWeights
    );
    const killZone = getICTKillZoneStatus();
    // A calendar the app cannot actually see must not move the stop loss, so
    // an unconfigured or unreachable provider yields no events and no news
    // adjustment at all.
    const calendar = await getEconomicCalendar();
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
    } = { attempted: false, accepted: false, reasons: [] };

    const hasProviderKey = [
      process.env.GEMINI_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.ANTHROPIC_API_KEY,
      process.env.CLAUDE_API_KEY,
    ].some((k) => typeof k === 'string' && k.trim().length > 0);

    if (hasProviderKey) {
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
        proposalOutcome.reasons = [
          err instanceof Error ? `Provider error: ${err.message}` : 'Provider error.',
        ];
      }
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
    const anchorBucket = conditionalPerformance(input.pastLearningRecords).byAnchor.find(
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
      proposalRejected: proposalOutcome.attempted && !proposalOutcome.accepted,
      drawdownPercent,
      measuredEdgeR,
      rewardToRisk: decision.targetRiskReward,
    });
    // A quality floor the user set. Nothing on the chart being good enough is a
    // real answer, and a cheaper one than a bad trade: skipping costs nothing.
    // A band a backtest showed losing money in both halves of a period. This is
    // narrower than a floor on purpose: on this engine the lowest band has paid
    // the most, so refusing everything under a score throws away the good with
    // the bad.
    const dead = input.skipConvictionBand;
    if (
      dead &&
      conviction.convictionScore >= dead.min &&
      conviction.convictionScore < dead.max
    ) {
      return NextResponse.json({
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
        },
        dataStatus: snapshot.status,
      });
    }

    if (conviction.convictionScore < input.minConviction) {
      return NextResponse.json({
        success: true,
        setup: null,
        skipped: {
          reason: 'below-conviction',
          convictionScore: conviction.convictionScore,
          band: conviction.band,
          threshold: input.minConviction,
          direction: decision.direction,
          notes: conviction.notes,
          rationale: decision.rationale,
        },
        dataStatus: snapshot.status,
      });
    }

    const riskPercentUsed = effectiveRiskPercentage(input.riskPercentage, conviction.multiplier);

    // Sized from the order that will actually be placed, which may be the
    // model's proposal rather than the engine's own.
    const lotCalculation = calculateXAUUSDLotSize(
      input.equity,
      riskPercentUsed,
      finalOrder.entryPrice,
      finalOrder.stopLoss,
      input.accountType,
      input.tradingStyle,
      input.brokerId
    );

    const validity = computeValidity(input.tradingStyle, killZone.isHighVolatilityTiming);

    const spreadDollars = (lotCalculation.contractSpecs.typicalSpreadPips * 0.1) / 2;
    const bid = round2(marketPrice - spreadDollars);
    const ask = round2(marketPrice + spreadDollars);

    const symbolHint = input.accountType === 'Cent' ? 'XAUUSDc / GOLDc (Cent Account)' : 'XAUUSD (Gold vs US Dollar)';
    const specs = lotCalculation.contractSpecs;
    const styleProfile = STYLE_PROFILES[input.tradingStyle];

    const mt5Instructions = [
      `1. Open MetaTrader 5 on desktop or mobile.`,
      `2. Select symbol: [ ${symbolHint} ].`,
      `3. Order type: [ ${decision.orderType} ].`,
      lotCalculation.exceedsRiskBudget
        ? `4. Volume: [ ${lotCalculation.lotSize.toFixed(2)} ${specs.lotUnit} ]. WARNING: the broker minimum lot risks $${lotCalculation.actualRiskDollars.toFixed(
            2
          )}, which is ${((lotCalculation.actualRiskDollars / input.equity) * 100).toFixed(
            1
          )}% of your $${input.equity.toLocaleString('en-US')}, above the ${input.riskPercentage}% you asked for. Reduce the stop distance or raise the balance to respect the budget.`
        : `4. Volume: [ ${lotCalculation.lotSize.toFixed(2)} ${specs.lotUnit} ], sized to $${lotCalculation.actualRiskDollars.toFixed(
            2
          )} risk at ${input.riskPercentage}% of $${input.equity.toLocaleString('en-US')}.`,
      `5. Entry price: [ ${decision.entryPrice.toFixed(2)} ] (${decision.anchor}).`,
      `6. Stop loss: [ ${decision.stopLoss.toFixed(2)} ], ${decision.stopLossPips} pips away.`,
      `7. Targets: TP1 [ ${decision.takeProfit1.toFixed(2)} ] | TP2 [ ${decision.takeProfit2.toFixed(
        2
      )} ] | TP3 [ ${decision.takeProfit3.toFixed(2)} ].`,
      `8. Profile: ${styleProfile.label}. Entry sits ${decision.entryDistancePips} pips from the current price${
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
          drawdownPercent >= 10
            ? `${drawdownPercent}% below the account high water mark, so position size is reduced.`
            : drawdownPercent > 0
            ? `${drawdownPercent}% below the account high water mark, which is inside the band where size is left alone.`
            : 'Account at its high water mark, so no drawdown reduction applied.',
        used: true,
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
      entryAnchor: proposalOutcome.accepted ? 'Market' : decision.anchor,
      // Only the engine's own targets carry a basis; a model proposal that was
      // accepted replaced them, and saying otherwise would be a fabrication.
      targetBasis: proposalOutcome.accepted ? undefined : decision.targetBasis,
      targetsFellBack: proposalOutcome.accepted ? undefined : decision.targetsFellBack,
      entryDistancePips: priceToPipsDistance(marketPrice, finalOrder.entryPrice),
      stopLossPips: lotCalculation.stopLossPips,
      recommendedLotSize: lotCalculation.lotSize,
      riskDollarAmount: lotCalculation.riskDollars,
      actualRiskDollars: lotCalculation.actualRiskDollars,
      exceedsRiskBudget: lotCalculation.exceedsRiskBudget,
      riskPercentage: input.riskPercentage,
      effectiveRiskPercentage: riskPercentUsed,
      convictionMultiplier: conviction.multiplier,
      convictionScore: conviction.convictionScore,
      convictionBand: conviction.band,
      convictionNotes: conviction.notes,
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

    return NextResponse.json({
      success: true,
      setup: setupPayload,
      engineWeights,
      confidenceScore: decision.confidenceScore,
      conviction,
      validity,
      confluenceFactors: decision.factors,
      entryDistancePips: priceToPipsDistance(marketPrice, finalOrder.entryPrice),
      entryOutOfReach: decision.entryOutOfReach && !proposalOutcome.accepted,
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
    const errorMsg = err instanceof Error ? err.message : 'Institutional analysis engine error';
    return NextResponse.json({ success: false, error: errorMsg }, { status: 500 });
  }
}

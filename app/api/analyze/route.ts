import { NextResponse } from 'next/server';
import { executeGenerativeSynthesisWithProvider } from '@/lib/gen-engine';
import { calculateXAUUSDLotSize, getICTKillZoneStatus, recalculateEngineWeights } from '@/lib/market-engine';
import { getEconomicCalendar, filterUpcoming, minutesToNextHighImpact } from '@/lib/economic-calendar';
import { getMarketSnapshot } from '@/lib/price-feed';
import { buildInstitutionalRead } from '@/lib/analysis-pipeline';
import { buildSignal, maxEntryDistance, resolveOrderType, STYLE_PROFILES } from '@/lib/signal-engine';
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
import { InstitutionalTradingSetup, EngineGenerationMetadata } from '@/lib/types';
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
    const engineWeights = recalculateEngineWeights(input.pastLearningRecords, input.tradingStyle);
    const killZone = getICTKillZoneStatus();
    // A calendar the app cannot actually see must not move the stop loss, so
    // an unconfigured or unreachable provider yields no events and no news
    // adjustment at all.
    const calendar = await getEconomicCalendar();
    const economicEvents = filterUpcoming(calendar.events);
    const highImpact = economicEvents.filter((e) => e.impact === 'High');
    const minutesToNextEvent = minutesToNextHighImpact(calendar.events);

    // Deterministic, tested engine owns every price level.
    const decision = buildSignal({
      price: marketPrice,
      structures: read.multiTimeframe,
      indicators: read.indicators,
      weights: engineWeights,
      tradingStyle: input.tradingStyle,
      candles: read.executionCandles,
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

    // Sized from the order that will actually be placed, which may be the
    // model's proposal rather than the engine's own.
    const lotCalculation = calculateXAUUSDLotSize(
      input.equity,
      input.riskPercentage,
      finalOrder.entryPrice,
      finalOrder.stopLoss,
      input.accountType,
      input.tradingStyle,
      input.brokerId
    );

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
      stopLossPips: lotCalculation.stopLossPips,
      recommendedLotSize: lotCalculation.lotSize,
      riskDollarAmount: lotCalculation.riskDollars,
      actualRiskDollars: lotCalculation.actualRiskDollars,
      exceedsRiskBudget: lotCalculation.exceedsRiskBudget,
      riskPercentage: input.riskPercentage,
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
      institutionalRationale,
      executionInstructionsMT5: mt5Instructions,
      status: 'ACTIVE',
      engineMetadata,
      modelProposal: proposalOutcome,
    };

    return NextResponse.json({
      success: true,
      setup: setupPayload,
      engineWeights,
      confidenceScore: decision.confidenceScore,
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

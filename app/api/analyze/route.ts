import { NextResponse } from 'next/server';
import { executeGenerativeSynthesisWithProvider } from '@/lib/gen-engine';
import { calculateXAUUSDLotSize, getICTKillZoneStatus, recalculateEngineWeights } from '@/lib/market-engine';
import { getEconomicCalendar, filterUpcoming, minutesToNextHighImpact } from '@/lib/economic-calendar';
import { getMarketSnapshot } from '@/lib/price-feed';
import { buildInstitutionalRead } from '@/lib/analysis-pipeline';
import { buildSignal, STYLE_PROFILES } from '@/lib/signal-engine';
import { round2 } from '@/lib/candles';
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

    const lotCalculation = calculateXAUUSDLotSize(
      input.equity,
      input.riskPercentage,
      decision.entryPrice,
      decision.stopLoss,
      input.accountType,
      input.tradingStyle,
      input.brokerId
    );

    const spreadDollars = (lotCalculation.contractSpecs.typicalSpreadPips * 0.1) / 2;
    const bid = round2(marketPrice - spreadDollars);
    const ask = round2(marketPrice + spreadDollars);

    let institutionalRationale = decision.rationale;
    let engineMetadata: EngineGenerationMetadata = {
      provider: 'algorithmic',
      model: 'Structural SMC/ICT engine',
      isFallback: false,
      timestamp: new Date().toISOString(),
    };

    // The language model narrates the setup. It does not set prices, because
    // the structural engine is deterministic and covered by tests.
    const hasProviderKey = [
      process.env.GEMINI_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.ANTHROPIC_API_KEY,
      process.env.CLAUDE_API_KEY,
    ].some((k) => typeof k === 'string' && k.trim().length > 0);

    if (hasProviderKey) {
      const pastLessons = input.pastLearningRecords
        .slice(-8)
        .map(
          (rec, idx) =>
            `[${idx + 1}] Outcome ${rec.outcome}. Root cause: ${
              rec.rootCauseAnalysis?.primaryFactor ?? 'unrecorded'
            }. Lesson: ${rec.strategyEvolutionLesson}`
        )
        .join('\n');

      const factorLines = decision.factors
        .map((f) => `- ${f.name} (weight ${f.weight.toFixed(2)}, vote ${f.direction.toFixed(2)}): ${f.detail}`)
        .join('\n');

      const prompt = `You are a senior institutional trading strategist writing a desk note on XAUUSD.

A deterministic structural engine has already produced this order. Do not change any number.

Order: ${decision.orderType}
Entry ${decision.entryPrice.toFixed(2)}, stop ${decision.stopLoss.toFixed(2)}, targets ${decision.takeProfit1.toFixed(
        2
      )} / ${decision.takeProfit2.toFixed(2)} / ${decision.takeProfit3.toFixed(2)}
Risk distance ${decision.stopLossPips} pips, reward ratio ${decision.riskRewardRatio}
Entry anchored to: ${decision.anchor}
Weighted confluence score: ${decision.confidenceScore} out of 100

Market structure, all measured from live candles:
- D1 ${read.multiTimeframe.d1.trend}, H4 ${read.multiTimeframe.h4.trend}, H1 ${read.multiTimeframe.h1.trend}, M15 ${read.multiTimeframe.m15.trend}
- Wyckoff phase ${read.wyckoff.phase}, point of control ${read.wyckoff.pointOfControlPOC.toFixed(2)}
- Pricing zone ${read.multiTimeframe.h1.pricingZone}
- Session: ${killZone.currentZone}

Confluence factors and the weights the self learning engine currently assigns them:
${factorLines}

Lessons carried from previous trades:
${pastLessons || 'No resolved trades yet.'}

Write two short paragraphs of institutional prose explaining why this setup is valid, what would invalidate it, and how the lessons above shaped the current risk parameters. Reply with JSON only: {"rationale": string}`;

      try {
        const synth = await executeGenerativeSynthesisWithProvider(prompt, {
          responseMimeType: 'application/json',
        });
        if (synth?.text) {
          const parsed = JSON.parse(synth.text);
          if (typeof parsed.rationale === 'string' && parsed.rationale.trim().length > 0) {
            // Keep the engine's own summary line so the numbers stay traceable.
            institutionalRationale = `${parsed.rationale.trim()}\n\nEngine summary: ${decision.rationale}`;
            engineMetadata = {
              provider: synth.provider,
              model: synth.model,
              isFallback: synth.isFallback,
              switchReason: synth.switchReason,
              timestamp: new Date().toISOString(),
            };
          }
        }
      } catch {
        // The structural rationale already stands on its own.
      }
    }

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
      orderType: decision.orderType,
      entryPrice: decision.entryPrice,
      stopLoss: decision.stopLoss,
      takeProfit1: decision.takeProfit1,
      takeProfit2: decision.takeProfit2,
      takeProfit3: decision.takeProfit3,
      riskRewardRatio: decision.riskRewardRatio,
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
    };

    return NextResponse.json({
      success: true,
      setup: setupPayload,
      engineWeights,
      confidenceScore: decision.confidenceScore,
      confluenceFactors: decision.factors,
      entryDistancePips: decision.entryDistancePips,
      entryOutOfReach: decision.entryOutOfReach,
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

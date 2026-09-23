import { NextResponse } from 'next/server';
import { executeGenerativeSynthesis } from '@/lib/gen-engine';
import { SelfLearningMemoryRecord, TradeContext } from '@/lib/types';
import { validateLearnBody } from '@/lib/request-validation';
import { computeTradeResult } from '@/lib/trade-result';
import { publicErrorMessage } from '@/lib/safe-error';
import { sanitiseFactorVotes } from '@/lib/factor-learning';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Request body is not valid JSON.' }, { status: 400 });
  }

  const { value: input, errors } = validateLearnBody(rawBody);
  if (!input) {
    return NextResponse.json({ success: false, error: errors.join(' ') }, { status: 400 });
  }
  const { setup, outcome, closedPrice, missCause, autoResolved } = input;

  try {
    const isProfit = outcome === 'TP';
    const isMissed = outcome === 'MISSED';
    const priceDiff = Math.abs(closedPrice - setup.entryPrice);

    // Shared with the signal card's outcome buttons, so what the user is shown
    // before the click is exactly what gets recorded after it.
    const { pips: pipsResult, dollars: dollarResult } = computeTradeResult(setup, closedPrice, outcome);

    // Default institutional post-mortem, written from this trade's own numbers
    // so two records never read identically. The previous version emitted the
    // same three sentences for every missed order.
    const distancePips = parseFloat((priceDiff * 10).toFixed(1));
    const plannedRiskPips = parseFloat((Math.abs(setup.entryPrice - setup.stopLoss) * 10).toFixed(1));
    const riskShare = plannedRiskPips > 0 ? distancePips / plannedRiskPips : 0;

    let primaryFactor = isProfit
      ? `Target delivered ${distancePips} pips from entry`
      : isMissed
      ? // The engine knows which of the three ways it missed, and they teach
        // different lessons, so the recorded cause is specific.
        missCause ?? `Pending order never filled, price held ${distancePips} pips away`
      : `Stop taken ${distancePips} pips against entry`;

    let institutionalFlowExplanation = isProfit
      ? `Entry at ${setup.entryPrice.toFixed(2)} was defended and price expanded ${distancePips} pips to ${closedPrice.toFixed(
          2
        )}, delivering ${riskShare.toFixed(2)} times the ${plannedRiskPips} pip risk that was committed.`
      : isMissed
      ? `Price turned ${distancePips} pips short of the resting order at ${setup.entryPrice.toFixed(
          2
        )}, reversing from ${closedPrice.toFixed(2)} without offering the fill. The level was read correctly; the entry simply sat deeper than the market was willing to retrace.`
      : `Price traded through the ${plannedRiskPips} pip invalidation at ${setup.stopLoss.toFixed(
          2
        )}, closing the position at ${closedPrice.toFixed(2)}. The structural level failed to hold on this attempt.`;

    let liquidityBehavior = isProfit
      ? `Opposing liquidity was cleared and the move ran ${distancePips} pips without reclaiming the entry zone.`
      : isMissed
      ? `Buyers stepped in ${distancePips} pips above the order, so the deeper pool went untouched.`
      : `The sweep extended past the planned ${plannedRiskPips} pip buffer before any reversal developed.`;

    let strategyEvolutionLesson = isProfit
      ? `The ${setup.tradingStyle || 'Intraday'} entry was placed correctly on a ${setup.accountType || 'Standard'} account. Keep the ${plannedRiskPips} pip invalidation and the current entry depth.`
      : isMissed
      ? `Place the next ${setup.tradingStyle || 'Intraday'} entry roughly ${Math.ceil(
          distancePips * 0.75
        )} pips shallower, or take the fill at market when momentum is already in the intended direction.`
      : `Widen the ${setup.tradingStyle || 'Intraday'} invalidation beyond ${plannedRiskPips} pips, or wait for the level to be confirmed before committing risk.`;

    let fvgWeightDelta = isProfit ? 0.02 : isMissed ? 0.03 : -0.01;
    let orderBlockWeightDelta = isProfit ? 0.02 : isMissed ? -0.01 : 0.01;
    let newsFilterWeightDelta = isProfit ? 0.01 : isMissed ? 0.01 : 0.03;
    let atrBufferMultiplier = isProfit ? 1.0 : isMissed ? 1.0 : 1.15;

    // Utilize generative model with automatic failover (Gemini -> OpenAI -> Claude)
    const hasAnyProviderKey = Boolean(
      (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0) ||
      (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0) ||
      (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim().length > 0) ||
      (process.env.CLAUDE_API_KEY && process.env.CLAUDE_API_KEY.trim().length > 0)
    );

    if (hasAnyProviderKey) {
      try {
        const prompt = `You are the Lead Quantitative Risk Architect and Algorithmic Trading Systems Evaluator for XAUUSD (Gold).
A trade was completed with outcome: ${outcome} (Closed Price: ${closedPrice.toFixed(2)}, Entry: ${setup.entryPrice.toFixed(2)}, Stop Loss: ${setup.stopLoss.toFixed(2)}, Order: ${setup.orderType}).
Setup Context:
- Trading Style: ${setup.tradingStyle || 'Intraday'}
- Account Type: ${setup.accountType || 'Standard'}
- Methodologies Used: SMC (BOS, CHoCH, Order Block, FVG, Liquidity sweeps), ICT Kill Zones (${setup.killZoneStatus?.currentZone ?? 'unrecorded'}), Wyckoff Phase (${setup.wyckoffVsa?.phase ?? 'unrecorded'}), EMA 50/200, RSI, Stochastic, Forex Factory News.
- Rationale when entered: ${setup.institutionalRationale ?? 'not recorded'}

IMPORTANT RULES:
- DO NOT use the two-letter word "A" followed by "I" anywhere in your text.
- Write in English with rigorous institutional finance vocabulary.
- Perform a deep post-mortem diagnostic:
  1. What exact institutional flow or order book behavior caused this ${outcome} within ${setup.tradingStyle || 'Intraday'} execution dynamics?
  2. What is the concrete strategic adaptation rule that the trading engine must incorporate into future predictive models for ${setup.tradingStyle || 'Intraday'} and ${setup.accountType || 'Standard'} account to enhance long-term win rate and expectancy?

Respond strictly in valid JSON format:
{
  "primaryFactor": string,
  "institutionalFlowExplanation": string,
  "liquidityBehavior": string,
  "strategyEvolutionLesson": string,
  "fvgWeightDelta": number, // between -0.03 and 0.03
  "orderBlockWeightDelta": number, // between -0.03 and 0.03
  "newsFilterWeightDelta": number, // between 0.0 and 0.05
  "atrBufferMultiplier": number // between 1.0 and 1.25
}`;

        const raw = await executeGenerativeSynthesis(prompt, {
          responseMimeType: 'application/json',
        });

        if (raw) {
          const parsed = JSON.parse(raw);
          // Prose is taken as written; numbers are not. The prompt states the
          // ranges, but a model is free to ignore a prompt, and a value stored
          // here is a value some future reader may act on.
          const clamp = (value: unknown, low: number, high: number, fallback: number) =>
            typeof value === 'number' && Number.isFinite(value)
              ? Math.max(low, Math.min(high, value))
              : fallback;

          if (parsed.primaryFactor) primaryFactor = String(parsed.primaryFactor);
          if (parsed.institutionalFlowExplanation) {
            institutionalFlowExplanation = String(parsed.institutionalFlowExplanation);
          }
          if (parsed.liquidityBehavior) liquidityBehavior = String(parsed.liquidityBehavior);
          if (parsed.strategyEvolutionLesson) strategyEvolutionLesson = String(parsed.strategyEvolutionLesson);
          fvgWeightDelta = clamp(parsed.fvgWeightDelta, -0.03, 0.03, fvgWeightDelta);
          orderBlockWeightDelta = clamp(parsed.orderBlockWeightDelta, -0.03, 0.03, orderBlockWeightDelta);
          newsFilterWeightDelta = clamp(parsed.newsFilterWeightDelta, 0, 0.05, newsFilterWeightDelta);
          atrBufferMultiplier = clamp(parsed.atrBufferMultiplier, 1, 1.25, atrBufferMultiplier);
        }
      } catch {
        // Fallback already defaults to algorithmic institutional evaluation
      }
    }

    // What the setup looked like when it was produced. Recorded with the
    // result so the engine can learn which kinds of setup pay rather than only
    // how often it wins overall.
    const riskDistance = Math.abs(setup.entryPrice - setup.stopLoss);
    const factorVotes = sanitiseFactorVotes(setup.factorVotes);
    const context: TradeContext = {
      anchor: setup.entryAnchor ?? 'Market',
      convictionScore: setup.convictionScore ?? 0,
      session: setup.killZoneStatus?.currentZone ?? 'Off-Hours',
      killZoneActive: Boolean(setup.killZoneStatus?.isHighVolatilityTiming),
      // Alignment means three timeframes that are present and agree. A setup
      // recorded without its structure read as "aligned", because a set of
      // three undefined values has one member and undefined is not 'Ranging',
      // which quietly filled the conditional learning table with agreement
      // that was never measured.
      timeframesAligned: (() => {
        const trends = [
          setup.multiTimeframeAlignment?.d1?.trend,
          setup.multiTimeframeAlignment?.h4?.trend,
          setup.multiTimeframeAlignment?.h1?.trend,
        ];
        if (trends.some((trend) => trend === undefined || trend === null)) return false;
        return new Set(trends).size === 1 && trends[0] !== 'Ranging';
      })(),
      newsNearby: (setup.economicEvents ?? []).some((event) => {
        if (event.impact !== 'High') return false;
        const at = Date.parse(event.scheduledTimestamp ?? '');
        if (!Number.isFinite(at)) return false;
        const minutes = (at - Date.parse(setup.timestamp)) / 60_000;
        return minutes >= 0 && minutes <= 60;
      }),
      entryDistancePips: setup.entryDistancePips ?? 0,
      stopLossPips: setup.stopLossPips,
      // Risk measured on the trade's own stop, so a wide and a tight stop can
      // be compared to each other at all.
      rMultiple:
        riskDistance > 0 && !isMissed
          ? parseFloat(((Math.abs(closedPrice - setup.entryPrice) / riskDistance) * (isProfit ? 1 : -1)).toFixed(2))
          : 0,
      // Only present when the setup carried them. Firestore refuses an
      // undefined field, so an absent map is left out rather than written.
      ...(factorVotes ? { factorVotes } : {}),
    };

    const learningRecord: SelfLearningMemoryRecord = {
      id: 'learn_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      analysisId: setup.id,
      // When the row was written, which is when the trade ended.
      timestamp: new Date().toISOString(),
      // When it began. The two are the same only for a trade that closed
      // instantly, and an audit needs the beginning.
      placedAt: setup.timestamp,
      outcome,
      symbol: 'XAUUSD',
      orderType: setup.orderType,
      entryPrice: setup.entryPrice,
      exitPrice: closedPrice,
      profitOrLossPips: pipsResult,
      profitOrLossDollars: dollarResult,
      rootCauseAnalysis: {
        primaryFactor,
        institutionalFlowExplanation,
        liquidityBehavior,
      },
      strategyEvolutionLesson,
      tradingStyle: setup.tradingStyle,
      autoResolved,
      context,
      adaptiveWeightAdjustments: {
        fvgWeightDelta,
        orderBlockWeightDelta,
        newsFilterWeightDelta,
        atrBufferMultiplier,
      },
    };

    return NextResponse.json({
      success: true,
      learningRecord,
    });
  } catch (err: unknown) {
    console.error('Learning evaluation error:', err);
    return NextResponse.json(
      {
        success: false,
        error: publicErrorMessage(err, 'The trade could not be evaluated right now.'),
      },
      { status: 500 }
    );
  }
}

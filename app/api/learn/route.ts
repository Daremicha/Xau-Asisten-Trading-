import { NextResponse } from 'next/server';
import { executeGenerativeSynthesis } from '@/lib/gen-engine';
import { InstitutionalTradingSetup, SelfLearningMemoryRecord } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { setup, outcome, closedPrice }: { setup: InstitutionalTradingSetup; outcome: 'TP' | 'SL' | 'MISSED'; closedPrice: number } = body;

    if (!setup || !outcome) {
      return NextResponse.json({ success: false, error: 'Missing setup or outcome' }, { status: 400 });
    }

    const isProfit = outcome === 'TP';
    const isMissed = outcome === 'MISSED';
    const priceDiff = Math.abs(closedPrice - setup.entryPrice);
    const pipsDiff = parseFloat((priceDiff * 10).toFixed(1));

    // Account-aware P&L calculation (Zero P&L for missed trades since order was not filled)
    const contractMultiplier = setup.accountType === 'Cent' || setup.contractSpecs?.contractSizeOz === 1 ? 1 : 100;
    let grossResult = isMissed
      ? 0
      : setup.recommendedLotSize * contractMultiplier * priceDiff * (isProfit ? 1 : -1);
    if (setup.accountType === 'Pro' && !isMissed) {
      const commissionCost = (setup.contractSpecs?.commissionPerLot || 6.0) * setup.recommendedLotSize;
      grossResult -= commissionCost;
    }
    const dollarResult = parseFloat(grossResult.toFixed(2));

    // Default institutional post-mortem evaluation
    let primaryFactor = isProfit
      ? 'Institutional Liquidity Expansion'
      : isMissed
      ? 'Pending Order Missed: Shallow FVG Mitigation & Price Runaway'
      : 'Stop Hunt & Deeper Liquidity Swept Prior to Reversal';

    let institutionalFlowExplanation = isProfit
      ? `The institutional order block at ${setup.entryPrice.toFixed(2)} held firmly as large smart money participants defended their unfilled orders. Fair Value Gap (FVG) served as a strong institutional magnet, resulting in rapid mitigation and expansion towards target liquidity at ${closedPrice.toFixed(2)}.`
      : isMissed
      ? `Market price reversed at the 50% Fair Value Gap mean threshold without dipping deeply enough to pick up the resting pending limit order at ${setup.entryPrice.toFixed(2)}. Aggressive institutional momentum pushed price directly towards target liquidity without full OB mitigation.`
      : `Market swept liquidity below the identified Order Block to capitalize on concentrated retail stop loss orders. The high-timeframe liquidity pool was deeper than anticipated, resulting in stop out at ${closedPrice.toFixed(2)} before the genuine institutional move crystallized.`;

    let liquidityBehavior = isProfit
      ? 'Clean sweep of opposing Asian session liquidity followed by decisive institutional displacement.'
      : isMissed
      ? 'Front-running liquidity injection: Buyers/Sellers stepped in early at the discount boundary before filling deep book orders.'
      : 'Judas swing extended past standard 1.25x ATR volatility envelope during active session.';

    let strategyEvolutionLesson = isProfit
      ? `Reinforce confluence weight for ${setup.tradingStyle || 'Intraday'} setups that align with Kill Zones and unmitigated FVGs on ${setup.accountType || 'Standard'} account. Maintain 1:${setup.riskRewardRatio.replace('1:', '')} execution discipline.`
      : isMissed
      ? `Calibrate pending limit buffer: Shift entry placement to the 50% FVG Consequent Encroachment (CE) level rather than the extreme OB boundary, or consider instant market execution when momentum divergence is strong.`
      : `Refine ${setup.tradingStyle || 'Intraday'} entry criteria: Mandate strict structural confirmation prior to order trigger, and widen stop loss buffer by 15% to clear broker spread spikes.`;

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
- Methodologies Used: SMC (BOS, CHoCH, Order Block, FVG, Liquidity sweeps), ICT Kill Zones (${setup.killZoneStatus.currentZone}), Wyckoff Phase (${setup.wyckoffVsa.phase}), EMA 50/200, RSI, Stochastic, Forex Factory News.
- Rationale when entered: ${setup.institutionalRationale}

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
          primaryModel: 'gemini-3.8-flash',
          fallbackModel: 'gemini-flash-latest',
        });

        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.primaryFactor) primaryFactor = parsed.primaryFactor;
          if (parsed.institutionalFlowExplanation) institutionalFlowExplanation = parsed.institutionalFlowExplanation;
          if (parsed.liquidityBehavior) liquidityBehavior = parsed.liquidityBehavior;
          if (parsed.strategyEvolutionLesson) strategyEvolutionLesson = parsed.strategyEvolutionLesson;
          if (typeof parsed.fvgWeightDelta === 'number') fvgWeightDelta = parsed.fvgWeightDelta;
          if (typeof parsed.orderBlockWeightDelta === 'number') orderBlockWeightDelta = parsed.orderBlockWeightDelta;
          if (typeof parsed.newsFilterWeightDelta === 'number') newsFilterWeightDelta = parsed.newsFilterWeightDelta;
          if (typeof parsed.atrBufferMultiplier === 'number') atrBufferMultiplier = parsed.atrBufferMultiplier;
        }
      } catch {
        // Fallback already defaults to algorithmic institutional evaluation
      }
    }

    const learningRecord: SelfLearningMemoryRecord = {
      id: 'learn_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      analysisId: setup.id,
      timestamp: new Date().toISOString(),
      outcome,
      symbol: 'XAUUSD',
      orderType: setup.orderType,
      entryPrice: setup.entryPrice,
      exitPrice: closedPrice,
      profitOrLossPips: isProfit ? pipsDiff : -pipsDiff,
      profitOrLossDollars: dollarResult,
      rootCauseAnalysis: {
        primaryFactor,
        institutionalFlowExplanation,
        liquidityBehavior,
      },
      strategyEvolutionLesson,
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
    const errorMsg = err instanceof Error ? err.message : 'Learning evaluation error';
    return NextResponse.json({ success: false, error: errorMsg }, { status: 500 });
  }
}

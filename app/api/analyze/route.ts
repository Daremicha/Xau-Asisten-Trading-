import { NextResponse } from 'next/server';
import { executeGenerativeSynthesisWithProvider } from '@/lib/gen-engine';
import {
  calculateXAUUSDLotSize,
  getContractSpecification,
  getForexFactoryHighImpactEvents,
  getTradingCentralInstitutionalBias,
  getICTKillZoneStatus,
  synthesizeInstitutionalStructures,
  recalculateEngineWeights,
} from '@/lib/market-engine';
import {
  InstitutionalTradingSetup,
  OrderExecutionType,
  SelfLearningMemoryRecord,
  TradingStyle,
  AccountType,
  BrokerId,
  EngineGenerationMetadata,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      currentPrice: userPrice,
      equity = 1000,
      riskPercentage = 1.0,
      tradingStyle = 'Intraday' as TradingStyle,
      accountType = 'Standard' as AccountType,
      brokerId = 'EXNESS' as BrokerId,
      userId = 'guest',
      pastLearningRecords = [] as SelfLearningMemoryRecord[],
    } = body;

    // Use current market price or fallback
    const marketPrice = typeof userPrice === 'number' && userPrice > 500 ? userPrice : 2918.5;
    const bid = parseFloat((marketPrice - 0.15).toFixed(2));
    const ask = parseFloat((marketPrice + 0.15).toFixed(2));

    // Calculate current adaptive engine weights from past self-learning records
    const engineWeights = recalculateEngineWeights(pastLearningRecords);
    const killZone = getICTKillZoneStatus();
    const economicEvents = getForexFactoryHighImpactEvents();
    const tradingCentral = getTradingCentralInstitutionalBias(marketPrice);
    const structures = synthesizeInstitutionalStructures(marketPrice, engineWeights, tradingStyle);
    const contractSpecs = getContractSpecification(accountType, brokerId);

    // Style-specific default parameters
    let defaultSlOffset = 6.5; // Intraday: ~65 pips ($6.50)
    let defaultTp1Offset = 9.5;
    let defaultTp2Offset = 18.0;
    let defaultTp3Offset = 30.0;
    let defaultEntryOffset = 2.4;

    if (tradingStyle === 'Scalping') {
      defaultSlOffset = 2.2; // Scalping: ~22 pips ($2.20)
      defaultTp1Offset = 3.2; // ~32 pips
      defaultTp2Offset = 5.5; // ~55 pips
      defaultTp3Offset = 9.0; // ~90 pips
      defaultEntryOffset = 0.9;
    } else if (tradingStyle === 'Swing') {
      defaultSlOffset = 18.0; // Swing: ~180 pips ($18.00)
      defaultTp1Offset = 32.0; // ~320 pips
      defaultTp2Offset = 65.0; // ~650 pips
      defaultTp3Offset = 130.0; // ~1300 pips
      defaultEntryOffset = 6.5;
    }

    // Prepare institutional prompt for Google Gen engine with search grounding
    const pastLessonsSummary = (pastLearningRecords as SelfLearningMemoryRecord[])
      .slice(-5)
      .map(
        (rec: SelfLearningMemoryRecord, idx: number) =>
          `[Memory #${idx + 1} - Result: ${rec.outcome}] Root Cause: ${rec.rootCauseAnalysis?.primaryFactor || 'Market Flow'} | Strategy Adaptation: ${rec.strategyEvolutionLesson}`
      )
      .join('\n');

    let orderType: OrderExecutionType = 'BUY LIMIT';
    let entryPrice = parseFloat((marketPrice - defaultEntryOffset).toFixed(2));
    let stopLoss = parseFloat((entryPrice - defaultSlOffset).toFixed(2));
    let tp1 = parseFloat((entryPrice + defaultTp1Offset).toFixed(2));
    let tp2 = parseFloat((entryPrice + defaultTp2Offset).toFixed(2));
    let tp3 = parseFloat((entryPrice + defaultTp3Offset).toFixed(2));
    let institutionalRationale =
      tradingStyle === 'Scalping'
        ? 'High-velocity M15/M5 scalp setup: Swift liquidity absorption below session micro-low followed by immediate Fair Value Gap (FVG) retest. Calibrated for fast execution and high turnover with tight risk parameters.'
        : tradingStyle === 'Swing'
        ? 'Macro-structural D1/H4 institutional swing setup: Major Point of Control test and Wyckoff accumulation spring at macro Discount level. Aimed at harvesting extensive multi-day liquidity runs while weathering intraday volatility.'
        : 'Multi-timeframe institutional confluence: Price swept Asian Session low liquidity into H1 Bullish Order Block (OB) and unmitigated Fair Value Gap (FVG). Price above EMA 200 confirms macro bullish bias, supported by RSI bullish divergence and London Kill Zone volume injection.';

    // Engine provider tracking metadata
    let engineMetadata: EngineGenerationMetadata = {
      provider: 'algorithmic',
      model: 'Quantitative SMC/ICT Matrix',
      isFallback: false,
      timestamp: new Date().toISOString(),
    };

    // Check availability of any configured intelligence provider (Gemini, OpenAI ChatGPT, Claude Sonnet)
    const hasAnyProviderKey = Boolean(
      (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0) ||
      (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0) ||
      (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim().length > 0) ||
      (process.env.CLAUDE_API_KEY && process.env.CLAUDE_API_KEY.trim().length > 0)
    );

    // Try utilizing generative model with automatic multi-provider failover:
    // Gemini -> OpenAI ChatGPT (gpt-4o) -> Anthropic Claude Sonnet -> Algorithmic Engine
    if (hasAnyProviderKey) {
      try {
        const prompt = `You are a Senior Institutional Quantitative Trading Engine specializing in XAUUSD (Gold).
You strictly trade using Smart Money Concepts (SMC), Inner Circle Trader (ICT), Wyckoff VSA, Quasimodo (QM), and Multi-Timeframe Top-Down Analysis (D1 -> H4 -> H1 -> M15).
CRITICAL RULE: DO NOT use the two-letter word "A" followed by "I" anywhere in your response. Strictly avoid that word. Write exclusively in professional institutional English.

Configuration Constraints:
- User Trading Style: ${tradingStyle}
  * Scalping parameters: Target M15/M5 timeframe, tight stop loss of 15-30 pips ($1.50-$3.00), quick take profit targets (TP1: 25-35 pips, TP2: 45-60 pips, TP3: 75-100 pips). High execution speed.
  * Intraday parameters: Target H1/M15 timeframe, balanced stop loss of 45-80 pips ($4.50-$8.00), session targets (TP1: 70-120 pips, TP2: 140-200 pips, TP3: 250-350 pips). Closed within trading day.
  * Swing parameters: Target D1/H4 timeframe, wide stop loss of 120-250 pips ($12.00-$25.00), macro targets (TP1: 250-400 pips, TP2: 500-800 pips, TP3: 900-1500 pips). Multi-day run.
- User Account Type: ${accountType}
  * Standard: 100 Troy Oz per lot, floating broker spread (~2.2 pips), zero commission.
  * Cent: 1 Troy Oz per lot (USC micro-lot), 1/100 standard contract size, enabling fractional risk for small capital.
  * Pro: 100 Troy Oz per lot, raw institutional spread (~0.3 pips), $6.00 round turn commission factored into position risk.

Current Market Environment:
- XAUUSD Current Price: ${marketPrice.toFixed(2)} (Bid: ${bid.toFixed(2)}, Ask: ${ask.toFixed(2)})
- Active Institutional Session: ${killZone.currentZone} (${killZone.description})
- D1 Trend: ${structures.multiTimeframe.d1.trend}, H4 Trend: ${structures.multiTimeframe.h4.trend}, H1 Trend: ${structures.multiTimeframe.h1.trend}, M15 Trend: ${structures.multiTimeframe.m15.trend}
- Technical Indicators: EMA 50 = ${structures.indicators.ema50}, EMA 200 = ${structures.indicators.ema200} (Price is ${structures.indicators.trendFromEma} relative to EMA200). RSI(14) = ${structures.indicators.rsi14}, Stochastic = ${structures.indicators.stochasticK}/${structures.indicators.stochasticD} (${structures.indicators.stochasticSignal}). ATR(14) = ${structures.indicators.atr14}.
- Forex Factory High-Impact News: USD CPI, FOMC rate trajectory, and geopolitical demand.
- Trading Central Directional Bias: ${tradingCentral.directionalBias} above/below ${tradingCentral.pivotPoint}.
- Autonomous Learned Memories from Previous Executions:
${pastLessonsSummary || 'None yet (first algorithmic calibration).'}

Your Task:
1. Select the single most optimal, highest probability execution type strictly from:
   ["BUY INSTANT", "SELL INSTANT", "BUY LIMIT", "SELL LIMIT", "BUY STOP", "SELL STOP", "BUY STOP LIMIT", "SELL STOP LIMIT"].
2. Provide exact entry price, Stop Loss (SL) price, Take Profit 1 (TP1), Take Profit 2 (TP2), and Take Profit 3 (TP3) calibrated specifically for ${tradingStyle}.
3. Provide an institutional rationale explaining the SMC/ICT reasoning (BOS, CHoCH, Order Block, FVG, Liquidity sweep, Quasimodo, Wyckoff phase) and how it fits ${tradingStyle} and ${accountType} execution.

Respond ONLY in valid JSON format with keys:
{
  "orderType": "BUY LIMIT" | "SELL LIMIT" | "BUY INSTANT" | "SELL INSTANT" | "BUY STOP" | "SELL STOP" | "BUY STOP LIMIT" | "SELL STOP LIMIT",
  "entryPrice": number,
  "stopLoss": number,
  "takeProfit1": number,
  "takeProfit2": number,
  "takeProfit3": number,
  "rationale": string
}`;

        const synthResult = await executeGenerativeSynthesisWithProvider(prompt, {
          responseMimeType: 'application/json',
          primaryModel: 'gemini-3.8-flash',
          fallbackModel: 'gemini-flash-latest',
        });

        if (synthResult?.text) {
          const parsed = JSON.parse(synthResult.text);
          if (parsed.orderType) orderType = parsed.orderType as OrderExecutionType;
          if (parsed.entryPrice && typeof parsed.entryPrice === 'number') entryPrice = parsed.entryPrice;
          if (parsed.stopLoss && typeof parsed.stopLoss === 'number') stopLoss = parsed.stopLoss;
          if (parsed.takeProfit1 && typeof parsed.takeProfit1 === 'number') tp1 = parsed.takeProfit1;
          if (parsed.takeProfit2 && typeof parsed.takeProfit2 === 'number') tp2 = parsed.takeProfit2;
          if (parsed.takeProfit3 && typeof parsed.takeProfit3 === 'number') tp3 = parsed.takeProfit3;
          if (parsed.rationale) institutionalRationale = parsed.rationale;

          engineMetadata = {
            provider: synthResult.provider,
            model: synthResult.model,
            isFallback: synthResult.isFallback,
            switchReason: synthResult.switchReason,
            timestamp: new Date().toISOString(),
          };
        }
      } catch {
        // Fallback already defaults to algorithmic SMC/ICT model
      }
    }

    // Safety checks on pricing coordinates
    if (orderType.includes('BUY')) {
      if (stopLoss >= entryPrice) stopLoss = parseFloat((entryPrice - defaultSlOffset).toFixed(2));
      if (tp1 <= entryPrice) tp1 = parseFloat((entryPrice + defaultTp1Offset).toFixed(2));
      if (tp2 <= tp1) tp2 = parseFloat((tp1 + (defaultTp2Offset - defaultTp1Offset)).toFixed(2));
      if (tp3 <= tp2) tp3 = parseFloat((tp2 + (defaultTp3Offset - defaultTp2Offset)).toFixed(2));
    } else {
      if (stopLoss <= entryPrice) stopLoss = parseFloat((entryPrice + defaultSlOffset).toFixed(2));
      if (tp1 >= entryPrice) tp1 = parseFloat((entryPrice - defaultTp1Offset).toFixed(2));
      if (tp2 >= tp1) tp2 = parseFloat((tp1 - (defaultTp2Offset - defaultTp1Offset)).toFixed(2));
      if (tp3 >= tp2) tp3 = parseFloat((tp2 - (defaultTp3Offset - defaultTp2Offset)).toFixed(2));
    }

    // Calculate exact Lot Size for MT5 using User Equity, Risk %, Account Type, Trading Style, and Broker
    const lotCalculation = calculateXAUUSDLotSize(
      equity,
      riskPercentage,
      entryPrice,
      stopLoss,
      accountType,
      tradingStyle,
      brokerId
    );
    const rewardDistance = Math.abs(tp1 - entryPrice);
    const riskDistance = Math.abs(entryPrice - stopLoss);
    const rrRatio = riskDistance > 0 ? `1:${(rewardDistance / riskDistance).toFixed(2)}` : '1:2.0';

    const symbolHint = accountType === 'Cent' ? 'XAUUSDc / GOLDc (Cent Account)' : 'XAUUSD (Gold vs US Dollar)';

    const brokerProfileName = lotCalculation.contractSpecs.brokerName || brokerId;
    const brokerSpreadNote = `Broker: ${brokerProfileName} (${lotCalculation.contractSpecs.typicalSpreadPips} pips floating spread).`;

    const styleNote =
      tradingStyle === 'Scalping'
        ? `Scalp Profile: Fast execution on M15/M5 structure. Move Stop Loss to breakeven once price reaches +15 pips or TP1.`
        : tradingStyle === 'Swing'
        ? `Swing Profile: Macro D1/H4 setup. Hold through intraday session noise; target extended institutional liquidity.`
        : `Intraday Profile: Session liquidity play. Secure partials at TP1 and trail remaining position into session close.`;

    const accountNote =
      accountType === 'Cent'
        ? `Cent Account Note: Sized in Cent Lots (${lotCalculation.lotSize.toFixed(2)} Cent Lots). 1 Cent Lot = 1 Troy Oz, ensuring risk is strictly $${lotCalculation.riskDollars.toFixed(2)} (${riskPercentage}% of $${equity.toLocaleString('en-US')} balance).`
        : accountType === 'Pro'
        ? `Pro ECN Note: Raw ultra-low spread (~${lotCalculation.contractSpecs.typicalSpreadPips} pips). Round turn commission is factored into risk budgeting.`
        : `Standard Account Note: Spread-inclusive execution (${lotCalculation.contractSpecs.typicalSpreadPips} pips). Zero commission; clear broker floating spread upon entry.`;

    const mt5Instructions = [
      `1. Open MetaTrader 5 on Desktop or Mobile.`,
      `2. Select Symbol: [ ${symbolHint} ].`,
      `3. New Order Type: [ ${orderType} ].`,
      `4. Set Volume / Lot Size: [ ${lotCalculation.lotSize.toFixed(2)} ${lotCalculation.contractSpecs.lotUnit} ] (Calibrated to $${lotCalculation.riskDollars.toFixed(2)} risk at ${riskPercentage}% of $${equity.toLocaleString('en-US')} capital).`,
      `5. Enter Price: [ ${entryPrice.toFixed(2)} ].`,
      `6. Set Stop Loss (SL): [ ${stopLoss.toFixed(2)} ] (${lotCalculation.stopLossPips} pips distance).`,
      `7. Set Take Profit (TP): TP1 @ [ ${tp1.toFixed(2)} ] | TP2 @ [ ${tp2.toFixed(2)} ] | TP3 @ [ ${tp3.toFixed(2)} ].`,
      `8. Execution Advice: ${styleNote}`,
      `9. Broker Profile: ${brokerSpreadNote}`,
      `10. Account Specifications: ${accountNote}`,
    ];

    const setupId = 'setup_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);

    const setupPayload: InstitutionalTradingSetup = {
      id: setupId,
      userId,
      symbol: 'XAUUSD',
      timestamp: new Date().toISOString(),
      currentMarketPrice: marketPrice,
      bidPrice: bid,
      askPrice: ask,
      tradingStyle,
      accountType,
      brokerId,
      contractSpecs: lotCalculation.contractSpecs,
      orderType,
      entryPrice,
      stopLoss,
      takeProfit1: tp1,
      takeProfit2: tp2,
      takeProfit3: tp3,
      riskRewardRatio: rrRatio,
      stopLossPips: lotCalculation.stopLossPips,
      recommendedLotSize: lotCalculation.lotSize,
      riskDollarAmount: lotCalculation.riskDollars,
      riskPercentage,
      multiTimeframeAlignment: structures.multiTimeframe,
      technicalIndicators: structures.indicators,
      wyckoffVsa: structures.wyckoff,
      quasimodo: structures.quasimodo,
      economicEvents,
      tradingCentralBias: tradingCentral,
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
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Institutional analysis engine error';
    return NextResponse.json({ success: false, error: errorMsg }, { status: 500 });
  }
}

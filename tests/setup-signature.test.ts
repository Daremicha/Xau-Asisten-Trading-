import { describe, expect, test } from 'bun:test';
import { signSetup, verifySetupSignature } from '../lib/setup-signature';
import type { InstitutionalTradingSetup } from '../lib/types';

const setup = {
  id: 'setup_test', userId: 'u1', symbol: 'XAUUSD', timestamp: '2026-01-01T00:00:00.000Z',
  currentMarketPrice: 3000, bidPrice: 2999.9, askPrice: 3000.1, tradingStyle: 'Intraday', accountType: 'Standard',
  brokerId: 'EXNESS', contractSpecs: {} as InstitutionalTradingSetup['contractSpecs'], orderType: 'BUY LIMIT',
  entryPrice: 2998, stopLoss: 2995, takeProfit1: 3004, takeProfit2: 3008, takeProfit3: 3012, riskRewardRatio: '1:2',
  stopLossPips: 30, recommendedLotSize: 0.01, riskDollarAmount: 3, riskPercentage: 0.5,
  multiTimeframeAlignment: {} as InstitutionalTradingSetup['multiTimeframeAlignment'], technicalIndicators: {} as InstitutionalTradingSetup['technicalIndicators'],
  wyckoffVsa: {} as InstitutionalTradingSetup['wyckoffVsa'], quasimodo: {} as InstitutionalTradingSetup['quasimodo'], economicEvents: [],
  tradingCentralBias: {} as InstitutionalTradingSetup['tradingCentralBias'], killZoneStatus: { currentZone: 'London Open', isHighVolatilityTiming: false },
  institutionalRationale: '', executionInstructionsMT5: [], status: 'PENDING', engineMetadata: { provider: 'algorithmic', model: 'test', isFallback: false, timestamp: '2026-01-01T00:00:00.000Z' }, modelProposal: { attempted: false, accepted: false, reasons: [] },
} as InstitutionalTradingSetup;

describe('setup signature', () => {
  test('development mode accepts unsigned legacy setup and signed setup verifies', () => {
    const previous = process.env.SETUP_SIGNING_SECRET;
    process.env.SETUP_SIGNING_SECRET = 'test-secret';
    const signature = signSetup(setup);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(verifySetupSignature({ ...setup, setupSignature: signature })).toBe(true);
    expect(verifySetupSignature({ ...setup, setupSignature: `${signature!.slice(0, -1)}0` })).toBe(false);
    if (previous === undefined) delete process.env.SETUP_SIGNING_SECRET;
    else process.env.SETUP_SIGNING_SECRET = previous;
  });
});

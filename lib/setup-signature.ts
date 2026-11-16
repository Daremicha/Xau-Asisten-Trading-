import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InstitutionalTradingSetup } from './types';

function secret(): string | null {
  const value = process.env.SETUP_SIGNING_SECRET?.trim();
  return value ? value : null;
}

function payload(setup: InstitutionalTradingSetup): string {
  return JSON.stringify({
    id: setup.id, userId: setup.userId, timestamp: setup.timestamp, symbol: setup.symbol,
    currentMarketPrice: setup.currentMarketPrice, entryPrice: setup.entryPrice, stopLoss: setup.stopLoss,
    takeProfit1: setup.takeProfit1, takeProfit2: setup.takeProfit2, takeProfit3: setup.takeProfit3,
    orderType: setup.orderType, recommendedLotSize: setup.recommendedLotSize, riskPercentage: setup.riskPercentage,
  });
}

export function signSetup(setup: InstitutionalTradingSetup): string | undefined {
  const key = secret();
  return key ? createHmac('sha256', key).update(payload(setup)).digest('hex') : undefined;
}

export function verifySetupSignature(setup: InstitutionalTradingSetup): boolean {
  const key = secret();
  if (!key) return process.env.NODE_ENV !== 'production';
  if (!setup.setupSignature || !/^[a-f0-9]{64}$/.test(setup.setupSignature)) return false;
  const expected = createHmac('sha256', key).update(payload(setup)).digest();
  const supplied = Buffer.from(setup.setupSignature, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

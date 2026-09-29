import { describe, expect, test } from 'bun:test';
import { quickTargets } from '../lib/quick-target';
import { sanitiseScanSettings, scanRequest } from '../lib/setup-scan';
import { validateAnalyzeBody } from '../lib/request-validation';

describe('the quick target', () => {
  test('sits at half the risk, all three targets together', () => {
    expect(quickTargets(4145.25, 4163.25, 'short')).toEqual({ takeProfit1: 4136.25, takeProfit2: 4136.25, takeProfit3: 4136.25 });
    expect(quickTargets(4100, 4082, 'long').takeProfit1).toBe(4109);
  });

  test('travels with an analysis request and with the server scan', () => {
    const base = { equity: 3.37, riskPercentage: 1, tradingStyle: 'Intraday', accountType: 'Cent', brokerId: 'EXNESS' };
    expect(validateAnalyzeBody({ ...base, quickTarget: true }).value?.quickTarget).toBe(true);
    expect(validateAnalyzeBody({ ...base, quickTarget: 'yes' }).value?.quickTarget).toBe(false);
    const scan = sanitiseScanSettings({ ...base, minConviction: 0, dailyLossLimitPercent: 3, quickTarget: true })!;
    expect(scan.quickTarget).toBe(true);
    expect(scanRequest(scan)?.quickTarget).toBe(true);
  });
});

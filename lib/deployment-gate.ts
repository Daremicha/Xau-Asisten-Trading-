import type { BacktestStats } from './backtest-stats';

export const MIN_OOS_TRADES = 300;
export const MIN_OOS_PROFIT_FACTOR = 1.15;
export const MIN_POSITIVE_FOLD_SHARE = 0.6;

export interface DeploymentGateInput {
  coverage: { complete: boolean; provider: string | null };
  frozenStats: BacktestStats | null;
  folds: Array<{ frozenStats: BacktestStats }>;
  realisticProfitable: boolean;
  stressProfitable: boolean;
}

export interface DeploymentGateResult {
  allowed: boolean;
  reason: string;
  checks: {
    completeCoverage: boolean;
    spotProvider: boolean;
    minimumTrades: boolean;
    minimumProfitFactor: boolean;
    positiveExpectancy: boolean;
    positiveFoldShare: boolean;
    realisticStress: boolean;
    stressStress: boolean;
  };
}

/**
 * The production adoption gate is deliberately conservative. A positive total
 * is not enough when the data is incomplete, futures-based, or too small to
 * support the audit's out-of-sample conclusions.
 */
export function assessDeploymentGate(input: DeploymentGateInput): DeploymentGateResult {
  const stats = input.frozenStats;
  const completeCoverage = input.coverage.complete;
  const spotProvider = /spot/i.test(input.coverage.provider ?? '') && /twelve\s*data/i.test(input.coverage.provider ?? '');
  const minimumTrades = (stats?.filled ?? 0) >= MIN_OOS_TRADES;
  const minimumProfitFactor = (stats?.profitFactor ?? 0) >= MIN_OOS_PROFIT_FACTOR;
  const positiveExpectancy = (stats?.expectancyR ?? 0) > 0;
  const positiveFolds = input.folds.filter((fold) => fold.frozenStats.expectancyR !== null && fold.frozenStats.expectancyR > 0).length;
  const positiveFoldShare = input.folds.length >= 2 && positiveFolds / input.folds.length >= MIN_POSITIVE_FOLD_SHARE;
  const checks = {
    completeCoverage,
    spotProvider,
    minimumTrades,
    minimumProfitFactor,
    positiveExpectancy,
    positiveFoldShare,
    realisticStress: input.realisticProfitable,
    stressStress: input.stressProfitable,
  };

  const failed = [
    !completeCoverage ? 'periode data belum lengkap' : null,
    !spotProvider ? 'provider bukan data spot Twelve Data yang teridentifikasi' : null,
    !minimumTrades ? `trade test belum mencapai ${MIN_OOS_TRADES}` : null,
    !minimumProfitFactor ? `profit factor test belum mencapai ${MIN_OOS_PROFIT_FACTOR}` : null,
    !positiveExpectancy ? 'expectancy out-of-sample belum positif' : null,
    !positiveFoldShare ? 'mayoritas fold walk-forward belum menunjukkan expectancy positif' : null,
    !input.realisticProfitable ? 'stress cost realistis tidak profitable' : null,
    !input.stressProfitable ? 'stress cost ekstrem tidak profitable' : null,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    allowed: failed.length === 0,
    reason:
      failed.length === 0
        ? 'Gate live lulus: data spot lengkap, minimal 300 trade OOS, PF dan expectancy positif, mayoritas fold positif, serta dua stress cost tetap profitable.'
        : `Belum layak diadopsi live: ${failed.join('; ')}.`,
    checks,
  };
}

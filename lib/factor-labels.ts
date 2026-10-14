/**
 * Indonesian names for the confluence factors, for display only.
 *
 * The English names are keys: they are stored with every trade (factorVotes)
 * and in the learned multipliers, so renaming them would orphan the history.
 * Everything a person reads goes through factorLabel instead.
 */
const FACTOR_LABELS: Record<string, string> = {
  'Higher timeframe order flow': 'Order flow timeframe besar',
  'Order block': 'Order block',
  'Fair value gap': 'Fair value gap',
  'Liquidity sweep': 'Liquidity sweep',
  'EMA structure': 'Struktur EMA',
  RSI: 'RSI',
  Stochastic: 'Stochastic',
  'Premium and discount': 'Premium dan discount',
  'Pivot and directional bias': 'Pivot dan arah bias',
  'Wyckoff phase': 'Fase Wyckoff',
  Quasimodo: 'Quasimodo',
};

/** The name to show for a factor; unknown names pass through unchanged. */
export function factorLabel(name: string): string {
  return FACTOR_LABELS[name] ?? name;
}

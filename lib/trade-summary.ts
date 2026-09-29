/**
 * The recorded trades as plain text, to paste into a chat and compare with
 * the backtest.
 *
 * One header with the account and the settings the trades were taken under,
 * one line of totals, then one line per trade. Plain text rather than a file
 * because a phone can paste text anywhere, while a file needs somewhere to go.
 */

import { formatAccountMoney } from './account-display';
import type { AccountType, SelfLearningMemoryRecord } from './types';

export interface SummarySettings {
  tradingStyle: string;
  minConviction: number;
  protectStopAtR: number | null;
  dailyLossLimit: number;
  quickTarget?: boolean;
}

type Result = 'TP' | 'SL' | 'BE' | 'MISSED';

/** A stop at the entry, after the break-even move, is its own result. */
export function resultOf(record: SelfLearningMemoryRecord): Result {
  if (record.outcome === 'SL' && Math.abs(record.exitPrice - record.entryPrice) < 0.05) return 'BE';
  return record.outcome;
}

function wib(iso: string | undefined): string {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return '-';
  // Jakarta is UTC+7 all year.
  return new Date(ms + 7 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
}

const signed = (value: number, digits = 2) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

/**
 * Win rate of the closed trades most of the models agreed with, against the
 * ones they doubted: the comparison that decides whether their opinion is ever
 * allowed to filter a trade.
 */
function aiLine(live: SelfLearningMemoryRecord[], results: Result[]): string {
  const group = (agreed: boolean) => {
    const picked = live.filter((r, i) => {
      const c = r.context;
      if (results[i] === 'MISSED' || typeof c?.aiAnswered !== 'number' || c.aiAnswered === 0) return false;
      return (c.aiAgree ?? 0) * 2 > c.aiAnswered === agreed;
    });
    const wins = picked.filter((r) => resultOf(r) === 'TP').length;
    return picked.length ? `${wins}/${picked.length} won (${((wins / picked.length) * 100).toFixed(0)}%)` : 'none yet';
  };
  return `AI majority agreed: ${group(true)} - otherwise: ${group(false)}`;
}

export function tradeSummaryText(
  records: SelfLearningMemoryRecord[],
  options: { equity: number; accountType: AccountType; settings: SummarySettings; now?: number }
): string {
  const { equity, accountType, settings } = options;
  const money = (usd: number, sign = false) => formatAccountMoney(usd, accountType, { signed: sign });
  // Live trades only, oldest first. Replayed trades belong to the backtest.
  const live = records
    .filter((r) => !r.id.startsWith('bt_'))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const results = live.map(resultOf);
  const count = (kind: Result) => results.filter((r) => r === kind).length;
  const closed = live.filter((_, i) => results[i] !== 'MISSED');
  const wins = count('TP');
  const net = closed.reduce((sum, r) => sum + (Number.isFinite(r.profitOrLossDollars) ? r.profitOrLossDollars : 0), 0);
  const rs = closed.map((r) => r.context?.rMultiple).filter((r): r is number => typeof r === 'number');
  const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;

  const lines = [
    'XAUUSD Assistant - trade summary',
    `Generated: ${wib(new Date(options.now ?? Date.now()).toISOString())} WIB`,
    `Account: ${accountType} - balance ${money(equity)}`,
    `Settings: ${settings.tradingStyle} - conviction ${
      settings.minConviction === 0 ? 'Take all' : settings.minConviction
    } - ${settings.protectStopAtR ? `SL to entry at ${settings.protectStopAtR}R` : 'no break-even move'} - daily limit ${
      settings.dailyLossLimit ? `${settings.dailyLossLimit}%` : 'off'
    }${settings.quickTarget ? ' - quick target 0.5R' : ''}`,
    `Trades: ${closed.length} closed (TP ${wins} - SL ${count('SL')} - BE ${count('BE')}) - ${count('MISSED')} missed`,
    `Win rate: ${closed.length ? ((wins / closed.length) * 100).toFixed(1) : '-'}% - Net: ${money(net, true)} - Avg R: ${
      avgR === null ? '-' : signed(avgR)
    }`,
    '',
    aiLine(live, results),
    '',
    '#|Closed (WIB)|Setup|Order|Entry|Exit|Result|P/L|R|AI agree',
    ...live.map((r, i) =>
      [
        i + 1,
        wib(r.timestamp),
        r.context?.anchor === 'Asian Range Breakout' ? 'LBO' : 'SMC',
        r.orderType,
        r.entryPrice.toFixed(2),
        results[i] === 'MISSED' ? '-' : r.exitPrice.toFixed(2),
        results[i],
        results[i] === 'MISSED' ? '-' : money(r.profitOrLossDollars, true),
        typeof r.context?.rMultiple === 'number' && results[i] !== 'MISSED' ? signed(r.context.rMultiple) : '-',
        typeof r.context?.aiAnswered === 'number' ? `${r.context.aiAgree ?? 0}/${r.context.aiAnswered}` : '-',
      ].join('|')
    ),
  ];
  return lines.join('\n');
}

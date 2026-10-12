'use client';

import React, { useMemo } from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion } from 'lucide-react';
import { MIN_QUARTER_TRADES, robustnessReport, type RResult } from '@/lib/robustness';

interface RobustnessCardProps {
  results: RResult[];
  theme?: 'dark' | 'light';
}

const signed = (r: number | null, places = 3) => (r === null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(places)}R`);

/**
 * The replay looked at harder: quarter by quarter, with a range around the
 * average, and with trading costs made worse than assumed.
 */
export default function RobustnessCard({ results, theme = 'dark' }: RobustnessCardProps) {
  const isDark = theme === 'dark';
  const report = useMemo(() => robustnessReport(results), [results]);
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const strong = isDark ? 'text-slate-100' : 'text-slate-900';

  const { Icon, tone, title } =
    report.verdict === 'holds'
      ? { Icon: ShieldCheck, tone: 'border-emerald-500/40 bg-emerald-500/10', title: 'The edge holds up when pushed' }
      : report.verdict === 'fragile'
      ? { Icon: ShieldAlert, tone: 'border-amber-500/40 bg-amber-500/10', title: 'Profitable, but fragile' }
      : report.verdict === 'fails'
      ? { Icon: ShieldX, tone: 'border-rose-500/40 bg-rose-500/10', title: 'No edge over this period' }
      : {
          Icon: ShieldQuestion,
          tone: isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-50',
          title: 'Too few trades to judge',
        };

  return (
    <div id="robustness-card" className={`border rounded-xl p-3.5 space-y-3 ${tone}`}>
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${strong}`} />
        <h3 className={`text-sm font-bold ${strong}`}>Robustness: {title}</h3>
      </div>
      <p className={`text-xs ${muted}`}>{report.explanation}</p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
        <div className={`rounded-lg border p-2 ${isDark ? 'border-slate-800 bg-slate-950/60' : 'border-slate-200 bg-white'}`}>
          <div className={muted}>Average per trade, 95% range</div>
          <div className={`font-mono font-bold ${strong}`}>
            {report.expectancy
              ? `${signed(report.expectancy.mean)} (${signed(report.expectancy.low)} to ${signed(report.expectancy.high)})`
              : '—'}
          </div>
        </div>
        <div className={`rounded-lg border p-2 ${isDark ? 'border-slate-800 bg-slate-950/60' : 'border-slate-200 bg-white'}`}>
          <div className={muted}>Quarters that paid</div>
          <div className={`font-mono font-bold ${strong}`}>
            {report.countedQuarters ? `${report.positiveQuarters} of ${report.countedQuarters}` : '—'}
          </div>
        </div>
        <div className={`rounded-lg border p-2 ${isDark ? 'border-slate-800 bg-slate-950/60' : 'border-slate-200 bg-white'}`}>
          <div className={muted}>Costs ${report.stress.extraDollars.toFixed(2)} a trade worse</div>
          <div className={`font-mono font-bold ${strong}`}>
            {signed(report.stress.averageR)} • PF {report.stress.profitFactor?.toFixed(2) ?? '—'}
          </div>
        </div>
      </div>

      {report.quarters.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className={muted}>
                <th className="text-left font-medium py-1">Quarter</th>
                <th className="text-right font-medium py-1">Trades</th>
                <th className="text-right font-medium py-1">Total</th>
                <th className="text-right font-medium py-1">Per trade</th>
                <th className="text-right font-medium py-1">PF</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {report.quarters.map((q) => (
                <tr
                  key={q.label}
                  className={`border-t ${isDark ? 'border-slate-800' : 'border-slate-200'} ${
                    q.trades < MIN_QUARTER_TRADES ? 'opacity-50' : ''
                  }`}
                >
                  <td className={`py-1 ${strong}`}>{q.label}</td>
                  <td className="py-1 text-right">{q.trades}</td>
                  <td className={`py-1 text-right ${q.totalR > 0 ? 'text-emerald-500' : q.totalR < 0 ? 'text-rose-500' : ''}`}>
                    {signed(q.totalR, 1)}
                  </td>
                  <td className="py-1 text-right">{signed(q.averageR)}</td>
                  <td className="py-1 text-right">{q.profitFactor?.toFixed(2) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={`text-[10px] ${muted}`}>
        Judged on the fixed-parameter run. A quarter with fewer than {MIN_QUARTER_TRADES} filled trades is greyed and
        not counted. The range comes from resampling these trades 2,000 times; it says how much of the result chance
        alone could produce, not what the next period will do. Every setting chosen by looking at this same period makes
        it look better than it will be on new data, so confirm a change on later months or on paper before trusting it.
      </p>
    </div>
  );
}

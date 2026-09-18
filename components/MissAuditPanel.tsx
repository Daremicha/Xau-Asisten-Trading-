'use client';

/**
 * Puts the recorded misses back to the market, and shows what it finds.
 *
 * A missed entry is a real lesson and the engine uses it: `medianMissPips` is
 * computed from these rows and it decides how much closer the next entry is
 * placed. So a miss that never happened is not a stray row — it pushes entries
 * toward market on the evidence of a trade that filled where it was put and won
 * there, and takes that win out of the strike rate at the same time.
 *
 * Which is why nothing here deletes anything. The rows that stand up keep their
 * lesson; the rows that do not are handed back with what the candles say, and
 * the user supplies the outcome from the terminal that actually holds it.
 */

import React, { useState } from 'react';
import { SelfLearningMemoryRecord } from '@/lib/types';
import type { MissAuditVerdict } from '@/lib/miss-audit';
import { AlertTriangle, CheckCircle2, History, Loader2, ShieldQuestion } from 'lucide-react';

export interface AuditRow {
  id: string;
  timestamp: string;
  orderType: string;
  entryPrice: number;
  verdict: MissAuditVerdict;
  contradicted: boolean;
}

export interface AuditSummary {
  audited: number;
  contradicted: number;
  genuine: number;
  unknown: number;
  examinedFrom?: string;
  message: string;
  results: AuditRow[];
}

export type Correction = {
  id: string;
  outcome: 'TP' | 'SL';
  /**
   * Where the trade actually closed.
   *
   * Asked for rather than inferred. The row still carries the price the app saw
   * when it wrote the false miss — a price from after the move had drifted back
   * — and every derived figure built on that, the result in pips and the R
   * multiple the engine compares trades by, describes nothing that happened.
   */
  exitPrice: number;
  /**
   * What the broker actually paid.
   *
   * The record never kept the lot size, so this cannot be recomputed from the
   * prices. It is the better source in any case: what was paid, not what the
   * app calculates should have been.
   */
  profitOrLossDollars: number;
};

interface MissAuditPanelProps {
  learningRecords: SelfLearningMemoryRecord[];
  /** Runs the audit; resolves with the summary, or null when it could not run. */
  onAudit: () => Promise<AuditSummary | null>;
  /** Rewrites one row to what actually happened. */
  onCorrect: (correction: Correction) => Promise<void>;
  /** Marks a row as checked and correct, so it is not raised again. */
  onConfirm: (id: string) => Promise<void>;
  accountUnit: string;
  theme?: 'dark' | 'light';
}

function verdictTone(kind: MissAuditVerdict['kind']): 'bad' | 'good' | 'unsure' {
  if (kind === 'genuine') return 'good';
  if (kind === 'unknown') return 'unsure';
  return 'bad';
}

export default function MissAuditPanel({
  learningRecords,
  onAudit,
  onCorrect,
  onConfirm,
  accountUnit,
  theme = 'dark',
}: MissAuditPanelProps) {
  const isDark = theme === 'dark';
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<
    Record<string, { outcome: 'TP' | 'SL'; exit: string; amount: string }>
  >({});

  const missed = learningRecords.filter((r) => r.outcome === 'MISSED');
  const unchecked = missed.filter((r) => !r.audit);

  const run = async () => {
    setRunning(true);
    setFailure(null);
    try {
      const result = await onAudit();
      if (!result) {
        setFailure('The audit could not run. Nothing in your ledger was changed.');
        setSummary(null);
        return;
      }
      setSummary(result);
    } finally {
      setRunning(false);
    }
  };

  const apply = async (row: AuditRow) => {
    const draft = drafts[row.id];
    if (!draft) return;
    const amount = Number(draft.amount);
    const exit = Number(draft.exit);
    if (!Number.isFinite(amount) || !Number.isFinite(exit) || exit <= 0) return;
    setBusyId(row.id);
    try {
      await onCorrect({
        id: row.id,
        outcome: draft.outcome,
        exitPrice: exit,
        // A stop is a loss whichever sign the user happened to type.
        profitOrLossDollars: draft.outcome === 'SL' ? -Math.abs(amount) : Math.abs(amount),
      });
      setSummary((prev) =>
        prev ? { ...prev, results: prev.results.filter((r) => r.id !== row.id) } : prev
      );
    } finally {
      setBusyId(null);
    }
  };

  const keep = async (row: AuditRow) => {
    setBusyId(row.id);
    try {
      await onConfirm(row.id);
      setSummary((prev) =>
        prev ? { ...prev, results: prev.results.filter((r) => r.id !== row.id) } : prev
      );
    } finally {
      setBusyId(null);
    }
  };

  const card = isDark ? 'bg-slate-900/60 border-slate-700' : 'bg-white border-slate-200';
  const sub = isDark ? 'text-slate-400' : 'text-slate-500';
  const heading = isDark ? 'text-slate-100' : 'text-slate-900';

  if (missed.length === 0) return null;

  return (
    <div id="miss-audit-panel" className={`rounded-2xl border p-5 ${card}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-amber-500/15 text-amber-400 shrink-0">
            <History className="w-5 h-5" />
          </div>
          <div>
            <h3 className={`font-bold ${heading}`}>Re-examine missed entries</h3>
            <p className={`text-xs mt-1 max-w-xl ${sub}`}>
              A trade that filled and reached its target can be recorded as a missed entry if the app
              only ever saw the price after it drifted back. That row then teaches the engine to place
              the next entry closer to market — the opposite of what happened. This checks each one
              against the candles from the day it was placed.
            </p>
            <p className={`text-xs mt-1.5 ${sub}`}>
              {missed.length} missed {missed.length === 1 ? 'entry' : 'entries'} on record
              {unchecked.length < missed.length && `, ${unchecked.length} not yet checked`}. Nothing is
              deleted or changed without you.
            </p>
          </div>
        </div>
        <button
          id="run-miss-audit-btn"
          type="button"
          onClick={run}
          disabled={running}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-slate-900 hover:bg-amber-400 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer flex items-center gap-2 shrink-0"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <History className="w-4 h-4" />}
          {running ? 'Checking…' : 'Check against price history'}
        </button>
      </div>

      {failure && (
        <div
          id="miss-audit-failed"
          className="mt-4 p-3 rounded-xl border bg-rose-500/10 border-rose-500/40 text-rose-300 text-xs"
        >
          {failure}
        </div>
      )}

      {summary && (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'Examined', value: summary.audited, tone: sub },
              { label: 'Not a miss', value: summary.contradicted, tone: 'text-rose-400' },
              { label: 'Confirmed real', value: summary.genuine, tone: 'text-emerald-400' },
              { label: 'Undetermined', value: summary.unknown, tone: 'text-slate-400' },
            ].map((s) => (
              <div
                key={s.label}
                className={`rounded-xl border px-3 py-2 ${
                  isDark ? 'border-slate-700 bg-slate-950/40' : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className={`text-[11px] uppercase tracking-wide ${sub}`}>{s.label}</div>
                <div className={`text-lg font-bold ${s.tone}`}>{s.value}</div>
              </div>
            ))}
          </div>

          <p className={`text-xs ${sub}`}>{summary.message}</p>

          {summary.results.filter((r) => r.contradicted).length === 0 && (
            <div className="p-3 rounded-xl border bg-emerald-500/10 border-emerald-500/40 text-emerald-300 text-xs flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                Nothing left to correct. The misses that remain are real, and the engine should keep
                learning from them.
              </span>
            </div>
          )}

          {summary.results
            .filter((r) => r.contradicted)
            .map((row) => {
              const draft = drafts[row.id] ?? { outcome: 'TP' as const, exit: '', amount: '' };
              const tone = verdictTone(row.verdict.kind);
              return (
                <div
                  key={row.id}
                  className={`rounded-xl border p-4 ${
                    tone === 'bad'
                      ? 'border-rose-500/40 bg-rose-500/5'
                      : isDark
                      ? 'border-slate-700'
                      : 'border-slate-200'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <div className={`text-sm font-semibold ${heading}`}>
                        {row.orderType} @ {row.entryPrice.toFixed(2)}
                        <span className={`ml-2 font-normal text-xs ${sub}`}>
                          {new Date(row.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <p className={`text-xs mt-1 ${sub}`}>{row.verdict.reason}</p>
                      {row.verdict.kind === 'filled-profitable' && (
                        <p className={`text-xs mt-1 ${sub}`}>
                          Your terminal holds where it closed and for how much. This screen will not
                          guess at either — the price shown as a hint is the furthest it ran, not
                          where you took it.
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1">
                      <span className={`text-[11px] uppercase tracking-wide ${sub}`}>
                        What it really was
                      </span>
                      <select
                        value={draft.outcome}
                        onChange={(e) =>
                          setDrafts((p) => ({
                            ...p,
                            [row.id]: { ...draft, outcome: e.target.value === 'SL' ? 'SL' : 'TP' },
                          }))
                        }
                        className={`px-2.5 py-1.5 rounded-lg border text-sm ${
                          isDark
                            ? 'bg-slate-950 border-slate-700 text-slate-100'
                            : 'bg-white border-slate-300 text-slate-900'
                        }`}
                      >
                        <option value="TP">Take profit</option>
                        <option value="SL">Stop loss</option>
                      </select>
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className={`text-[11px] uppercase tracking-wide ${sub}`}>
                        Closed at (price)
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        value={draft.exit}
                        placeholder={row.verdict.kind === 'filled-profitable'
                          ? String(row.verdict.bestPrice)
                          : '0.00'}
                        onChange={(e) =>
                          setDrafts((p) => ({ ...p, [row.id]: { ...draft, exit: e.target.value } }))
                        }
                        className={`px-2.5 py-1.5 rounded-lg border text-sm w-32 ${
                          isDark
                            ? 'bg-slate-950 border-slate-700 text-slate-100'
                            : 'bg-white border-slate-300 text-slate-900'
                        }`}
                      />
                    </label>

                    <label className="flex flex-col gap-1">
                      <span className={`text-[11px] uppercase tracking-wide ${sub}`}>
                        Result ({accountUnit})
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        value={draft.amount}
                        placeholder="e.g. 12.50"
                        onChange={(e) =>
                          setDrafts((p) => ({ ...p, [row.id]: { ...draft, amount: e.target.value } }))
                        }
                        className={`px-2.5 py-1.5 rounded-lg border text-sm w-32 ${
                          isDark
                            ? 'bg-slate-950 border-slate-700 text-slate-100'
                            : 'bg-white border-slate-300 text-slate-900'
                        }`}
                      />
                    </label>

                    <button
                      type="button"
                      onClick={() => apply(row)}
                      disabled={
                        busyId === row.id ||
                        draft.amount === '' ||
                        draft.exit === '' ||
                        !Number.isFinite(Number(draft.amount)) ||
                        !Number.isFinite(Number(draft.exit))
                      }
                      className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-emerald-500 text-slate-900 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {busyId === row.id ? 'Saving…' : 'Correct this row'}
                    </button>

                    <button
                      type="button"
                      onClick={() => keep(row)}
                      disabled={busyId === row.id}
                      className={`px-3 py-1.5 rounded-lg text-sm border cursor-pointer disabled:opacity-50 ${
                        isDark
                          ? 'border-slate-600 text-slate-300 hover:bg-slate-800'
                          : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      Leave as a miss
                    </button>
                  </div>
                </div>
              );
            })}

          {summary.unknown > 0 && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                isDark ? 'border-slate-700 text-slate-400' : 'border-slate-200 text-slate-500'
              }`}
            >
              <ShieldQuestion className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                {summary.unknown} {summary.unknown === 1 ? 'row is' : 'rows are'} older than the price
                history the provider will serve, so {summary.unknown === 1 ? 'it was' : 'they were'}{' '}
                left exactly as {summary.unknown === 1 ? 'it is' : 'they are'}. An unexamined row is
                better than an invented verdict.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

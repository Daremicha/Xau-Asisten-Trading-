'use client';

/**
 * Puts the trades the engine closed by itself back to the market.
 *
 * Every such row is a claim: that an order filled, or never did, and that price
 * reached a particular level. Each was made from whatever single number the
 * screen was showing at the time, and a number cannot describe a path.
 *
 * Every kind of wrong row teaches its own wrong lesson. A miss that never
 * happened drags `medianMissPips`, which decides how much closer the next entry
 * goes — it pushes entries toward market on the evidence of a trade that filled
 * where it was put and won there. A stop loss that never happened is worse: a
 * loss in the ledger and a failure recorded against a setup that never lost.
 *
 * Which is why nothing here deletes anything. Rows that stand up keep their
 * lesson; rows that do not are handed back with what the candles say, and the
 * user supplies the truth from the terminal that actually holds it.
 */

import React, { useState } from 'react';
import type { AccountType, SelfLearningMemoryRecord } from '@/lib/types';
import { fromAccountUnits } from '@/lib/account-display';
import { auditableRecords, type RecordAuditVerdict } from '@/lib/record-audit';
import { AlertTriangle, CheckCircle2, History, Loader2, ShieldQuestion } from 'lucide-react';

export interface AuditRow {
  id: string;
  timestamp: string;
  orderType: string;
  entryPrice: number;
  outcome: 'TP' | 'SL' | 'MISSED';
  recordedExit: number;
  recordedResult: number;
  verdict: RecordAuditVerdict;
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

/** The form's working state. An empty outcome means the user has not chosen. */
type Draft = { outcome: 'TP' | 'SL' | 'MISSED' | ''; exit: string; amount: string };

export type Correction = {
  id: string;
  /** What it really was. A row can also be corrected back to a missed entry. */
  outcome: 'TP' | 'SL' | 'MISSED';
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

interface RecordAuditPanelProps {
  learningRecords: SelfLearningMemoryRecord[];
  /** Runs the audit; resolves with the summary, or null when it could not run. */
  onAudit: () => Promise<AuditSummary | null>;
  /** Rewrites one row to what actually happened. */
  onCorrect: (correction: Correction) => Promise<void>;
  /** Marks a row as checked and correct, so it is not raised again. */
  onConfirm: (id: string) => Promise<void>;
  accountUnit: string;
  /** The account the amount is typed for, to turn it into dollars. */
  accountType?: AccountType;
  theme?: 'dark' | 'light';
}

/**
 * What the candles suggest the row should say, as the form's starting point.
 *
 * The audit has already read the path, so making the user re-select what it
 * just told them is busywork. It is a default and nothing more: every field
 * stays editable, because only their terminal knows what they actually did.
 */
function suggestedDraft(row: AuditRow): Draft {
  const actual = row.verdict.actual;
  if (actual === 'never-filled') {
    // The order never opened, so there is no exit and no result. The entry
    // stands in for a price the trade never had.
    return { outcome: 'MISSED', exit: row.entryPrice.toFixed(2), amount: '' };
  }
  if (actual === 'stopped') return { outcome: 'SL', exit: '', amount: '' };
  if (actual === 'reached-level') return { outcome: 'TP', exit: String(row.recordedExit), amount: '' };
  // The order opened and was still between its levels when the app closed it.
  // What became of it after that is not on the chart: whether the trade was
  // ever placed, and where it was let go, is known only to the person who
  // placed it. Presuming a win would hand them a profit they may not have
  // made, and presuming they skipped it would erase one they did. So nothing
  // is preselected, and the form stays shut until they say.
  return {
    outcome: '',
    exit: typeof row.verdict.bestPrice === 'number' ? String(row.verdict.bestPrice) : '',
    amount: '',
  };
}

function verdictTone(kind: RecordAuditVerdict['kind']): 'bad' | 'good' | 'unsure' {
  if (kind === 'confirmed') return 'good';
  if (kind === 'unknown') return 'unsure';
  return 'bad';
}

export default function RecordAuditPanel({
  learningRecords,
  onAudit,
  onCorrect,
  onConfirm,
  accountUnit,
  accountType,
  theme = 'dark',
}: RecordAuditPanelProps) {
  const isDark = theme === 'dark';
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  // Only what the engine decided on its own. A result the user typed is their
  // own testimony, and this screen has no standing to dispute it.
  const auto = learningRecords.filter((r) => r.autoResolved);
  const unchecked = auditableRecords(learningRecords);

  // Misses from the last week. The candles can confirm the app's rule was
  // met, but not what a pending order left in MT5 did afterwards, so the user
  // is the only witness to a miss that filled anyway.
  // Measured from the newest record rather than the clock, so rendering
  // stays a pure function of the records.
  const newest = learningRecords.reduce((m, r) => Math.max(m, Date.parse(r.timestamp) || 0), 0);
  const recentMisses = learningRecords
    .filter(
      (r) =>
        r.outcome === 'MISSED' &&
        !r.id.startsWith('bt_') &&
        r.audit?.verdict !== 'corrected' &&
        newest - Date.parse(r.timestamp) <= 7 * 86_400_000
    )
    .slice(-5)
    .reverse();
  const [openMiss, setOpenMiss] = useState<string | null>(null);

  const applyMiss = async (id: string) => {
    const draft = drafts[id];
    if (!draft || (draft.outcome !== 'TP' && draft.outcome !== 'SL')) return;
    const amount = Number(draft.amount);
    const exit = Number(draft.exit);
    if (!Number.isFinite(amount) || draft.amount.trim() === '' || !Number.isFinite(exit) || exit <= 0) return;
    setBusyId(id);
    try {
      await onCorrect({
        id,
        outcome: draft.outcome,
        exitPrice: exit,
        profitOrLossDollars: fromAccountUnits(
          draft.outcome === 'SL' ? -Math.abs(amount) : Math.abs(amount),
          accountType
        ),
      });
      setOpenMiss(null);
    } finally {
      setBusyId(null);
    }
  };

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
    if (draft.outcome === '') return;
    const amount = draft.outcome === 'MISSED' ? 0 : Number(draft.amount);
    const exit = Number(draft.exit);
    if (!Number.isFinite(amount) || !Number.isFinite(exit) || exit <= 0) return;
    setBusyId(row.id);
    try {
      await onCorrect({
        id: row.id,
        outcome: draft.outcome as 'TP' | 'SL' | 'MISSED',
        exitPrice: exit,
        // A stop is a loss whichever sign the user happened to type, and the
        // amount is typed in the account's unit, which is cents on a cent
        // account while every record is kept in dollars.
        profitOrLossDollars: fromAccountUnits(
          draft.outcome === 'MISSED' ? 0 : draft.outcome === 'SL' ? -Math.abs(amount) : Math.abs(amount),
          accountType
        ),
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

  if (auto.length === 0 && recentMisses.length === 0) return null;

  return (
    <div id="record-audit-panel" className={`rounded-2xl border p-5 ${card}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-amber-500/15 text-amber-400 shrink-0">
            <History className="w-5 h-5" />
          </div>
          <div>
            <h3 className={`font-bold ${heading}`}>Re-examine trades the engine closed</h3>
            <p className={`text-xs mt-1 max-w-xl ${sub}`}>
              Every trade the engine closed by itself is a claim about the market, made from whatever
              single price the screen was showing at the time. A stop loss booked against a level the
              market never touched is a loss in your ledger and a failure recorded against a setup
              that never lost. This walks each row through the candles of its own lifetime.
            </p>
            <p className={`text-xs mt-1.5 ${sub}`}>
              {auto.length} {auto.length === 1 ? 'row' : 'rows'} closed by the engine
              {unchecked.length < auto.length && `, ${unchecked.length} not yet checked`}. Nothing is
              deleted or changed without you.
            </p>
          </div>
        </div>
        <button
          id="run-record-audit-btn"
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
          id="record-audit-failed"
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
              { label: 'Never happened', value: summary.contradicted, tone: 'text-rose-400' },
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
                Nothing left to correct. Every row the engine closed is one the market really did,
                and the engine should keep learning from all of them.
              </span>
            </div>
          )}

          {summary.results
            .filter((r) => r.contradicted)
            .map((row) => {
              const draft = drafts[row.id] ?? suggestedDraft(row);
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
                        <span
                          className={`mr-2 px-1.5 py-0.5 rounded text-[10px] font-mono ${
                            row.outcome === 'SL'
                              ? 'bg-rose-500/20 text-rose-300'
                              : row.outcome === 'TP'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-slate-500/20 text-slate-300'
                          }`}
                        >
                          {row.outcome === 'MISSED' ? 'MISSED' : `${row.outcome} HIT`}
                        </span>
                        {row.orderType} @ {row.entryPrice.toFixed(2)}
                        <span className={`ml-2 font-normal text-xs ${sub}`}>
                          {new Date(row.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <p className={`text-xs mt-1 ${sub}`}>{row.verdict.reason}</p>
                      <p className={`text-xs mt-1 ${sub}`}>
                        Your terminal holds where this really closed and for how much. This screen
                        will not guess at either — any price it shows is the furthest the market
                        went, not where you came out.
                      </p>
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
                            [row.id]: {
                              ...draft,
                              outcome:
                                e.target.value === 'SL'
                                  ? 'SL'
                                  : e.target.value === 'MISSED'
                                  ? 'MISSED'
                                  : e.target.value === 'TP'
                                  ? 'TP'
                                  : '',
                            },
                          }))
                        }
                        className={`px-2.5 py-1.5 rounded-lg border text-sm ${
                          isDark
                            ? 'bg-slate-950 border-slate-700 text-slate-100'
                            : 'bg-white border-slate-300 text-slate-900'
                        }`}
                      >
                        <option value="">Choose…</option>
                        <option value="TP">Take profit</option>
                        <option value="SL">Stop loss</option>
                        <option value="MISSED">Never placed it</option>
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
                        placeholder={
                          typeof row.verdict.bestPrice === 'number'
                            ? String(row.verdict.bestPrice)
                            : '0.00'
                        }
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

                    <label className={`flex flex-col gap-1 ${draft.outcome === 'MISSED' ? 'opacity-50' : ''}`}>
                      <span className={`text-[11px] uppercase tracking-wide ${sub}`}>
                        Result ({accountUnit})
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        value={draft.outcome === 'MISSED' ? '0' : draft.amount}
                        disabled={draft.outcome === 'MISSED'}
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
                        draft.outcome === '' ||
                        draft.exit === '' ||
                        !Number.isFinite(Number(draft.exit)) ||
                        // A trade that was never placed has no result to supply.
                        (draft.outcome !== 'MISSED' &&
                          (draft.amount === '' || !Number.isFinite(Number(draft.amount))))
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
                      Leave as recorded
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
                {summary.unknown} {summary.unknown === 1 ? 'row is' : 'rows are'} beyond the price
                history the provider will serve, so {summary.unknown === 1 ? 'it was' : 'they were'}{' '}
                left exactly as {summary.unknown === 1 ? 'it is' : 'they are'}. An unexamined row is
                better than an invented verdict.
              </span>
            </div>
          )}
        </div>
      )}

      {recentMisses.length > 0 && (
        <div id="filled-after-miss" className={`mt-4 pt-4 border-t ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
          <h4 className={`text-sm font-bold ${heading}`}>A missed order filled in MT5 anyway?</h4>
          <p className={`text-xs mt-1 ${sub}`}>
            The app stops tracking an order once it calls it missed, but MT5 keeps a pending order until you delete it.
            If one of these filled later, record what MT5 actually paid once the trade has closed.
          </p>
          <div className="mt-2 space-y-2">
            {recentMisses.map((r) => {
              const draft = drafts[r.id] ?? { outcome: '', exit: '', amount: '' };
              const setDraft = (patch: Partial<Draft>) =>
                setDrafts((prev) => ({ ...prev, [r.id]: { ...draft, ...patch } }));
              const ready =
                (draft.outcome === 'TP' || draft.outcome === 'SL') &&
                Number(draft.exit) > 0 &&
                draft.amount.trim() !== '' &&
                Number.isFinite(Number(draft.amount));
              return (
                <div
                  key={r.id}
                  className={`rounded-xl border p-3 text-xs ${isDark ? 'border-slate-700 bg-slate-950/40' : 'border-slate-200 bg-slate-50'}`}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className={`font-mono ${heading}`}>
                      {r.orderType} @ {r.entryPrice.toFixed(2)} •{' '}
                      {new Date(r.timestamp).toLocaleString('en-GB', {
                        timeZone: 'Asia/Jakarta',
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      WIB
                    </span>
                    <button
                      type="button"
                      onClick={() => setOpenMiss(openMiss === r.id ? null : r.id)}
                      className={`px-3 py-1.5 rounded-lg border font-semibold cursor-pointer ${
                        isDark ? 'border-sky-500/40 text-sky-300 hover:bg-sky-500/10' : 'border-sky-300 text-sky-700 hover:bg-sky-50'
                      }`}
                    >
                      {openMiss === r.id ? 'Cancel' : 'It filled in MT5'}
                    </button>
                  </div>
                  {openMiss === r.id && (
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <label className="flex flex-col gap-1">
                        <span className={sub}>How it closed</span>
                        <select
                          value={draft.outcome}
                          onChange={(e) => setDraft({ outcome: e.target.value as Draft['outcome'] })}
                          className={`rounded-lg border px-2 py-1.5 ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-300'}`}
                        >
                          <option value="">Choose…</option>
                          <option value="TP">Take profit</option>
                          <option value="SL">Stop loss</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className={sub}>Close price</span>
                        <input
                          inputMode="decimal"
                          value={draft.exit}
                          onChange={(e) => setDraft({ exit: e.target.value })}
                          placeholder="e.g. 4088.40"
                          className={`rounded-lg border px-2 py-1.5 font-mono ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-300'}`}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className={sub}>Result ({accountUnit})</span>
                        <input
                          inputMode="decimal"
                          value={draft.amount}
                          onChange={(e) => setDraft({ amount: e.target.value })}
                          placeholder="as shown in MT5"
                          className={`rounded-lg border px-2 py-1.5 font-mono ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-300'}`}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => applyMiss(r.id)}
                        disabled={!ready || busyId === r.id}
                        className="sm:col-span-3 px-3 py-1.5 rounded-lg text-sm font-semibold bg-amber-500 text-slate-900 hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
                      >
                        {busyId === r.id ? 'Saving…' : 'Record the real result'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

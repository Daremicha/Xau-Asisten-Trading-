'use client';

import React from 'react';
import { Bot, ThumbsUp, HelpCircle, AlertTriangle } from 'lucide-react';
import { PROVIDER_NAMES, reviewLabel } from '@/lib/ai-review-label';
import type { AiReview } from '@/lib/types';

interface AiReviewPanelProps {
  /** Undefined while the models are still being asked. */
  review: AiReview | null | undefined;
  /** Shown when no model answered, to ask again. */
  onRetry?: () => void;
  theme?: 'dark' | 'light';
}

/**
 * What Gemini, ChatGPT and Claude each made of the setup. An opinion only:
 * the prices on the card are the tested engine's, and whether the models'
 * agreement means anything is read from the recorded trades later.
 */
export default function AiReviewPanel({ review, onRetry, theme = 'dark' }: AiReviewPanelProps) {
  const isDark = theme === 'dark';
  // No model configured at all: nothing to show.
  if (review === null) return null;
  const muted = isDark ? 'text-slate-400' : 'text-slate-600';
  const label = review ? reviewLabel(review) : null;

  return (
    <div
      id="ai-review"
      className={`border rounded-xl p-3.5 space-y-2 ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}
    >
      <div
        className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${
          isDark ? 'text-slate-300' : 'text-slate-800'
        }`}
      >
        <Bot className="w-3.5 h-3.5 text-sky-400" />
        <span>Pendapat kedua dari AI</span>
        {label && (
          <span
            className={`ml-auto normal-case tracking-normal font-bold ${
              review && review.agree * 2 > review.answered ? 'text-emerald-500' : 'text-amber-500'
            }`}
          >
            {label}
          </span>
        )}
      </div>

      {review === undefined ? (
        <p className={`text-xs ${muted}`}>Menanyakan Gemini, ChatGPT, dan Claude…</p>
      ) : (
        <ul className="space-y-1.5">
          {review.reviews.map((r) => (
            <li key={r.provider} className="text-xs flex items-start gap-1.5">
              {r.verdict === 'agree' ? (
                <ThumbsUp className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-500" />
              ) : r.verdict === 'doubt' ? (
                <HelpCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-500" />
              )}
              <span className={muted}>
                <strong className={isDark ? 'text-slate-200' : 'text-slate-800'}>
                  {PROVIDER_NAMES[r.provider]}
                  {r.verdict ? ` · ${r.verdict === 'agree' ? 'SETUJU' : 'RAGU'}` : ''}
                  {r.verdict && typeof r.confidence === 'number' ? ` ${r.confidence}%` : ''}
                </strong>
                {r.verdict ? (
                  r.reason && <>: {r.reason}</>
                ) : (
                  <span className="text-[11px]"> · tidak menjawab{r.error ? `: ${r.error}` : ''}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {review && review.answered === 0 && onRetry && (
        <button
          type="button"
          id="ai-review-retry"
          onClick={onRetry}
          className="px-2.5 py-1 rounded-lg bg-sky-500 text-slate-950 text-xs font-bold cursor-pointer"
        >
          Tanya lagi
        </button>
      )}

      <p className={`text-[10px] leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        Hanya pendapat. Entry, stop, dan target tetap dari engine yang sudah diuji; AI tidak pernah mengubahnya. Setiap pendapat dicatat bersama trade-nya, jadi setelah 30–50 trade ringkasan akan menunjukkan apakah persetujuan AI ada artinya.
      </p>
    </div>
  );
}

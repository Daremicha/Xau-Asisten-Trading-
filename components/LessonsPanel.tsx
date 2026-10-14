'use client';

import React, { useMemo } from 'react';
import { GraduationCap, TrendingUp, AlertTriangle, Info, Brain } from 'lucide-react';
import { liveVersusReplay, tradeLessons, type Lesson } from '@/lib/lessons';
import { deriveAdaptiveWeights, type PriorWeights } from '@/lib/learning-engine';
import type { SelfLearningMemoryRecord, TradingStyle } from '@/lib/types';

interface LessonsPanelProps {
  learningRecords: SelfLearningMemoryRecord[];
  /** Whether live trades re-tune the engine, the user's switch. */
  selfLearning: boolean;
  tradingStyle: TradingStyle;
  backtestPrior?: PriorWeights | null;
  theme?: 'dark' | 'light';
}

/**
 * The lessons in the user's own trades, and what the engine changed because
 * of them, in plain sentences.
 */
export default function LessonsPanel({
  learningRecords,
  selfLearning,
  tradingStyle,
  backtestPrior = null,
  theme = 'dark',
}: LessonsPanelProps) {
  const isDark = theme === 'dark';
  const lessons = useMemo(
    () => [liveVersusReplay(learningRecords), ...tradeLessons(learningRecords)],
    [learningRecords]
  );
  // The same calculation the analysis runs with self-learning on, so what is
  // listed here is what the next setup is built with.
  const changes = useMemo(
    () => (selfLearning ? deriveAdaptiveWeights(learningRecords, tradingStyle, backtestPrior).adjustments : []),
    [learningRecords, selfLearning, tradingStyle, backtestPrior]
  );

  const tone = (lesson: Lesson) =>
    lesson.tone === 'good'
      ? { Icon: TrendingUp, color: 'text-emerald-500', box: isDark ? 'bg-emerald-500/10 border-emerald-500/25' : 'bg-emerald-50 border-emerald-200' }
      : lesson.tone === 'bad'
        ? { Icon: AlertTriangle, color: 'text-rose-500', box: isDark ? 'bg-rose-500/10 border-rose-500/25' : 'bg-rose-50 border-rose-200' }
        : { Icon: Info, color: 'text-sky-500', box: isDark ? 'bg-sky-500/10 border-sky-500/25' : 'bg-sky-50 border-sky-200' };

  return (
    <div
      id="lessons-panel"
      className={`border rounded-2xl p-5 space-y-4 ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-400 shrink-0">
          <GraduationCap className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h2 className={`text-base font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Pelajaran dari trade kamu</h2>
          <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Apa kata TP, SL, dan order MISSED yang tercatat, dan apa yang diubah engine karenanya.
          </p>
        </div>
        <span
          className={`ml-auto shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg border ${
            selfLearning
              ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/25'
              : isDark
                ? 'bg-slate-800 text-slate-400 border-slate-700'
                : 'bg-slate-100 text-slate-500 border-slate-200'
          }`}
        >
          Self-learning {selfLearning ? 'on' : 'off'}
        </span>
      </div>

      <ul className="space-y-2">
        {lessons.map((lesson, i) => {
          const { Icon, color, box } = tone(lesson);
          return (
            <li key={i} className={`flex items-start gap-2.5 p-3 rounded-xl border ${box}`}>
              <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${color}`} />
              <div className="min-w-0">
                <div className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{lesson.title}</div>
                <div className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{lesson.detail}</div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className={`rounded-xl border p-3 ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
        <div className={`flex items-center gap-1.5 text-xs font-bold mb-1.5 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
          <Brain className="w-3.5 h-3.5 text-amber-500" /> Yang diubah engine untuk setup berikutnya
        </div>
        {!selfLearning ? (
          <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            Tidak ada: self-learning mati, jadi engine memakai aturan yang sudah diuji. Nyalakan di Akun supaya trade ini ikut menyetel ulang engine.
          </p>
        ) : (
          <ul className={`space-y-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {changes.map((line, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-amber-500 shrink-0">•</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}
        <p className={`text-[10px] mt-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          Engine hanya berubah karena pola yang melebihi kebetulan: satu kondisi butuh delapan trade tertutup, dan bobot sinyal baru berubah kalau selisihnya dua kali lipat dari noise-nya, jadi satu dua trade tidak bisa menggesernya.
        </p>
      </div>
    </div>
  );
}

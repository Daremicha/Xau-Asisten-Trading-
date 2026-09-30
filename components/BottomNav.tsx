'use client';

import React from 'react';
import { CandlestickChart, Globe2, LineChart, FlaskConical, UserCog } from 'lucide-react';

export type AppTab = 'trade' | 'market' | 'results' | 'lab' | 'account';

export const APP_TABS: AppTab[] = ['trade', 'market', 'results', 'lab', 'account'];

const TABS: Array<{ id: AppTab; label: string; hint: string; Icon: typeof CandlestickChart }> = [
  { id: 'trade', label: 'Trade', hint: 'Chart, live position and the setup', Icon: CandlestickChart },
  { id: 'market', label: 'Market', hint: 'Sessions, structure, pivots and news', Icon: Globe2 },
  { id: 'results', label: 'Results', hint: 'Balance, recorded trades and summary', Icon: LineChart },
  { id: 'lab', label: 'Backtest', hint: 'Replay the strategy on real history', Icon: FlaskConical },
  { id: 'account', label: 'Account', hint: 'Balance, risk, settings and alerts', Icon: UserCog },
];

interface BottomNavProps {
  active: AppTab;
  onChange: (tab: AppTab) => void;
  /** Small marks on a tab that has something waiting: a live order, a problem. */
  badges?: Partial<Record<AppTab, 'live' | 'warn' | null>>;
  theme?: 'dark' | 'light';
}

/**
 * The app's sections as a bar along the bottom of the screen, where a thumb
 * reaches on a phone, so moving between them is one tap instead of a long
 * scroll.
 */
export default function BottomNav({ active, onChange, badges = {}, theme = 'dark' }: BottomNavProps) {
  const isDark = theme === 'dark';
  return (
    <nav
      id="bottom-nav"
      aria-label="Sections"
      className={`fixed bottom-0 inset-x-0 z-40 border-t backdrop-blur-md ${
        isDark ? 'bg-slate-950/90 border-slate-800' : 'bg-white/90 border-slate-200 shadow-[0_-4px_16px_rgba(15,23,42,0.06)]'
      }`}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="max-w-3xl mx-auto grid grid-cols-5 px-1">
        {TABS.map(({ id, label, hint, Icon }) => {
          const selected = active === id;
          const badge = badges[id];
          return (
            <button
              key={id}
              id={`tab-${id}`}
              type="button"
              title={hint}
              aria-current={selected ? 'page' : undefined}
              onClick={() => onChange(id)}
              className={`relative flex flex-col items-center justify-center gap-1 py-2 min-h-[60px] cursor-pointer transition-colors ${
                selected
                  ? 'text-amber-500'
                  : isDark
                    ? 'text-slate-400 hover:text-slate-200'
                    : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {/* The selected section is marked by a bar along the top edge. */}
              <span
                className={`absolute top-0 left-1/2 -translate-x-1/2 h-[3px] rounded-b-full transition-all ${
                  selected ? 'w-8 bg-amber-500' : 'w-0 bg-transparent'
                }`}
              />
              <span
                className={`relative flex items-center justify-center w-11 h-7 rounded-full transition-colors ${
                  selected ? (isDark ? 'bg-amber-500/15' : 'bg-amber-100') : ''
                }`}
              >
                <Icon className="w-5 h-5" strokeWidth={selected ? 2.4 : 2} />
                {badge && (
                  <span
                    className={`absolute top-0 right-1.5 w-2.5 h-2.5 rounded-full border-2 ${
                      isDark ? 'border-slate-950' : 'border-white'
                    } ${badge === 'live' ? 'bg-emerald-500' : 'bg-rose-500'}`}
                  >
                    {badge === 'live' && (
                      <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-60" />
                    )}
                  </span>
                )}
              </span>
              <span className={`text-[11px] leading-none ${selected ? 'font-bold' : 'font-medium'}`}>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** The title and one line shown at the top of each section. */
export function SectionHeading({
  title,
  subtitle,
  theme = 'dark',
}: {
  title: string;
  subtitle: string;
  theme?: 'dark' | 'light';
}) {
  const isDark = theme === 'dark';
  return (
    <div className="px-1">
      <h1 className={`text-lg font-bold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{title}</h1>
      <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>{subtitle}</p>
    </div>
  );
}

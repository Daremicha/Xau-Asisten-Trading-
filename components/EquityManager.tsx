'use client';

import {
  followsTestedConfiguration,
  TESTED_FLOOR,
  TESTED_PROTECT_AT_R,
  TESTED_STYLE,
  untestedSettingNote,
} from '@/lib/tested-configuration';
import React, { useState } from 'react';
import {
  Lock,
  Unlock,
  DollarSign,
  Percent,
  Shield,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Briefcase,
  Filter,
  Info,
  Target,
  Brain,
  ShieldAlert,
} from 'lucide-react';
import { TradingStyle, AccountType, BrokerId, BROKER_PROFILES } from '@/lib/types';
import { formatAccountMoney, isCentAccount } from '@/lib/account-display';
import { STYLE_PROFILES, stopBandLabel, stopBandPips } from '@/lib/style-profiles';
import { calculateXAUUSDLotSize } from '@/lib/market-engine';
import { DAILY_LOSS_LIMIT_CHOICES, DEFAULT_DAILY_LOSS_LIMIT } from '@/lib/daily-loss';
import { QUICK_TARGET_R } from '@/lib/quick-target';

interface EquityManagerProps {
  equity: number;
  isLocked: boolean;
  riskPercentage: number;
  tradingStyle: TradingStyle;
  accountType: AccountType;
  selectedBroker: BrokerId;
  /** Lowest conviction worth trading. Zero takes every setup. */
  minConviction: number;
  onLockEquity: (initialAmount: number) => void;
  /** Replaces the balance with one the user typed, in USD. Saved to the account. */
  onSetEquity: (amount: number) => void;
  onChangeRiskPct: (pct: number) => void;
  onChangeMinConviction: (score: number) => void;
  /** Percent of the day's starting balance that may be lost; zero is off. */
  dailyLossLimit: number;
  onChangeDailyLossLimit: (percent: number) => void;
  /** A single target at 0.5R instead of the engine's own. */
  quickTarget?: boolean;
  onChangeQuickTarget?: (on: boolean) => void;
  /** Whether live trades re-tune the engine. */
  selfLearning?: boolean;
  onChangeSelfLearning?: (on: boolean) => void;
  /** Refuse setups the minimum lot cannot size within the risk percentage. */
  riskGuard?: boolean;
  onChangeRiskGuard?: (on: boolean) => void;
  /** Switches to the style and floor that held up in the 24 month replay. */
  onApplyTestedConfiguration?: () => void;
  onChangeTradingStyle: (style: TradingStyle) => void;
  onChangeAccountType: (account: AccountType) => void;
  onChangeBroker: (broker: BrokerId) => void;
  onResetEquity: () => void;
  theme?: 'dark' | 'light';
}

export default function EquityManager({
  equity,
  isLocked,
  riskPercentage,
  tradingStyle,
  accountType,
  selectedBroker = 'EXNESS',
  minConviction,
  onLockEquity,
  onSetEquity,
  onChangeRiskPct,
  onChangeMinConviction,
  dailyLossLimit,
  onChangeDailyLossLimit,
  quickTarget = false,
  onChangeQuickTarget,
  selfLearning = true,
  onChangeSelfLearning,
  riskGuard = true,
  onChangeRiskGuard,
  onApplyTestedConfiguration,
  onChangeTradingStyle,
  onChangeAccountType,
  onChangeBroker,
  onResetEquity,
  theme = 'dark',
}: EquityManagerProps) {
  const isDark = theme === 'dark';
  const [inputVal, setInputVal] = useState<string>(equity > 0 ? equity.toString() : '5000');
  const [errorMsg, setErrorMsg] = useState<string>('');

  const currentBroker = BROKER_PROFILES[selectedBroker] || BROKER_PROFILES.EXNESS;

  const handleConfirmLock = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(inputVal);
    if (isNaN(val) || val <= 0) {
      setErrorMsg('Masukkan modal awal yang valid, lebih dari $0.00');
      return;
    }
    setErrorMsg('');
    onLockEquity(val);
  };

  // Editing the balance later, to match the broker after a deposit, a
  // withdrawal or a trade taken outside the app. Typed in the account's own
  // units: cents on a cent account, as the terminal shows them.
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');
  const [editError, setEditError] = useState('');
  const unitsPerUsd = isCentAccount(accountType) ? 100 : 1;

  const startEdit = () => {
    setEditVal(String(parseFloat((equity * unitsPerUsd).toFixed(2))));
    setEditError('');
    setEditing(true);
  };

  const saveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    const typed = parseFloat(editVal.replace(',', '.'));
    if (!Number.isFinite(typed) || typed <= 0) {
      setEditError('Masukkan saldo lebih dari nol.');
      return;
    }
    onSetEquity(typed / unitsPerUsd);
    setEditing(false);
  };

  const isBroke = isLocked && equity <= 0;
  const riskDollars = equity * (riskPercentage / 100);
  // The balance is held in USD everywhere in the engine. A cent account simply
  // denominates the same value differently, so only the display converts.
  const isCent = isCentAccount(accountType);
  const balanceDisplay = formatAccountMoney(equity, accountType);
  const riskDisplay = formatAccountMoney(riskDollars, accountType);
  // Whatever is typed into the deposit box is read as USD, so a cent account
  // gets a preview of how that same amount will read in the terminal.
  const typedDeposit = parseFloat(inputVal);
  const depositPreview =
    isCent && Number.isFinite(typedDeposit) && typedDeposit > 0
      ? formatAccountMoney(typedDeposit, 'Cent')
      : null;

  const getBrokerSpreadForTier = (brokerId: BrokerId) => {
    const b = BROKER_PROFILES[brokerId];
    if (!b) return 2.0;
    if (accountType === 'Cent') return b.spreadCentPips || b.spreadStandardPips;
    if (accountType === 'Pro') return b.spreadProPips;
    return b.spreadStandardPips;
  };

  return (
    <div
      id="institutional-equity-card"
      className={`${
        isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900 shadow-sm'
      } border rounded-2xl p-5 transition-colors`}
    >
      {/* Top Header: Capital Title + Risk Quick Switcher */}
      <div
        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b pb-4 mb-4 ${
          isDark ? 'border-slate-800/80' : 'border-slate-100'
        }`}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500">
            <DollarSign className="w-5 h-5" />
          </div>
          <div>
            <h2 className={`text-base font-bold flex items-center gap-2 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
              Modal &amp; Pengaturan Akun
              {isLocked && !isBroke ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 border border-amber-500/30">
                  <Lock className="w-3 h-3" /> Terkunci
                </span>
              ) : isBroke ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-500 border border-rose-500/30">
                  <AlertTriangle className="w-3 h-3" /> Habis ($0.00)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-500 border border-sky-500/30">
                  <Unlock className="w-3 h-3" /> Perlu Diatur
                </span>
              )}
            </h2>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Alokasi risiko: disesuaikan dengan gaya trading dan jenis akun broker kamu.
            </p>
          </div>
        </div>

        {/* Risk Percentage Switcher */}
        <div
          className={`flex flex-wrap items-center gap-2 self-start max-w-full sm:self-auto p-1.5 rounded-xl border ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <span className={`text-[11px] px-2 font-medium flex items-center gap-1 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            <Percent className="w-3 h-3" /> Risiko per Trade:
          </span>
          {[0.5, 1.0, 2.0, 3.0].map((pct) => (
            <button
              key={pct}
              type="button"
              id={`risk-btn-${pct}`}
              onClick={() => onChangeRiskPct(pct)}
              className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                riskPercentage === pct
                  ? 'bg-amber-500 text-slate-950 shadow-sm'
                  : isDark
                  ? 'text-slate-400 hover:text-white hover:bg-slate-800'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200'
              }`}
            >
              {pct}%
            </button>
          ))}
        </div>
      </div>

      {!followsTestedConfiguration(tradingStyle, minConviction) && (
        <div
          id="tested-configuration-note"
          className="flex flex-col sm:flex-row sm:items-center gap-2 mb-4 p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200"
        >
          <p className="text-[11px] leading-relaxed">
            <span className="font-bold text-amber-300">Bukan setelan yang sudah diuji. </span>
            Pada 24 bulan data XAUUSD (Sep 2024 – Sep 2026), {TESTED_STYLE} dengan conviction {TESTED_FLOOR}+ dan stop dipindah ke entry di {TESTED_PROTECT_AT_R}R untung di kedua paruh: profit factor 1,30 setelah slippage, drawdown terburuk 20%, sekitar enam trade per minggu. {untestedSettingNote(tradingStyle, minConviction)}
          </p>
          {onApplyTestedConfiguration && (
            <button
              type="button"
              id="apply-tested-configuration-btn"
              onClick={onApplyTestedConfiguration}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-500 text-slate-950 text-xs font-bold cursor-pointer hover:bg-amber-400"
            >
              Pakai {TESTED_STYLE} + {TESTED_FLOOR}, stop ke entry di {TESTED_PROTECT_AT_R}R
            </button>
          )}
        </div>
      )}

      {/* Signal quality floor. Skipping a weak setup costs nothing, which is
          why this sits beside the risk budget rather than buried in a menu. */}
      <div
        className={`flex flex-col sm:flex-row sm:items-center gap-2 mb-4 p-2.5 rounded-xl border ${
          isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
        }`}
      >
        <span
          className={`text-[11px] px-1 font-medium flex items-center gap-1.5 shrink-0 ${
            isDark ? 'text-slate-400' : 'text-slate-600'
          }`}
        >
          <Filter className="w-3 h-3" /> Hanya ambil conviction di atas:
        </span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {[0, 40, 55, 70].map((score) => (
            <button
              key={score}
              type="button"
              id={`conviction-btn-${score}`}
              onClick={() => onChangeMinConviction(score)}
              className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                minConviction === score
                  ? 'bg-sky-500 text-slate-950 shadow-sm'
                  : isDark
                  ? 'text-slate-400 hover:text-white hover:bg-slate-800'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200'
              }`}
            >
              {score === 0 ? 'Ambil semua' : score}
            </button>
          ))}
        </div>
        <span className={`text-[10px] sm:ml-auto ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {minConviction === 0
            ? 'Setiap setup dari engine akan ditawarkan.'
            : `Setup dengan skor di bawah ${minConviction} ditolak, tidak ditawarkan. Uji batas ini di Backtest Lab dulu.`}
        </span>
      </div>

      {/* Daily loss limit: a brake on a bad day, which a run of stop outs makes
          hard to apply by hand. */}
      <div
        className={`flex flex-col sm:flex-row sm:items-center gap-2 mb-4 p-2.5 rounded-xl border ${
          isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
        }`}
      >
        <span
          className={`text-[11px] px-1 font-medium flex items-center gap-1.5 shrink-0 ${
            isDark ? 'text-slate-400' : 'text-slate-600'
          }`}
        >
          <Shield className="w-3 h-3" /> Berhenti hari ini setelah rugi:
        </span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {DAILY_LOSS_LIMIT_CHOICES.map((percent) => (
            <button
              key={percent}
              type="button"
              id={`daily-limit-btn-${percent}`}
              onClick={() => onChangeDailyLossLimit(percent)}
              className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                dailyLossLimit === percent
                  ? 'bg-sky-500 text-slate-950 shadow-sm'
                  : isDark
                  ? 'text-slate-400 hover:text-white hover:bg-slate-800'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200'
              }`}
            >
              {percent === 0 ? 'Mati' : `${percent}%`}
            </button>
          ))}
        </div>
        <span className={`text-[10px] sm:ml-auto ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {dailyLossLimit === 0
            ? 'Tanpa batas harian: setup tetap ditawarkan apa pun hasil hari ini.'
            : `Begitu trade tertutup hari ini rugi ${dailyLossLimit}% dari saldo awal hari itu, tidak ada setup baru sampai hari trading berikutnya (04:00/05:00 WIB).${
                dailyLossLimit === DEFAULT_DAILY_LOSS_LIMIT ? ' 3% paling tahan di uji ulang 24 bulan.' : ''
              }`}
        </span>
      </div>

      {/* Whether the engine re-tunes itself after every closed trade. The
          user's choice, on by default, with what the replay said beside it. */}
      {/* The risk percentage as a ceiling. Most stops sit on the style's widest
          allowed distance, so that is the trade the smallest lot is priced on. */}
      {onChangeRiskGuard &&
        (() => {
          const typicalStop = STYLE_PROFILES[tradingStyle].maxStopDollars;
          const smallest = calculateXAUUSDLotSize(
            equity,
            riskPercentage,
            4000,
            4000 - typicalStop,
            accountType,
            tradingStyle,
            selectedBroker
          );
          const minLotRisk = smallest.exceedsRiskBudget ? smallest.actualRiskDollars : null;
          const minLotPercent = minLotRisk !== null && equity > 0 ? (minLotRisk / equity) * 100 : null;
          return (
            <div
              id="risk-guard-setting"
              className={`flex flex-col sm:flex-row sm:items-center gap-2 mb-4 p-2.5 rounded-xl border ${
                minLotRisk !== null
                  ? isDark
                    ? 'bg-rose-500/5 border-rose-500/30'
                    : 'bg-rose-50 border-rose-200'
                  : isDark
                  ? 'bg-slate-950 border-slate-800'
                  : 'bg-slate-50 border-slate-200'
              }`}
            >
              <span
                className={`text-[11px] px-1 font-medium flex items-center gap-1.5 shrink-0 ${
                  isDark ? 'text-slate-400' : 'text-slate-600'
                }`}
              >
                <ShieldAlert className="w-3 h-3" /> Penjaga risiko:
              </span>
              <div className="flex items-center gap-1.5">
                {[false, true].map((on) => (
                  <button
                    key={String(on)}
                    type="button"
                    id={`risk-guard-${on ? 'on' : 'off'}`}
                    onClick={() => onChangeRiskGuard(on)}
                    className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                      riskGuard === on
                        ? on
                          ? 'bg-emerald-500 text-slate-950 shadow-sm'
                          : 'bg-rose-500 text-white shadow-sm'
                        : isDark
                        ? 'text-slate-400 hover:text-white hover:bg-slate-800'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200'
                    }`}
                  >
                    {on ? 'Aktif' : 'Mati'}
                  </button>
                ))}
              </div>
              <span className={`text-[10px] sm:ml-auto ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {riskGuard
                  ? `Aktif: setup ditolak kalau lot terkecil akan rugi lebih dari ${riskPercentage}% saldo, sudah termasuk spread dan slippage stop.`
                  : `Mati: setup tetap ditawarkan dengan lot terkecil walaupun ruginya lebih dari ${riskPercentage}%. Kartu setup menampilkan angka sebenarnya.`}
                {minLotRisk !== null && minLotPercent !== null && (
                  <span className={`block mt-0.5 font-semibold ${isDark ? 'text-rose-300' : 'text-rose-700'}`}>
                    Di saldo ini, lot terkecil dengan stop biasa {Math.round(typicalStop * 10)} pip rugi{' '}
                    {formatAccountMoney(minLotRisk, accountType)}, {minLotPercent.toFixed(1)}% dari saldo.
                    {riskGuard
                      ? ' Hampir semua setup akan ditolak sampai saldo atau setelan risiko lebih tinggi.'
                      : ''}{' '}
                    Saldo yang pas untuk {riskPercentage}% sekitar{' '}
                    {formatAccountMoney(minLotRisk / (riskPercentage / 100), accountType)}.
                  </span>
                )}
              </span>
            </div>
          );
        })()}

      {onChangeSelfLearning && (
        <div
          id="self-learning-setting"
          className={`flex flex-col sm:flex-row sm:items-center gap-2 mb-4 p-2.5 rounded-xl border ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <span
            className={`text-[11px] px-1 font-medium flex items-center gap-1.5 shrink-0 ${
              isDark ? 'text-slate-400' : 'text-slate-600'
            }`}
          >
            <Brain className="w-3 h-3" /> Self-learning:
          </span>
          <div className="flex items-center gap-1.5">
            {[false, true].map((on) => (
              <button
                key={String(on)}
                type="button"
                id={`self-learning-${on ? 'on' : 'off'}`}
                onClick={() => onChangeSelfLearning(on)}
                className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                  selfLearning === on
                    ? 'bg-sky-500 text-slate-950 shadow-sm'
                    : isDark
                    ? 'text-slate-400 hover:text-white hover:bg-slate-800'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200'
                }`}
              >
                {on ? 'Aktif' : 'Mati'}
              </button>
            ))}
          </div>
          <span className={`text-[10px] sm:ml-auto ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {selfLearning
              ? 'Aktif: setiap trade yang tertutup menyetel ulang engine untuk setup berikutnya. Lihat Hasil untuk apa yang dipelajari. Di uji ulang dua tahun, cara ini menghasilkan sekitar 9% lebih sedikit dari aturan tetap (profit factor 1,28 lawan 1,31).'
              : 'Mati: engine memakai aturan yang sudah diuji. Trade tetap dicatat dan pelajarannya tetap tampil di Hasil.'}
          </span>
        </div>
      )}

      {/* The user's choice between winning more often and earning more. Off by
          default: over two years the engine's own targets earned more. */}
      {onChangeQuickTarget && (
        <div
          id="quick-target-setting"
          className={`flex flex-col sm:flex-row sm:items-center gap-2 mb-4 p-2.5 rounded-xl border ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <span
            className={`text-[11px] px-1 font-medium flex items-center gap-1.5 shrink-0 ${
              isDark ? 'text-slate-400' : 'text-slate-600'
            }`}
          >
            <Target className="w-3 h-3" /> TP Cepat ({QUICK_TARGET_R}R):
          </span>
          <div className="flex items-center gap-1.5">
            {[false, true].map((on) => (
              <button
                key={String(on)}
                type="button"
                id={`quick-target-${on ? 'on' : 'off'}`}
                onClick={() => onChangeQuickTarget(on)}
                className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                  quickTarget === on
                    ? 'bg-sky-500 text-slate-950 shadow-sm'
                    : isDark
                    ? 'text-slate-400 hover:text-white hover:bg-slate-800'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200'
                }`}
              >
                {on ? 'Aktif' : 'Mati'}
              </button>
            ))}
          </div>
          <span className={`text-[10px] sm:ml-auto ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {quickTarget
              ? `Aktif: satu target di ${QUICK_TARGET_R}R, entry, stop, dan lot sama. Sekitar 72% trade terisi menang, masing-masing lebih kecil. Selama dua tahun hasilnya sekitar sepertiga lebih sedikit dari target engine sendiri.`
              : "Mati: target dari engine sendiri. Sekitar 43% trade terisi menang, dan hasilnya paling besar di uji ulang dua tahun."}
          </span>
        </div>
      )}

      {/* Selectors Row: Trading Style, Account Type & Broker */}
      <div
        className={`grid grid-cols-1 md:grid-cols-3 gap-4 mb-4 pb-4 border-b ${
          isDark ? 'border-slate-800/80' : 'border-slate-100'
        }`}
      >
        {/* Trading Style Selector */}
        <div
          className={`border rounded-xl p-3.5 ${
            isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-500" />
              <span className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                Gaya Trading
              </span>
            </div>
            <span className="text-[11px] text-amber-500 font-medium">
              {tradingStyle === 'Scalping'
                ? 'Putaran M15/M5'
                : tradingStyle === 'Intraday'
                ? 'Siklus H1/M15'
                : 'Swing D1/H4'}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {(['Scalping', 'Intraday', 'Swing'] as TradingStyle[]).map((style) => (
              <button
                key={style}
                type="button"
                id={`style-btn-${style.toLowerCase()}`}
                onClick={() => onChangeTradingStyle(style)}
                className={`py-2 px-2 rounded-lg text-left transition-all border cursor-pointer ${
                  tradingStyle === style
                    ? isDark
                      ? 'bg-amber-500/15 border-amber-500/60 text-white shadow-sm'
                      : 'bg-amber-100 border-amber-400 text-amber-950 shadow-sm'
                    : isDark
                    ? 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <div className="text-xs font-bold flex items-center justify-between">
                  <span>{style}</span>
                  {tradingStyle === style && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
                </div>
                <div className={`text-[10px] mt-0.5 truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {stopBandLabel(style)}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Account Type Selector */}
        <div
          className={`border rounded-xl p-3.5 ${
            isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Briefcase className="w-4 h-4 text-sky-500" />
              <span className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                Jenis Akun
              </span>
            </div>
            <span className="text-[11px] text-sky-500 font-medium">
              {accountType === 'Standard'
                ? 'Lot Standar'
                : accountType === 'Cent'
                ? 'Cent Mikro'
                : 'ECN Raw'}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {(['Standard', 'Cent', 'Pro'] as AccountType[]).map((acc) => {
              const centDisabled = acc === 'Cent' && !currentBroker.supportsCent;
              return (
                <button
                  key={acc}
                  type="button"
                  id={`account-btn-${acc.toLowerCase()}`}
                  disabled={centDisabled}
                  onClick={() => onChangeAccountType(acc)}
                  className={`py-2 px-2 rounded-lg text-left transition-all border cursor-pointer ${
                    centDisabled
                      ? 'opacity-40 cursor-not-allowed border-slate-800'
                      : accountType === acc
                      ? isDark
                        ? 'bg-sky-500/15 border-sky-500/60 text-white shadow-sm'
                        : 'bg-sky-100 border-sky-400 text-sky-950 shadow-sm'
                      : isDark
                      ? 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                      : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  <div className="text-xs font-bold flex items-center justify-between">
                    <span>{acc}</span>
                    {accountType === acc && <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />}
                  </div>
                  <div className={`text-[10px] mt-0.5 truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {acc === 'Standard' ? 'Komisi $0' : acc === 'Cent' ? (centDisabled ? 'N/A' : 'USC') : 'Raw'}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Broker Quick Switcher */}
        <div
          className={`border rounded-xl p-3.5 ${
            isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-500" />
              <span className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                Pilihan Broker
              </span>
            </div>
            <span className="text-[11px] text-emerald-400 font-mono font-bold">
              {getBrokerSpreadForTier(selectedBroker)} pip spread
            </span>
          </div>

          <div className="relative">
            <select
              id="broker-select-dropdown"
              value={selectedBroker}
              onChange={(e) => {
                const bId = e.target.value as BrokerId;
                onChangeBroker(bId);
                // If the newly chosen broker doesn't support cent and current account is Cent, switch to Standard
                const bProfile = BROKER_PROFILES[bId];
                if (accountType === 'Cent' && !bProfile.supportsCent) {
                  onChangeAccountType('Standard');
                }
              }}
              className={`w-full py-2 px-3 rounded-lg border text-xs font-bold outline-none cursor-pointer ${
                isDark
                  ? 'bg-slate-900 border-slate-700 text-white focus:border-emerald-500'
                  : 'bg-white border-slate-300 text-slate-900 focus:border-emerald-500'
              }`}
            >
              {Object.values(BROKER_PROFILES).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} • {accountType === 'Pro' ? `${b.spreadProPips}p Raw` : accountType === 'Cent' ? `${b.spreadCentPips || b.spreadStandardPips}p Cent` : `${b.spreadStandardPips}p`} ({b.regulation})
                </option>
              ))}
            </select>
          </div>
          <div className={`text-[10px] mt-2 flex items-center justify-between ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            <span>{currentBroker.tagline}</span>
            {currentBroker.popularInIndonesia && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-semibold border border-emerald-500/30">
                Populer di Indonesia
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main Content: Locked State vs Input State */}
      {!isLocked || isBroke ? (
        <form onSubmit={handleConfirmLock} className="space-y-4">
          <div
            className={`border rounded-xl p-4 ${
              isDark ? 'bg-slate-950 border-amber-500/30' : 'bg-amber-50/50 border-amber-300'
            }`}
          >
            <div className="flex items-start gap-3">
              <Shield className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <h3 className={`text-sm font-bold ${isDark ? 'text-amber-300' : 'text-amber-900'}`}>
                  Atur dan Kunci Saldo Awal &amp; Pilih Broker
                </h3>
                <p className={`text-xs mt-1 leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Masukkan saldo akunmu di bawah dalam USD. Setelah dikunci, modal ini dibekukan supaya disiplin terjaga. Spread dan komisi berbeda untuk tiap broker (mis. HFM, Exness, IC Markets), dan langsung memengaruhi ukuran lot XAUUSD serta perhitungan take profit bersih.
                </p>
              </div>
            </div>

            {/* Broker selection cards when inputting manual equity */}
            <div className="mt-4">
              <label className={`block text-xs font-bold uppercase tracking-wider mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Pilih Broker Eksekusi (Spread Tiap Broker Berbeda):
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {Object.values(BROKER_PROFILES).map((broker) => {
                  const isSelected = selectedBroker === broker.id;
                  const spreadVal = getBrokerSpreadForTier(broker.id);
                  const centDisabled = accountType === 'Cent' && !broker.supportsCent;

                  return (
                    <button
                      key={broker.id}
                      type="button"
                      id={`broker-card-${broker.id.toLowerCase()}`}
                      disabled={centDisabled}
                      onClick={() => {
                        onChangeBroker(broker.id);
                        if (accountType === 'Cent' && !broker.supportsCent) {
                          onChangeAccountType('Standard');
                        }
                      }}
                      className={`p-2.5 rounded-xl text-left border transition-all cursor-pointer relative ${
                        centDisabled
                          ? 'opacity-40 cursor-not-allowed border-slate-800'
                          : isSelected
                          ? isDark
                            ? 'bg-emerald-500/15 border-emerald-500 text-white ring-1 ring-emerald-500/30 shadow-sm'
                            : 'bg-emerald-50 border-emerald-500 text-slate-900 ring-1 ring-emerald-500/30 shadow-sm'
                          : isDark
                          ? 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                          : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold truncate">{broker.name}</span>
                        {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 font-mono text-[11px]">
                        <span className={`font-bold ${isSelected ? 'text-emerald-400' : isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                          {spreadVal} pips
                        </span>
                        <span className={`text-[9px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>spread</span>
                      </div>
                      <div className="flex items-center justify-between mt-1 text-[9px] text-slate-400">
                        <span className="truncate">{broker.regulation}</span>
                        {broker.popularInIndonesia && (
                          <span className="text-[8px] font-semibold text-amber-400">Popular ID</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-4 flex flex-col sm:flex-row items-center gap-3">
              <div className="relative w-full sm:w-64">
                <span className={`absolute left-3.5 top-1/2 -translate-y-1/2 font-bold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  $
                </span>
                <input
                  id="equity-input"
                  type="number"
                  min="1"
                  step="any"
                  value={inputVal}
                  onChange={(e) => setInputVal(e.target.value)}
                  placeholder="mis. 5000"
                  className={`w-full border rounded-xl pl-8 pr-4 py-2.5 text-base font-mono font-bold outline-none ${
                    isDark
                      ? 'bg-slate-900 border-slate-700 text-white focus:border-amber-500'
                      : 'bg-white border-slate-300 text-slate-900 focus:border-amber-500 shadow-2xs'
                  }`}
                />
                {depositPreview && (
                  <p className="text-[11px] mt-1.5 text-sky-500 font-mono">
                    Tampil sebagai {depositPreview} di akun cent.
                  </p>
                )}
              </div>

              <button
                type="submit"
                id="lock-equity-btn"
                className="w-full sm:w-auto bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm px-5 py-2.5 rounded-xl shadow transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
              >
                <Lock className="w-4 h-4" />
                <span>Konfirmasi &amp; Kunci Equity</span>
              </button>
            </div>

            {errorMsg && <p className="text-xs text-rose-500 mt-2">{errorMsg}</p>}
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3.5">
            {/* Current Locked Balance */}
            <div
              className={`border rounded-xl p-3.5 ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className={`flex items-center justify-between text-xs mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                <span>Equity Akun Terkunci</span>
                <Lock className="w-3.5 h-3.5 text-amber-500" />
              </div>
              {editing ? (
                <form onSubmit={saveEdit} className="flex items-center gap-1.5 mt-1">
                  <input
                    id="equity-edit-input"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    autoFocus
                    value={editVal}
                    onChange={(e) => setEditVal(e.target.value)}
                    className={`w-full min-w-0 border rounded-lg px-2 py-1 text-base font-mono font-bold outline-none ${
                      isDark ? 'bg-slate-900 border-slate-700 text-white focus:border-emerald-500' : 'bg-white border-slate-300 text-slate-900 focus:border-emerald-500'
                    }`}
                  />
                  <span className={`text-[11px] font-bold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {isCentAccount(accountType) ? 'USC' : 'USD'}
                  </span>
                  <button type="submit" id="equity-edit-save" className="px-2 py-1 rounded-lg bg-emerald-500 text-slate-950 text-xs font-bold cursor-pointer">
                    Simpan
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className={`px-2 py-1 rounded-lg text-xs font-bold cursor-pointer ${isDark ? 'text-slate-400' : 'text-slate-600'}`}
                  >
                    Batal
                  </button>
                </form>
              ) : (
                <div className="flex items-center gap-2">
                  <div id="locked-equity-display" className="text-2xl font-black font-mono text-emerald-500">
                    {balanceDisplay}
                  </div>
                  <button
                    type="button"
                    id="equity-edit-btn"
                    onClick={startEdit}
                    className={`text-[11px] font-bold px-2 py-0.5 rounded-md border cursor-pointer ${
                      isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    Ubah
                  </button>
                </div>
              )}
              {editError && <p className="text-[11px] text-rose-500 mt-1">{editError}</p>}
              <div className={`text-[11px] mt-1 flex items-center gap-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {isCent ? (
                  <span className="text-sky-500 font-medium">
                    Akun cent &bull; {formatAccountMoney(equity, 'Standard')} disetor
                  </span>
                ) : (
                  <>
                    <CheckCircle2 className="w-3 h-3 text-emerald-500" /> Patokan Institusional
                  </>
                )}
              </div>
            </div>

            {/* Risk Allocation Per Position */}
            <div
              className={`border rounded-xl p-3.5 ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className={`flex items-center justify-between text-xs mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                <span>Risiko per Setup ({riskPercentage}%)</span>
                <Shield className="w-3.5 h-3.5 text-sky-500" />
              </div>
              <div className="text-2xl font-black font-mono text-amber-500">
                {riskDisplay}
              </div>
              <div className={`text-[11px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {tradingStyle === 'Scalping'
                  ? 'Stop ketat untuk M15/M5'
                  : tradingStyle === 'Intraday'
                  ? 'Batas rugi untuk SL sesi'
                  : 'Jarak lebar untuk swing D1'}
              </div>
            </div>

            {/* Active Broker & Spread */}
            <div
              className={`border rounded-xl p-3.5 ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className={`flex items-center justify-between text-xs mb-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                <span>Broker &amp; Spread</span>
                <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider font-mono">
                  {getBrokerSpreadForTier(selectedBroker)} Pips
                </span>
              </div>
              <div className="text-xl font-black truncate text-slate-100">
                {currentBroker.name}
              </div>
              <div className={`text-[11px] mt-1 truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {accountType === 'Pro'
                  ? `Raw + $${currentBroker.commissionProPerLot}/lot komisi`
                  : `${accountType} spread mengambang`}
              </div>
            </div>

            {/* Capital Status & Lock Enforcement */}
            <div
              className={`border rounded-xl p-3.5 flex flex-col justify-between ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className={`flex items-center justify-between text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                <span>Kerangka Eksekusi</span>
                <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-wider">
                  {tradingStyle} • {accountType}
                </span>
              </div>
              <div className={`text-xs mt-1 leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                Modal dibekukan. Ukuran lot disesuaikan untuk {accountType === 'Cent' ? 'Cent Lot' : 'Lot Standard/Pro'}.
              </div>
              {equity <= 0 && (
                <button
                  id="reset-equity-btn"
                  type="button"
                  onClick={onResetEquity}
                  className="mt-2 text-xs font-bold text-rose-500 hover:text-rose-400 underline cursor-pointer"
                >
                  Atur Ulang Akun yang Habis
                </button>
              )}
            </div>
          </div>

          {/* Dynamic Execution Profile Advice */}
          <div
            className={`border rounded-xl px-3.5 py-2.5 flex items-center gap-2.5 text-xs ${
              isDark
                ? 'bg-slate-950/60 border-slate-800/80 text-slate-300'
                : 'bg-slate-50 border-slate-200 text-slate-700'
            }`}
          >
            <Info className="w-4 h-4 text-amber-500 shrink-0" />
            <span>
              <strong>Matriks Eksekusi:</strong> Broker yang dipakai <strong>{currentBroker.name}</strong> ({getBrokerSpreadForTier(selectedBroker)} pips spread emas biasa).{' '}
              {accountType === 'Cent'
                ? `Akun Cent memakai ukuran kontrak 1 Troy Oz (1/100 standar). Ukuran lot yang disarankan ditulis dalam Cent Lot supaya modal kecil terlindungi.`
                : accountType === 'Pro'
                ? `Akun Pro memakai spread raw (~${currentBroker.spreadProPips} pips). Komisi pulang-pergi $${currentBroker.commissionProPerLot.toFixed(2)}/lot langsung dihitung ke dalam risiko posisi.`
                : `Akun Standard memakai kontrak standar 100 Troy Oz, dengan semua biaya broker sudah termasuk dalam spread mengambang.`}{' '}
              {tradingStyle === 'Scalping'
                ? `Stop loss dibuat ketat, antara ${stopBandPips('Scalping').min} dan ${
                    stopBandPips('Scalping').max
                  } pips, untuk pergerakan pasar yang cepat.`
                : tradingStyle === 'Swing'
                ? `Stop loss diperlebar antara ${stopBandPips('Swing').min} dan ${
                    stopBandPips('Swing').max
                  } pips untuk menangkap pergerakan besar.`
                : `Stop loss diatur antara ${stopBandPips('Intraday').min} dan ${
                    stopBandPips('Intraday').max
                  } pips untuk pergerakan likuiditas sesi harian.`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

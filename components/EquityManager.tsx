'use client';

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
} from 'lucide-react';
import { TradingStyle, AccountType, BrokerId, BROKER_PROFILES } from '@/lib/types';
import { formatAccountMoney, isCentAccount } from '@/lib/account-display';
import { stopBandLabel, stopBandPips } from '@/lib/style-profiles';

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
  onChangeRiskPct: (pct: number) => void;
  onChangeMinConviction: (score: number) => void;
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
  onChangeRiskPct,
  onChangeMinConviction,
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
      setErrorMsg('Please enter a valid initial equity amount greater than $0.00');
      return;
    }
    setErrorMsg('');
    onLockEquity(val);
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
              Capital &amp; Account Configuration
              {isLocked && !isBroke ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 border border-amber-500/30">
                  <Lock className="w-3 h-3" /> Locked
                </span>
              ) : isBroke ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-500 border border-rose-500/30">
                  <AlertTriangle className="w-3 h-3" /> Depleted ($0.00)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-500 border border-sky-500/30">
                  <Unlock className="w-3 h-3" /> Setup Needed
                </span>
              )}
            </h2>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Institutional risk allocation: Tailored for your execution style and broker account tier.
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
            <Percent className="w-3 h-3" /> Risk Budget:
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
          <Filter className="w-3 h-3" /> Only trade conviction above:
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
              {score === 0 ? 'Take all' : score}
            </button>
          ))}
        </div>
        <span className={`text-[10px] sm:ml-auto ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          {minConviction === 0
            ? 'Every setup the engine produces is offered.'
            : `Setups scoring under ${minConviction} are declined instead of traded. Test a floor in the Backtest Lab first.`}
        </span>
      </div>

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
                Trading Style
              </span>
            </div>
            <span className="text-[11px] text-amber-500 font-medium">
              {tradingStyle === 'Scalping'
                ? 'M15/M5 Turnover'
                : tradingStyle === 'Intraday'
                ? 'H1/M15 Cycles'
                : 'D1/H4 Swings'}
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
                Account Tier
              </span>
            </div>
            <span className="text-[11px] text-sky-500 font-medium">
              {accountType === 'Standard'
                ? 'Standard Lot'
                : accountType === 'Cent'
                ? 'Cent Micro'
                : 'Raw ECN'}
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
                    {acc === 'Standard' ? '$0 Comm' : acc === 'Cent' ? (centDisabled ? 'N/A' : 'USC') : 'Raw'}
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
                Broker Selection
              </span>
            </div>
            <span className="text-[11px] text-emerald-400 font-mono font-bold">
              {getBrokerSpreadForTier(selectedBroker)} pips spread
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
                Top in Indonesia
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
                  Set and Lock Initial Trading Balance &amp; Select Broker
                </h3>
                <p className={`text-xs mt-1 leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  Enter your account balance below in USD. Once locked, this capital amount is frozen to enforce
                  institutional discipline. Spreads and commissions vary per broker (e.g. HFM, Exness, IC Markets),
                  directly calibrating your XAUUSD lot size and net take-profit calculations.
                </p>
              </div>
            </div>

            {/* Broker selection cards when inputting manual equity */}
            <div className="mt-4">
              <label className={`block text-xs font-bold uppercase tracking-wider mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Select Execution Broker (Different Brokers Have Different Spreads):
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
                  placeholder="e.g. 5000"
                  className={`w-full border rounded-xl pl-8 pr-4 py-2.5 text-base font-mono font-bold outline-none ${
                    isDark
                      ? 'bg-slate-900 border-slate-700 text-white focus:border-amber-500'
                      : 'bg-white border-slate-300 text-slate-900 focus:border-amber-500 shadow-2xs'
                  }`}
                />
                {depositPreview && (
                  <p className="text-[11px] mt-1.5 text-sky-500 font-mono">
                    Shown as {depositPreview} on a cent account.
                  </p>
                )}
              </div>

              <button
                type="submit"
                id="lock-equity-btn"
                className="w-full sm:w-auto bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm px-5 py-2.5 rounded-xl shadow transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
              >
                <Lock className="w-4 h-4" />
                <span>Confirm &amp; Permanently Lock Equity</span>
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
                <span>Locked Account Equity</span>
                <Lock className="w-3.5 h-3.5 text-amber-500" />
              </div>
              <div id="locked-equity-display" className="text-2xl font-black font-mono text-emerald-500">
                {balanceDisplay}
              </div>
              <div className={`text-[11px] mt-1 flex items-center gap-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {isCent ? (
                  <span className="text-sky-500 font-medium">
                    Cent account &bull; {formatAccountMoney(equity, 'Standard')} deposited
                  </span>
                ) : (
                  <>
                    <CheckCircle2 className="w-3 h-3 text-emerald-500" /> Institutional Anchor
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
                <span>Risk Per Setup ({riskPercentage}%)</span>
                <Shield className="w-3.5 h-3.5 text-sky-500" />
              </div>
              <div className="text-2xl font-black font-mono text-amber-500">
                {riskDisplay}
              </div>
              <div className={`text-[11px] mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {tradingStyle === 'Scalping'
                  ? 'Tight stop allowance on M15/M5'
                  : tradingStyle === 'Intraday'
                  ? 'Max loss tolerance on session SL'
                  : 'Wide buffer for macro D1 swing'}
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
                  ? `Raw + $${currentBroker.commissionProPerLot}/lot comm`
                  : `${accountType} floating spread`}
              </div>
            </div>

            {/* Capital Status & Lock Enforcement */}
            <div
              className={`border rounded-xl p-3.5 flex flex-col justify-between ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className={`flex items-center justify-between text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                <span>Execution Framework</span>
                <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-wider">
                  {tradingStyle} • {accountType}
                </span>
              </div>
              <div className={`text-xs mt-1 leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                Capital frozen. Sizing calibrated for {accountType === 'Cent' ? 'Cent Lots' : 'Standard/Pro Lots'}.
              </div>
              {equity <= 0 && (
                <button
                  id="reset-equity-btn"
                  type="button"
                  onClick={onResetEquity}
                  className="mt-2 text-xs font-bold text-rose-500 hover:text-rose-400 underline cursor-pointer"
                >
                  Reset Depleted Account
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
              <strong>Execution Matrix:</strong> Broker is set to <strong>{currentBroker.name}</strong> ({getBrokerSpreadForTier(selectedBroker)} pips typical gold spread).{' '}
              {accountType === 'Cent'
                ? `Cent Account applies 1 Troy Oz contract size (1/100 standard). Recommended lot size will be expressed in Cent Lots to protect small equity.`
                : accountType === 'Pro'
                ? `Pro Account utilizes raw spreads (~${currentBroker.spreadProPips} pips). A $${currentBroker.commissionProPerLot.toFixed(2)}/lot round turn commission is accounted for directly in position risk.`
                : `Standard Account utilizes standard 100 Troy Oz contracts with all broker fees incorporated into floating spreads.`}{' '}
              {tradingStyle === 'Scalping'
                ? `Stop losses are framed tightly, between ${stopBandPips('Scalping').min} and ${
                    stopBandPips('Scalping').max
                  } pips, for fast market turns.`
                : tradingStyle === 'Swing'
                ? `Stop losses are broadened to between ${stopBandPips('Swing').min} and ${
                    stopBandPips('Swing').max
                  } pips to capture macro institutional expansions.`
                : `Stop losses are calibrated between ${stopBandPips('Intraday').min} and ${
                    stopBandPips('Intraday').max
                  } pips for daily session liquidity runs.`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

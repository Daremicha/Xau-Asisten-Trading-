import { describe, expect, test } from 'bun:test';
import {
  calculateXAUUSDLotSize,
  formatUtcHourToLocal,
  getContractSpecification,
  getGlobalTradingSessions,
  getICTKillZoneStatus,
  recalculateEngineWeights,
  STOP_SLIPPAGE_DOLLARS,
} from '../lib/market-engine';
import { deriveAdaptiveWeights } from '../lib/learning-engine';
import { BROKER_PROFILES, type AccountType, type BrokerId, type TradingStyle } from '../lib/types';

const BROKERS = Object.keys(BROKER_PROFILES) as BrokerId[];

/** What one ounce loses at the stop: the distance, the spread, and the slip. */
function lossPerOz(calc: ReturnType<typeof calculateXAUUSDLotSize>): number {
  return calc.priceDistance + calc.contractSpecs.typicalSpreadPips * 0.1 + STOP_SLIPPAGE_DOLLARS;
}
const ACCOUNTS: AccountType[] = ['Standard', 'Cent', 'Pro'];
const STYLES: TradingStyle[] = ['Scalping', 'Intraday', 'Swing'];

/** A UTC moment, written out so a failure names the day and hour it broke on. */
function utc(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

describe('what a lot is worth on each account', () => {
  test('a cent lot is a single ounce, a standard lot a hundred', () => {
    // This ratio is the whole reason a cent account exists: the same dollar of
    // stop costs a hundredth as much, so a small balance can still respect a
    // one percent budget.
    expect(getContractSpecification('Cent').contractSizeOz).toBe(1);
    expect(getContractSpecification('Standard').contractSizeOz).toBe(100);
    expect(getContractSpecification('Pro').contractSizeOz).toBe(100);
  });

  test('only the ECN account charges commission', () => {
    // Standard and Cent bury the fee in the spread; Pro bills it separately,
    // which is why the lot maths has to subtract it rather than ignore it.
    expect(getContractSpecification('Standard', 'EXNESS').commissionPerLot).toBe(0);
    expect(getContractSpecification('Cent', 'EXNESS').commissionPerLot).toBe(0);
    expect(getContractSpecification('Pro', 'EXNESS').commissionPerLot).toBe(3.5);
    expect(getContractSpecification('Pro', 'IC_MARKETS').commissionPerLot).toBe(7);
  });

  test('the spread quoted is the one that broker actually charges', () => {
    for (const brokerId of BROKERS) {
      const profile = BROKER_PROFILES[brokerId];
      expect(getContractSpecification('Standard', brokerId).typicalSpreadPips).toBe(profile.spreadStandardPips);
      expect(getContractSpecification('Pro', brokerId).typicalSpreadPips).toBe(profile.spreadProPips);
    }
  });

  test('a broker with no cent book falls back to a stated figure, not undefined', () => {
    // IC Markets offers no cent account — the selector blocks that pairing — but
    // the function must still answer with a number rather than leaving NaN to
    // travel into the risk maths.
    expect(BROKER_PROFILES.IC_MARKETS.spreadCentPips).toBeUndefined();
    expect(getContractSpecification('Cent', 'IC_MARKETS').typicalSpreadPips).toBe(2.5);
  });

  test('an unknown broker falls back to Exness rather than crashing', () => {
    const specs = getContractSpecification('Standard', 'NOT_A_BROKER' as BrokerId);
    expect(specs.brokerName).toBe('Exness');
    expect(specs.typicalSpreadPips).toBe(BROKER_PROFILES.EXNESS.spreadStandardPips);
  });

  test('the explanation names the broker the trader picked', () => {
    for (const brokerId of BROKERS) {
      for (const account of ACCOUNTS) {
        const specs = getContractSpecification(account, brokerId);
        expect(specs.brokerId).toBe(brokerId);
        expect(specs.explanation).toContain(BROKER_PROFILES[brokerId].name);
      }
    }
  });

  test('an unrecognised account type is treated as Standard', () => {
    const specs = getContractSpecification('Islamic' as AccountType, 'EXNESS');
    expect(specs.lotUnit).toBe('Standard Lots');
    expect(specs.contractSizeOz).toBe(100);
  });
});

describe('the lot never risks more than the budget allows', () => {
  test('a normal account sizes to the budget and stays under it', () => {
    // A ten dollar stop loses 10.38 an ounce once the 1.8 pip spread and the
    // 0.20 stop slip are paid, so 50 dollars buys 0.04 lots, not 0.05.
    const calc = calculateXAUUSDLotSize(5000, 1, 4200, 4190, 'Standard', 'Intraday', 'EXNESS');
    expect(calc.riskDollars).toBe(50);
    expect(calc.lotSize).toBe(0.04);
    expect(calc.actualRiskDollars).toBeCloseTo(0.04 * 1038, 4);
    expect(calc.actualRiskDollars).toBeLessThanOrEqual(calc.riskDollars);
    expect(calc.exceedsRiskBudget).toBe(false);
  });

  test('a lot that does not divide evenly is rounded down, never up', () => {
    // 50 dollars over a 3.70 stop that loses 4.08 with costs is 0.1225 lots.
    // Rounding to 0.13 would risk 53.04, more than the trader asked for.
    const calc = calculateXAUUSDLotSize(5000, 1, 4200, 4196.3, 'Standard', 'Intraday', 'EXNESS');
    expect(calc.lotSize).toBe(0.12);
    expect(calc.actualRiskDollars).toBeCloseTo(48.96, 4);
    expect(calc.actualRiskDollars).toBeLessThanOrEqual(calc.riskDollars);
  });

  test('the spread and the stop slip are part of the risk, not extra to it', () => {
    // Sizing on the stop distance alone let the real loss run past the budget
    // by the spread and the slip on every trade.
    for (const brokerId of BROKERS) {
      for (const account of ACCOUNTS) {
        for (const style of STYLES) {
          const calc = calculateXAUUSDLotSize(5000, 1, 4200, 4187.37, account, style, brokerId);
          if (calc.exceedsRiskBudget) continue;
          const realLoss =
            calc.lotSize * (lossPerOz(calc) * calc.contractSpecs.contractSizeOz + calc.contractSpecs.commissionPerLot);
          expect(realLoss).toBeLessThanOrEqual(calc.riskDollars + 0.005);
        }
      }
    }
  });

  test('rounding down holds across every account, style and broker', () => {
    // A sweep rather than a handful of cases, because the one place this is
    // allowed to break the budget is the minimum lot, and that announces itself.
    for (const brokerId of BROKERS) {
      for (const account of ACCOUNTS) {
        for (const style of STYLES) {
          const calc = calculateXAUUSDLotSize(5000, 1, 4200, 4187.37, account, style, brokerId);
          if (calc.exceedsRiskBudget) continue;
          expect(calc.actualRiskDollars).toBeLessThanOrEqual(calc.riskDollars + 0.005);
        }
      }
    }
  });

  test('the ECN commission is priced into the risk', () => {
    // 3.50 a lot sounds like nothing until it is priced as risk.
    const pro = calculateXAUUSDLotSize(5000, 2, 4200, 4190, 'Pro', 'Intraday', 'EXNESS');
    expect(pro.lotSize).toBe(0.09);
    expect(pro.actualRiskDollars).toBeCloseTo(0.09 * (lossPerOz(pro) * 100 + 3.5), 4);
    expect(pro.actualRiskDollars).toBeLessThanOrEqual(pro.riskDollars);
  });

  test('a commission free ECN book sizes exactly like Standard', () => {
    // HFM charges nothing per Pro lot, so there is nothing for the maths to
    // subtract and the two accounts must agree.
    const pro = calculateXAUUSDLotSize(5000, 2, 4200, 4190, 'Pro', 'Intraday', 'HFM');
    const standard = calculateXAUUSDLotSize(5000, 2, 4200, 4190, 'Standard', 'Intraday', 'HFM');
    expect(BROKER_PROFILES.HFM.commissionProPerLot).toBe(0);
    expect(pro.lotSize).toBe(standard.lotSize);
  });

  test('a cent lot loses a dollar for a dollar of stop, plus the costs', () => {
    // One ounce a lot, so a ten dollar stop costs 10.44 per whole cent lot
    // with the 2.4 pip spread and the slip, and the reported risk says so.
    const calc = calculateXAUUSDLotSize(200, 1, 4200, 4190, 'Cent', 'Intraday', 'EXNESS');
    expect(calc.riskDollars).toBe(2);
    expect(calc.lotSize).toBe(0.19);
    expect(calc.actualRiskDollars).toBeCloseTo(0.19 * 10.44, 4);
  });

  test('the risk reported matches the contract the same call describes', () => {
    // The money maths writes the ounces per lot out as a literal rather than
    // reading contractSizeOz. That is fine while the two agree and silently
    // wrong the day one of them moves, so the test holds them together.
    for (const account of ACCOUNTS) {
      const calc = calculateXAUUSDLotSize(5000, 2, 4200, 4185, account, 'Intraday', 'EXNESS');
      const perLot = lossPerOz(calc) * calc.contractSpecs.contractSizeOz + calc.contractSpecs.commissionPerLot;
      expect(calc.actualRiskDollars).toBeCloseTo(calc.lotSize * perLot, 4);
    }
  });

  test('the budget keeps four decimals, because two is a whole cent', () => {
    // On a cent account a hundredth of a dollar is a unit of currency. Rounding
    // 4.5 cent to 5 made the figure on screen disagree with the percentage that
    // produced it.
    const calc = calculateXAUUSDLotSize(9.01, 0.5, 4300, 4290, 'Cent', 'Intraday', 'EXNESS');
    expect(calc.riskDollars).toBeCloseTo(0.045, 6);
    expect(calc.riskDollars).not.toBe(0.05);
  });
});

describe('when the budget cannot buy the smallest lot', () => {
  test('the forced over-risk is flagged rather than hidden', () => {
    // A 10 dollar cent balance at one percent is a 10 cent budget, and the
    // smallest lot the broker will accept risks 18. The trade is still
    // placeable; the screen just has to stop calling it one percent.
    const calc = calculateXAUUSDLotSize(10, 1, 4200, 4182, 'Cent', 'Intraday', 'EXNESS');
    expect(calc.lotSize).toBe(0.01);
    expect(calc.riskDollars).toBeCloseTo(0.1, 4);
    expect(calc.actualRiskDollars).toBeCloseTo(0.01 * (18 + 0.24 + STOP_SLIPPAGE_DOLLARS), 4);
    expect(calc.exceedsRiskBudget).toBe(true);
  });

  test('a budget met exactly is not reported as an overshoot', () => {
    // The flag carries a half cent of tolerance so floating point noise on an
    // exact fit does not raise a warning about nothing.
    // 9.62 of stop plus 0.38 of costs is exactly ten dollars an ounce.
    const calc = calculateXAUUSDLotSize(5000, 1, 4200, 4190.38, 'Standard', 'Intraday', 'EXNESS');
    expect(calc.actualRiskDollars).toBeCloseTo(calc.riskDollars, 4);
    expect(calc.exceedsRiskBudget).toBe(false);
  });

  test('a lot capped at the ceiling under-risks, and is not flagged', () => {
    // The caps exist so a mistyped balance cannot propose a lot no broker will
    // fill. Capping always reduces risk, so it is not the over-risk warning.
    const cent = calculateXAUUSDLotSize(1_000_000, 100, 4200, 4199, 'Cent', 'Intraday', 'EXNESS');
    expect(cent.lotSize).toBe(500);
    expect(cent.exceedsRiskBudget).toBe(false);

    for (const account of ['Standard', 'Pro'] as const) {
      const calc = calculateXAUUSDLotSize(10_000_000, 10, 4200, 4199, account, 'Intraday', 'EXNESS');
      expect(calc.lotSize).toBe(50);
      expect(calc.exceedsRiskBudget).toBe(false);
    }
  });
});

describe('a stop tighter than the style allows', () => {
  test('is widened to the floor for that style', () => {
    // Without a floor a stop of a few cents divides the budget into a lot no
    // broker would fill, and a single tick of spread would close it.
    const floors: Record<TradingStyle, number> = { Scalping: 0.3, Intraday: 0.8, Swing: 2.0 };
    for (const style of STYLES) {
      const calc = calculateXAUUSDLotSize(5000, 1, 4200, 4199.9, 'Standard', style, 'EXNESS');
      expect(calc.priceDistance).toBe(floors[style]);
      expect(calc.stopLossPips).toBe(Math.round(floors[style] * 10));
    }
  });

  test('a stop wider than the floor passes through untouched', () => {
    const calc = calculateXAUUSDLotSize(5000, 1, 4200, 4190, 'Standard', 'Intraday', 'EXNESS');
    expect(calc.priceDistance).toBe(10);
    expect(calc.stopLossPips).toBe(100);
  });

  test('the direction of the stop does not change the size', () => {
    // A sell parks its stop above entry; the distance is what matters.
    const long = calculateXAUUSDLotSize(5000, 1, 4200, 4190, 'Standard', 'Intraday', 'EXNESS');
    const short = calculateXAUUSDLotSize(5000, 1, 4200, 4210, 'Standard', 'Intraday', 'EXNESS');
    expect(short.lotSize).toBe(long.lotSize);
    expect(short.priceDistance).toBe(long.priceDistance);
  });

  test('the lot is sized on the widened stop, so it under-risks rather than over', () => {
    // The trader's real stop is 10 cents but the lot is priced against 80. If
    // that stop is genuinely hit the loss is an eighth of the budget — the safe
    // side of the error.
    const calc = calculateXAUUSDLotSize(5000, 1, 4200, 4199.9, 'Standard', 'Intraday', 'EXNESS');
    expect(calc.actualRiskDollars).toBeLessThanOrEqual(calc.riskDollars);
    expect(calc.lotSize * 0.1 * 100).toBeLessThan(calc.riskDollars);
  });
});

describe('a balance or budget that cannot be traded', () => {
  test('a zero balance returns the minimum lot and no risk, without dividing by zero', () => {
    for (const account of ACCOUNTS) {
      const calc = calculateXAUUSDLotSize(0, 1, 4200, 4190, account, 'Intraday', 'EXNESS');
      expect(calc.lotSize).toBe(0.01);
      expect(calc.riskDollars).toBe(0);
      expect(calc.actualRiskDollars).toBe(0);
      expect(calc.exceedsRiskBudget).toBe(false);
      expect(calc.stopLossPips).toBe(0);
      expect(calc.priceDistance).toBe(0);
    }
  });

  test('a negative balance and a zero percent budget take the same exit', () => {
    for (const [equity, risk] of [[-500, 1], [5000, 0], [5000, -1]] as const) {
      const calc = calculateXAUUSDLotSize(equity, risk, 4200, 4190, 'Standard', 'Intraday', 'EXNESS');
      expect(calc.riskDollars).toBe(0);
      expect(calc.exceedsRiskBudget).toBe(false);
    }
  });

  test('the contract specification is still returned, so the screen can explain itself', () => {
    const calc = calculateXAUUSDLotSize(0, 1, 4200, 4190, 'Cent', 'Intraday', 'FBS');
    expect(calc.contractSpecs.brokerName).toBe('FBS');
    expect(calc.contractSpecs.contractSizeOz).toBe(1);
  });

  test('an entry and a stop at the same price still size on the style floor', () => {
    const calc = calculateXAUUSDLotSize(5000, 1, 4200, 4200, 'Standard', 'Swing', 'EXNESS');
    expect(calc.priceDistance).toBe(2);
    expect(Number.isFinite(calc.lotSize)).toBe(true);
    expect(calc.lotSize).toBeGreaterThan(0);
  });
});

describe('session clocks shown to a trader in Jakarta', () => {
  test('a UTC hour is read out in WIB, which is seven hours ahead', () => {
    expect(formatUtcHourToLocal(0)).toBe('07:00');
    expect(formatUtcHourToLocal(7)).toBe('14:00');
    expect(formatUtcHourToLocal(12)).toBe('19:00');
  });

  test('an hour that crosses midnight wraps instead of reading twenty four', () => {
    // London closes at 16:00 UTC, which is 23:00 in Jakarta; New York's 21:00
    // close is 04:00 the next morning.
    expect(formatUtcHourToLocal(16)).toBe('23:00');
    expect(formatUtcHourToLocal(17)).toBe('00:00');
    expect(formatUtcHourToLocal(21)).toBe('04:00');
  });

  test('minutes are carried through', () => {
    expect(formatUtcHourToLocal(7, 30)).toBe('14:30');
  });
});

describe('the four sessions on the dashboard', () => {
  const sessions = getGlobalTradingSessions();

  test('all four are reported, in the order the screen lays them out', () => {
    expect(sessions.map((s) => s.id)).toEqual(['tokyo', 'london', 'newyork', 'overlap']);
  });

  test('each one states its own opening hour in local time', () => {
    for (const session of sessions) {
      expect(session.localOpenFormatted).toBe(formatUtcHourToLocal(session.utcOpen));
      expect(session.localCloseFormatted).toBe(formatUtcHourToLocal(session.utcClose));
      expect(session.utcClose).toBeGreaterThan(session.utcOpen);
    }
  });

  test('progress stays inside the bar it is drawn in', () => {
    for (const session of sessions) {
      expect(session.progressPercentage).toBeGreaterThanOrEqual(0);
      expect(session.progressPercentage).toBeLessThanOrEqual(100);
      expect(session.statusText.length).toBeGreaterThan(0);
    }
  });

  test('the overlap cannot be running unless both its halves are', () => {
    // It is not a session of its own — it is the window where London and New
    // York are both open — so an overlap without them would be a lie.
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    if (byId.overlap.isActive) {
      expect(byId.london.isActive).toBe(true);
      expect(byId.newyork.isActive).toBe(true);
    }
  });

  test('the weekend closes all four together, never some of them', () => {
    const recessed = sessions.filter((s) => s.statusText.startsWith('Weekend Recess'));
    expect(recessed.length === 0 || recessed.length === sessions.length).toBe(true);
    if (recessed.length === sessions.length) {
      for (const session of sessions) {
        expect(session.isActive).toBe(false);
        expect(session.progressPercentage).toBe(0);
      }
    }
  });

  test('an inactive session says when it opens, an active one when it closes', () => {
    for (const session of sessions) {
      if (session.statusText.startsWith('Weekend Recess')) continue;
      expect(session.statusText).toContain(session.isActive ? 'Closes in' : 'Opens in');
    }
  });
});

describe('kill zones, asked about a specific moment', () => {
  // 2026-09-22 is a Tuesday, an ordinary trading day.
  const TUESDAY = 22;

  test('London open runs from seven to ten UTC', () => {
    expect(getICTKillZoneStatus(utc(2026, 9, TUESDAY, 7)).currentZone).toBe('London Open');
    expect(getICTKillZoneStatus(utc(2026, 9, TUESDAY, 9, 59)).currentZone).toBe('London Open');
    expect(getICTKillZoneStatus(utc(2026, 9, TUESDAY, 10)).currentZone).toBe('Off-Hours');
  });

  test('New York open runs from twelve to fifteen, London close from fifteen to seventeen', () => {
    expect(getICTKillZoneStatus(utc(2026, 9, TUESDAY, 12)).currentZone).toBe('New York Open');
    expect(getICTKillZoneStatus(utc(2026, 9, TUESDAY, 14, 59)).currentZone).toBe('New York Open');
    // The handover is a boundary, not an overlap: fifteen belongs to the close.
    expect(getICTKillZoneStatus(utc(2026, 9, TUESDAY, 15)).currentZone).toBe('London Close');
    expect(getICTKillZoneStatus(utc(2026, 9, TUESDAY, 16, 59)).currentZone).toBe('London Close');
    expect(getICTKillZoneStatus(utc(2026, 9, TUESDAY, 17)).currentZone).toBe('Off-Hours');
  });

  test('the Asian session is named but not called high volatility', () => {
    // It builds the liquidity London later sweeps; sizing up for it would be
    // paying volatility prices for a range.
    const asia = getICTKillZoneStatus(utc(2026, 9, TUESDAY, 2));
    expect(asia.currentZone).toBe('Asian Session');
    expect(asia.isHighVolatilityTiming).toBe(false);
    expect(getICTKillZoneStatus(utc(2026, 9, TUESDAY, 6)).currentZone).toBe('Off-Hours');
  });

  test('every kill zone proper is marked high volatility', () => {
    for (const hour of [7, 8, 9, 12, 13, 14, 15, 16]) {
      expect(getICTKillZoneStatus(utc(2026, 9, TUESDAY, hour)).isHighVolatilityTiming).toBe(true);
    }
    for (const hour of [0, 3, 6, 10, 11, 17, 20, 23]) {
      expect(getICTKillZoneStatus(utc(2026, 9, TUESDAY, hour)).isHighVolatilityTiming).toBe(false);
    }
  });

  test('the weekend recess starts Friday at twenty one hundred UTC', () => {
    // 2026-09-25 is a Friday. The last hour before the close is still a kill
    // zone's tail end of a trading week, not a recess.
    expect(getICTKillZoneStatus(utc(2026, 9, 25, 20, 59)).description).not.toContain('Weekend');
    const shut = getICTKillZoneStatus(utc(2026, 9, 25, 21));
    expect(shut.currentZone).toBe('Off-Hours');
    expect(shut.isHighVolatilityTiming).toBe(false);
    expect(shut.description).toContain('Weekend');
  });

  test('Saturday is closed all day and Sunday reopens at twenty two hundred UTC', () => {
    for (const hour of [0, 8, 13, 23]) {
      expect(getICTKillZoneStatus(utc(2026, 9, 26, hour)).description).toContain('Weekend');
    }
    expect(getICTKillZoneStatus(utc(2026, 9, 27, 21, 59)).description).toContain('Weekend');
    expect(getICTKillZoneStatus(utc(2026, 9, 27, 22)).description).not.toContain('Weekend');
  });

  test('called with no moment at all it answers about now, without throwing', () => {
    const live = getICTKillZoneStatus();
    expect(typeof live.currentZone).toBe('string');
    expect(live.description.length).toBeGreaterThan(0);
  });
});

describe('the engine weights this module hands out', () => {
  test('are the learning engine’s, not a second copy of the same idea', () => {
    // The function is a forwarding address kept for older callers. If it ever
    // starts computing its own numbers, two parts of the app will disagree
    // about what the history says.
    expect(recalculateEngineWeights([], 'Intraday')).toEqual(deriveAdaptiveWeights([], 'Intraday'));
    expect(recalculateEngineWeights([], 'Swing', { orderBlockWeight: 0.4 })).toEqual(
      deriveAdaptiveWeights([], 'Swing', { orderBlockWeight: 0.4 })
    );
  });

  test('an empty history still produces a usable, normalised set', () => {
    const weights = recalculateEngineWeights([]);
    const confluence =
      weights.orderBlockWeight +
      weights.fairValueGapWeight +
      weights.liquiditySweepWeight +
      weights.newsImpactWeight +
      weights.indicatorConfluenceWeight;
    expect(confluence).toBeCloseTo(1, 6);
    expect(weights.totalAnalysesLearned).toBe(0);
    expect(weights.atrBufferFactor).toBeGreaterThan(0);
  });
});

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  LOCAL_KEYS,
  alreadyMigrated,
  hasLocalDataWorthMigrating,
  markMigrated,
  markMirrorOwner,
  mirrorBelongsTo,
  readLocalProfile,
  settingsMissingFromCloud,
  toCloudPatch,
  writeLocalSettings,
} from '../lib/local-store';
import { buildUserDocument } from '../lib/cloud-sync';
import type { SelfLearningMemoryRecord } from '../lib/types';

/** Minimal in-memory stand-in for the browser store. */
function installStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
  return map;
}

function record(id: string, outcome: 'TP' | 'SL' | 'MISSED'): SelfLearningMemoryRecord {
  return {
    id,
    analysisId: `a_${id}`,
    timestamp: '2026-09-01T00:00:00Z',
    outcome,
    symbol: 'XAUUSD',
    orderType: 'BUY LIMIT',
    entryPrice: 4180,
    exitPrice: 4190,
    profitOrLossPips: outcome === 'TP' ? 100 : outcome === 'SL' ? -70 : 0,
    profitOrLossDollars: outcome === 'TP' ? 100 : outcome === 'SL' ? -50 : 0,
    rootCauseAnalysis: { primaryFactor: 'x', institutionalFlowExplanation: 'y', liquidityBehavior: 'z' },
    strategyEvolutionLesson: 'lesson',
    adaptiveWeightAdjustments: {
      fvgWeightDelta: 0, orderBlockWeightDelta: 0, newsFilterWeightDelta: 0, atrBufferMultiplier: 1,
    },
  };
}

beforeEach(() => installStorage());

describe('reading the guest profile', () => {
  test('an empty browser yields nulls, not invented values', () => {
    const p = readLocalProfile();
    expect(p.equity).toBeNull();
    expect(p.isEquityLocked).toBeNull();
    expect(p.learningRecords).toHaveLength(0);
  });

  test('stored values are read back with the right types', () => {
    installStorage({
      [LOCAL_KEYS.equity]: '7500.5',
      [LOCAL_KEYS.initialEquity]: '5000',
      [LOCAL_KEYS.isLocked]: 'true',
      [LOCAL_KEYS.riskPct]: '2',
      [LOCAL_KEYS.style]: 'Swing',
      [LOCAL_KEYS.account]: 'Cent',
      [LOCAL_KEYS.broker]: 'HFM',
      [LOCAL_KEYS.records]: JSON.stringify([record('r1', 'TP'), record('r2', 'SL')]),
    });
    const p = readLocalProfile();
    expect(p.equity).toBe(7500.5);
    expect(p.initialEquity).toBe(5000);
    expect(p.isEquityLocked).toBe(true);
    expect(p.riskPercentage).toBe(2);
    expect(p.tradingStyle).toBe('Swing');
    expect(p.accountType).toBe('Cent');
    expect(p.selectedBroker).toBe('HFM');
    expect(p.learningRecords).toHaveLength(2);
  });

  test('corrupt JSON does not throw, it yields no records', () => {
    installStorage({ [LOCAL_KEYS.records]: '{not json' });
    expect(readLocalProfile().learningRecords).toHaveLength(0);
  });

  test('records missing required fields are discarded', () => {
    installStorage({
      [LOCAL_KEYS.records]: JSON.stringify([record('good', 'TP'), { nonsense: true }, null]),
    });
    const kept = readLocalProfile().learningRecords;
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe('good');
  });

  test('a value stored by an older build with an unknown style is ignored', () => {
    installStorage({ [LOCAL_KEYS.style]: 'Gambling' });
    expect(readLocalProfile().tradingStyle).toBeNull();
  });

  test('storage that throws is treated as empty rather than crashing', () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;
    expect(() => readLocalProfile()).not.toThrow();
    expect(readLocalProfile().equity).toBeNull();
  });
});

describe('deciding whether a transfer is worth doing', () => {
  test('a recorded trade is worth carrying up', () => {
    installStorage({ [LOCAL_KEYS.records]: JSON.stringify([record('r1', 'TP')]) });
    expect(hasLocalDataWorthMigrating(readLocalProfile())).toBe(true);
  });

  test('a locked balance alone is worth carrying up', () => {
    installStorage({ [LOCAL_KEYS.isLocked]: 'true', [LOCAL_KEYS.equity]: '1000' });
    expect(hasLocalDataWorthMigrating(readLocalProfile())).toBe(true);
  });

  test('an untouched browser has nothing to transfer', () => {
    expect(hasLocalDataWorthMigrating(readLocalProfile())).toBe(false);
  });
});

describe('the transfer runs once per account', () => {
  test('an account is not marked until it has been migrated', () => {
    expect(alreadyMigrated('uid-1')).toBe(false);
    markMigrated('uid-1');
    expect(alreadyMigrated('uid-1')).toBe(true);
  });

  test('marking one account does not mark another', () => {
    markMigrated('uid-1');
    expect(alreadyMigrated('uid-2')).toBe(false);
  });
});

describe('the uploaded user document', () => {
  test('trade counts are derived from the records, not guessed', () => {
    installStorage({
      [LOCAL_KEYS.equity]: '6000',
      [LOCAL_KEYS.isLocked]: 'true',
      [LOCAL_KEYS.records]: JSON.stringify([
        record('a', 'TP'), record('b', 'TP'), record('c', 'SL'), record('d', 'MISSED'),
      ]),
    });
    const docData = buildUserDocument(readLocalProfile());
    expect(docData.totalTrades).toBe(4);
    expect(docData.winTrades).toBe(2);
    expect(docData.lossTrades).toBe(1);
    expect(docData.missedTrades).toBe(1);
    expect(docData.lockedEquity).toBe(6000);
  });

  test('absent fields are dropped, since Firestore rejects undefined', () => {
    const docData = buildUserDocument(readLocalProfile());
    expect('lockedEquity' in docData).toBe(false);
    expect('tradingStyle' in docData).toBe(false);
    expect(docData.totalTrades).toBe(0);
  });

  test('a missing starting balance falls back to the current one', () => {
    installStorage({ [LOCAL_KEYS.equity]: '2500', [LOCAL_KEYS.isLocked]: 'true' });
    expect(buildUserDocument(readLocalProfile()).initialEquity).toBe(2500);
  });
});

describe('an adopted backtest prior', () => {
  test('is read back and sanitised', () => {
    installStorage({
      [LOCAL_KEYS.backtestPrior]: JSON.stringify({
        orderBlockWeight: 4,
        fairValueGapWeight: 2,
        liquiditySweepWeight: 2,
        newsImpactWeight: 1,
        indicatorConfluenceWeight: 1,
        atrBufferFactor: 1.6,
        entryBufferPips: 25,
      }),
    });
    const profile = readLocalProfile();
    expect(profile.backtestPrior?.atrBufferFactor).toBe(1.6);
    // Stored as raw ratios, read back as a distribution.
    expect(profile.backtestPrior?.orderBlockWeight).toBeCloseTo(0.4, 3);
  });

  test('is null when nothing was adopted', () => {
    installStorage({});
    expect(readLocalProfile().backtestPrior).toBeNull();
  });

  test('corrupt storage does not break the profile read', () => {
    installStorage({ [LOCAL_KEYS.backtestPrior]: '{not json' });
    expect(readLocalProfile().backtestPrior).toBeNull();
  });
});

describe('the conviction floor', () => {
  test('is read back when set', () => {
    installStorage({ [LOCAL_KEYS.minConviction]: '55' });
    expect(readLocalProfile().minConviction).toBe(55);
  });

  test('zero is a real choice, not a missing one', () => {
    installStorage({ [LOCAL_KEYS.minConviction]: '0' });
    expect(readLocalProfile().minConviction).toBe(0);
  });

  test('a value outside the range is ignored rather than applied', () => {
    installStorage({ [LOCAL_KEYS.minConviction]: '500' });
    expect(readLocalProfile().minConviction).toBeNull();
    installStorage({ [LOCAL_KEYS.minConviction]: 'high' });
    expect(readLocalProfile().minConviction).toBeNull();
  });
});

describe('the break-even rule', () => {
  test('is read back when the user turned it on', () => {
    installStorage({ [LOCAL_KEYS.protectStopAtR]: '1' });
    expect(readLocalProfile().protectStopAtR).toBe(1);
  });

  test('nothing stored means the trade is held exactly as quoted', () => {
    installStorage({});
    expect(readLocalProfile().protectStopAtR).toBeNull();
  });

  test('a value outside what the rule means is ignored rather than applied', () => {
    installStorage({ [LOCAL_KEYS.protectStopAtR]: '0' });
    expect(readLocalProfile().protectStopAtR).toBeNull();
    installStorage({ [LOCAL_KEYS.protectStopAtR]: '40' });
    expect(readLocalProfile().protectStopAtR).toBeNull();
    installStorage({ [LOCAL_KEYS.protectStopAtR]: 'yes' });
    expect(readLocalProfile().protectStopAtR).toBeNull();
  });
});

describe('a refused conviction band', () => {
  test('is read back when set', () => {
    installStorage({ [LOCAL_KEYS.skipConvictionBand]: JSON.stringify({ min: 40, max: 55 }) });
    expect(readLocalProfile().skipConvictionBand).toEqual({ min: 40, max: 55 });
  });

  test('nothing stored means every band is taken', () => {
    installStorage({});
    expect(readLocalProfile().skipConvictionBand).toBeNull();
  });

  test('a corrupt or impossible band refuses nothing rather than everything', () => {
    installStorage({ [LOCAL_KEYS.skipConvictionBand]: '{"min":55,"max":40}' });
    expect(readLocalProfile().skipConvictionBand).toBeNull();
    installStorage({ [LOCAL_KEYS.skipConvictionBand]: 'not json' });
    expect(readLocalProfile().skipConvictionBand).toBeNull();
    installStorage({ [LOCAL_KEYS.skipConvictionBand]: '{"min":-5,"max":200}' });
    expect(readLocalProfile().skipConvictionBand).toBeNull();
  });
});

describe('a setting is written to the browser as well as the account', () => {
  test('every setting the app holds can be mirrored locally', () => {
    const map = installStorage();
    writeLocalSettings({
      equity: 9.01,
      initialEquity: 10,
      isEquityLocked: true,
      riskPercentage: 1,
      tradingStyle: 'Intraday',
      accountType: 'Cent',
      selectedBroker: 'EXNESS',
      minConviction: 55,
      protectStopAtR: 1,
      skipConvictionBand: { min: 40, max: 55 },
      backtestPrior: null,
      theme: 'light',
    });

    const back = readLocalProfile();
    expect(back.equity).toBe(9.01);
    expect(back.initialEquity).toBe(10);
    expect(back.isEquityLocked).toBe(true);
    expect(back.riskPercentage).toBe(1);
    expect(back.tradingStyle).toBe('Intraday');
    expect(back.accountType).toBe('Cent');
    expect(back.selectedBroker).toBe('EXNESS');
    expect(back.minConviction).toBe(55);
    expect(back.protectStopAtR).toBe(1);
    expect(back.skipConvictionBand).toEqual({ min: 40, max: 55 });
    expect(back.theme).toBe('light');
    expect(map.size).toBeGreaterThan(8);
  });

  test('a partial change touches only what it names', () => {
    installStorage({ [LOCAL_KEYS.equity]: '9.01', [LOCAL_KEYS.riskPct]: '1' });
    writeLocalSettings({ riskPercentage: 2 });
    expect(readLocalProfile().equity).toBe(9.01);
    expect(readLocalProfile().riskPercentage).toBe(2);
  });

  test('clearing a setting removes it rather than storing the word null', () => {
    installStorage({ [LOCAL_KEYS.protectStopAtR]: '1' });
    writeLocalSettings({ protectStopAtR: null });
    expect(readLocalProfile().protectStopAtR).toBeNull();
  });

  test('the cloud shape uses the field names the account already stores', () => {
    expect(toCloudPatch({ equity: 9.01, riskPercentage: 1 })).toEqual({
      lockedEquity: 9.01,
      riskPercentage: 1,
    });
    // An untouched setting is not written as undefined over a good value.
    expect(toCloudPatch({ equity: undefined, theme: 'dark' })).toEqual({ theme: 'dark' });
  });
});

describe('what signing in must not throw away', () => {
  test('a balance this browser holds and the account does not is carried up', () => {
    // The reported bug: a balance entered, then a login, then the balance back
    // at its starting value because the account had never been told.
    installStorage({
      [LOCAL_KEYS.equity]: '9.01',
      [LOCAL_KEYS.initialEquity]: '10',
      [LOCAL_KEYS.isLocked]: 'true',
      [LOCAL_KEYS.minConviction]: '55',
    });
    const gaps = settingsMissingFromCloud({ riskPercentage: 1 }, readLocalProfile());
    expect(gaps.equity).toBe(9.01);
    expect(gaps.initialEquity).toBe(10);
    expect(gaps.isEquityLocked).toBe(true);
    expect(gaps.minConviction).toBe(55);
    // Already in the account, so it is left alone.
    expect(gaps.riskPercentage).toBeUndefined();
  });

  test('the account always wins where it has an answer', () => {
    installStorage({ [LOCAL_KEYS.equity]: '5000' });
    const gaps = settingsMissingFromCloud({ lockedEquity: 9.01 }, readLocalProfile());
    expect(gaps.equity).toBeUndefined();
  });

  test('an account with everything needs nothing carried up', () => {
    installStorage({ [LOCAL_KEYS.equity]: '9.01' });
    const gaps = settingsMissingFromCloud(
      {
        lockedEquity: 9.01,
        initialEquity: 10,
        isEquityLocked: true,
        riskPercentage: 1,
        tradingStyle: 'Intraday',
        accountType: 'Cent',
        selectedBroker: 'EXNESS',
        minConviction: 0,
        protectStopAtR: 1,
        skipConvictionBand: { min: 40, max: 55 },
        backtestPrior: {},
        theme: 'dark',
      },
      readLocalProfile()
    );
    expect(Object.keys(gaps)).toHaveLength(0);
  });

  test('an empty browser has nothing to offer an empty account', () => {
    installStorage({});
    expect(Object.keys(settingsMissingFromCloud({}, readLocalProfile()))).toHaveLength(0);
  });
});

describe('whose settings these are', () => {
  test('an unowned mirror is guest work, and may be carried into any account', () => {
    installStorage({ [LOCAL_KEYS.equity]: '9.01' });
    expect(mirrorBelongsTo('uid-a')).toBe(true);
  });

  test('a mirror keeps belonging to the account that wrote it', () => {
    installStorage({ [LOCAL_KEYS.equity]: '9.01' });
    markMirrorOwner('uid-a');
    expect(mirrorBelongsTo('uid-a')).toBe(true);
  });

  test('another account on the same browser inherits nothing', () => {
    // A shared phone. Without this, the second person to sign in would be
    // handed the first one's balance.
    installStorage({ [LOCAL_KEYS.equity]: '9.01' });
    markMirrorOwner('uid-a');
    expect(mirrorBelongsTo('uid-b')).toBe(false);
  });
});

/**
 * Moves a guest's browser-stored work into their cloud account.
 *
 * Runs once, the first time someone signs in on an account that has no cloud
 * record yet. Writes are keyed by each record's own id, so running it twice
 * cannot duplicate a trade.
 */

import { doc, setDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebase';
import { LocalProfile } from './local-store';

/** Firestore rejects undefined, so absent fields are dropped rather than sent. */
function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** Builds the user document from a guest profile, without writing anything. */
export function buildUserDocument(profile: LocalProfile): Record<string, unknown> {
  const wins = profile.learningRecords.filter((r) => r.outcome === 'TP').length;
  const losses = profile.learningRecords.filter((r) => r.outcome === 'SL').length;
  const missed = profile.learningRecords.filter((r) => r.outcome === 'MISSED').length;

  return compact({
    lockedEquity: profile.equity,
    initialEquity: profile.initialEquity ?? profile.equity,
    isEquityLocked: profile.isEquityLocked,
    riskPercentage: profile.riskPercentage,
    tradingStyle: profile.tradingStyle,
    accountType: profile.accountType,
    selectedBroker: profile.selectedBroker,
    totalTrades: profile.learningRecords.length,
    winTrades: wins,
    lossTrades: losses,
    missedTrades: missed,
    migratedFromGuestAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Uploads the profile and every learning record. Returns false when the write
 * fails, so the caller can leave the browser copy untouched and try again.
 */
export async function migrateLocalProfileToCloud(uid: string, profile: LocalProfile): Promise<boolean> {
  try {
    await setDoc(doc(db, 'users', uid), buildUserDocument(profile), { merge: true });

    // Firestore caps a batch at 500 operations.
    const chunks: (typeof profile.learningRecords)[] = [];
    for (let i = 0; i < profile.learningRecords.length; i += 400) {
      chunks.push(profile.learningRecords.slice(i, i + 400));
    }

    for (const chunk of chunks) {
      const batch = writeBatch(db);
      for (const record of chunk) {
        batch.set(doc(db, 'users', uid, 'learning_records', record.id), record, { merge: true });
      }
      await batch.commit();
    }

    return true;
  } catch (err) {
    console.warn('Could not copy guest data to the cloud:', err);
    return false;
  }
}

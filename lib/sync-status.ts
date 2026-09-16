/**
 * Tracks whether the user's data actually reached the cloud.
 *
 * Every Firestore write in this app used to fail into console.warn, so a
 * rejected write left the screen looking completely normal while the balance
 * and trade history silently stopped being saved. For an app whose whole point
 * is keeping a trading record, that is the worst possible failure mode.
 */

export type SyncState = 'guest' | 'saving' | 'saved' | 'failed';

export interface SyncStatus {
  state: SyncState;
  /** ISO timestamp of the last confirmed write. */
  lastSavedAt: string | null;
  /** Short label for the indicator. */
  label: string;
  /** Longer explanation, present when something needs the user's attention. */
  detail?: string;
}

export const GUEST_STATUS: SyncStatus = {
  state: 'guest',
  lastSavedAt: null,
  label: 'Saved in this browser',
  detail: undefined,
};

/**
 * Turns a Firestore error into a sentence naming the actual cause. The codes
 * here are the ones that realistically occur during setup.
 */
export function describeSyncError(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';

  switch (code) {
    case 'permission-denied':
      return 'The database rejected the write. In the Firebase Console, open Firestore Database, then Rules, and confirm the rules from firestore.rules are published.';
    case 'unauthenticated':
      return 'Your sign-in expired. Sign out and back in to keep saving to the cloud.';
    case 'unavailable':
      return 'The database could not be reached. This is usually a network problem, and the app will retry on your next change.';
    case 'resource-exhausted':
      return 'The project has hit its Firestore quota for now. On the free Spark plan this resets daily.';
    case 'failed-precondition':
      return 'Firestore is not ready for this write. Confirm the database has been created in the Firebase Console.';
    case 'not-found':
      return 'The database was not found. Check that the project has a Firestore database and that no stale database id is configured.';
    default:
      return `The write failed${code ? ` (${code})` : ''}. Your data is still in this browser, and the app will retry on your next change.`;
  }
}

/** Status while a write is in flight. Keeps the previous success time. */
export function savingStatus(previous: SyncStatus): SyncStatus {
  return { state: 'saving', lastSavedAt: previous.lastSavedAt, label: 'Saving to cloud' };
}

/** Status after a confirmed write. */
export function savedStatus(at: Date = new Date()): SyncStatus {
  return { state: 'saved', lastSavedAt: at.toISOString(), label: 'Saved to cloud' };
}

/** Status after a rejected write, carrying the reason. */
export function failedStatus(previous: SyncStatus, error: unknown): SyncStatus {
  return {
    state: 'failed',
    lastSavedAt: previous.lastSavedAt,
    label: 'Not saved to cloud',
    detail: describeSyncError(error),
  };
}

/** Human readable age of the last confirmed write, for the indicator tooltip. */
export function formatLastSaved(status: SyncStatus, now: Date = new Date()): string | null {
  if (!status.lastSavedAt) return null;
  const then = new Date(status.lastSavedAt).getTime();
  if (Number.isNaN(then)) return null;

  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

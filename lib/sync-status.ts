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
  label: 'Tersimpan di browser ini',
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
      return 'Database menolak penyimpanan. Di Firebase Console, buka Firestore Database, lalu Rules, dan pastikan rules dari firestore.rules sudah dipublikasikan.';
    case 'unauthenticated':
      return 'Login kamu kedaluwarsa. Keluar lalu masuk lagi supaya tetap tersimpan ke cloud.';
    case 'unavailable':
      return 'Database tidak bisa dihubungi. Biasanya ini masalah jaringan, dan aplikasi akan mencoba lagi saat ada perubahan berikutnya.';
    case 'resource-exhausted':
      return 'Proyek sudah mencapai kuota Firestore untuk saat ini. Di paket gratis Spark, kuota di-reset setiap hari.';
    case 'failed-precondition':
      return 'Firestore belum siap untuk penyimpanan ini. Pastikan database sudah dibuat di Firebase Console.';
    case 'not-found':
      return 'Database tidak ditemukan. Pastikan proyek punya database Firestore dan tidak ada id database lama yang terpasang.';
    default:
      return `Penyimpanan gagal${code ? ` (${code})` : ''}. Datamu masih ada di browser ini, dan aplikasi akan mencoba lagi saat ada perubahan berikutnya.`;
  }
}

/** Status while a write is in flight. Keeps the previous success time. */
export function savingStatus(previous: SyncStatus): SyncStatus {
  return { state: 'saving', lastSavedAt: previous.lastSavedAt, label: 'Menyimpan ke cloud' };
}

/** Status after a confirmed write. */
export function savedStatus(at: Date = new Date()): SyncStatus {
  return { state: 'saved', lastSavedAt: at.toISOString(), label: 'Tersimpan ke cloud' };
}

/** Status after a rejected write, carrying the reason. */
export function failedStatus(previous: SyncStatus, error: unknown): SyncStatus {
  return {
    state: 'failed',
    lastSavedAt: previous.lastSavedAt,
    label: 'Belum tersimpan ke cloud',
    detail: describeSyncError(error),
  };
}

/** Human readable age of the last confirmed write, for the indicator tooltip. */
export function formatLastSaved(status: SyncStatus, now: Date = new Date()): string | null {
  if (!status.lastSavedAt) return null;
  const then = new Date(status.lastSavedAt).getTime();
  if (Number.isNaN(then)) return null;

  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 10) return 'baru saja';
  if (seconds < 60) return `${seconds} detik lalu`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

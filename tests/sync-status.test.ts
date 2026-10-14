import { describe, expect, test } from 'bun:test';
import {
  GUEST_STATUS,
  describeSyncError,
  failedStatus,
  formatLastSaved,
  savedStatus,
  savingStatus,
} from '../lib/sync-status';

describe('explaining a rejected write', () => {
  test('a rules rejection points at the exact console screen to check', () => {
    const msg = describeSyncError({ code: 'permission-denied' });
    expect(msg).toContain('Rules');
    expect(msg).toContain('firestore.rules');
  });

  test('an expired session tells the user to sign in again', () => {
    expect(describeSyncError({ code: 'unauthenticated' })).toContain('Keluar lalu masuk lagi');
  });

  test('a missing database is distinguished from a rules problem', () => {
    const msg = describeSyncError({ code: 'not-found' });
    expect(msg).toContain('database');
    expect(msg).not.toContain('Rules');
  });

  test('a quota stop says it resets', () => {
    expect(describeSyncError({ code: 'resource-exhausted' })).toContain('di-reset setiap hari');
  });

  test('an unknown failure still reassures that the browser copy survives', () => {
    const msg = describeSyncError({ code: 'weird-thing' });
    expect(msg).toContain('weird-thing');
    expect(msg).toContain('masih ada di browser ini');
  });

  test('a non Firestore error does not crash the formatter', () => {
    expect(describeSyncError(new Error('boom'))).toContain('gagal');
    expect(describeSyncError(null)).toContain('gagal');
  });
});

describe('status transitions', () => {
  test('a guest is described as browser-only, with no false claim of cloud saving', () => {
    expect(GUEST_STATUS.state).toBe('guest');
    expect(GUEST_STATUS.label).toContain('browser');
    expect(GUEST_STATUS.lastSavedAt).toBeNull();
  });

  test('a confirmed write records when it happened', () => {
    const at = new Date('2026-09-16T10:00:00Z');
    const s = savedStatus(at);
    expect(s.state).toBe('saved');
    expect(s.lastSavedAt).toBe(at.toISOString());
  });

  test('saving keeps the previous success time rather than clearing it', () => {
    const saved = savedStatus(new Date('2026-09-16T10:00:00Z'));
    expect(savingStatus(saved).lastSavedAt).toBe(saved.lastSavedAt);
  });

  test('a failure keeps the previous success time and carries the reason', () => {
    const saved = savedStatus(new Date('2026-09-16T10:00:00Z'));
    const failed = failedStatus(saved, { code: 'permission-denied' });
    expect(failed.state).toBe('failed');
    expect(failed.lastSavedAt).toBe(saved.lastSavedAt);
    expect(failed.detail).toContain('Rules');
  });

  test('a failure never claims the data is saved', () => {
    const failed = failedStatus(GUEST_STATUS, { code: 'unavailable' });
    expect(failed.label).toContain('Belum tersimpan');
  });
});

describe('describing when the last save happened', () => {
  const base = new Date('2026-09-16T10:00:00Z');

  test('a fresh save reads as just now', () => {
    expect(formatLastSaved(savedStatus(base), new Date('2026-09-16T10:00:05Z'))).toBe('baru saja');
  });

  test('seconds, minutes and hours are each phrased naturally', () => {
    expect(formatLastSaved(savedStatus(base), new Date('2026-09-16T10:00:30Z'))).toBe('30 detik lalu');
    expect(formatLastSaved(savedStatus(base), new Date('2026-09-16T10:01:00Z'))).toBe('1 minute ago');
    expect(formatLastSaved(savedStatus(base), new Date('2026-09-16T10:05:00Z'))).toBe('5 minutes ago');
    expect(formatLastSaved(savedStatus(base), new Date('2026-09-16T12:00:00Z'))).toBe('2 hours ago');
  });

  test('a guest has no save time to report', () => {
    expect(formatLastSaved(GUEST_STATUS)).toBeNull();
  });

  test('a corrupt timestamp is reported as unknown, not as NaN', () => {
    expect(formatLastSaved({ ...GUEST_STATUS, lastSavedAt: 'not-a-date' })).toBeNull();
  });

  test('a clock that jumped backwards does not produce a negative age', () => {
    expect(formatLastSaved(savedStatus(base), new Date('2026-09-16T09:00:00Z'))).toBe('baru saja');
  });
});

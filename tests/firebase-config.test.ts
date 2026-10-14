import { describe, expect, test } from 'bun:test';
import { describeAuthError } from '../lib/firebase';

describe('sign-in error messages', () => {
  test('an unauthorised domain explains both ways out', () => {
    const msg = describeAuthError({ code: 'auth/unauthorized-domain' })!;
    expect(msg).toContain('Authorized domains');
    expect(msg).toContain('NEXT_PUBLIC_FIREBASE');
    // The app still works without signing in, and the message must say so.
    expect(msg).toContain('tanpa login');
  });

  test('closing the popup is not an error worth showing', () => {
    expect(describeAuthError({ code: 'auth/popup-closed-by-user' })).toBeNull();
    expect(describeAuthError({ code: 'auth/cancelled-popup-request' })).toBeNull();
  });

  test('a blocked popup tells the user what to change', () => {
    expect(describeAuthError({ code: 'auth/popup-blocked' })!).toContain('Izinkan popup');
  });

  test('a disabled provider names the setting to turn on', () => {
    expect(describeAuthError({ code: 'auth/operation-not-allowed' })!).toContain('Sign-in method');
  });

  test('an unknown failure still reassures that the app keeps working', () => {
    const msg = describeAuthError({ code: 'auth/something-new' })!;
    expect(msg).toContain('auth/something-new');
    expect(msg).toContain('tanpa login');
  });

  test('a non Firebase error does not crash the formatter', () => {
    expect(describeAuthError(new Error('boom'))).toContain('Login gagal');
    expect(describeAuthError(null)).toContain('Login gagal');
  });
});

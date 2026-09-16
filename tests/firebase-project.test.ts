import { describe, expect, test } from 'bun:test';
import bundled from '../firebase-applet-config.json';
import { findConfigProblems } from '../scripts/check-firebase';

describe('the bundled Firebase project', () => {
  test('carries every field Firebase needs to start', () => {
    for (const field of ['apiKey', 'authDomain', 'projectId', 'appId'] as const) {
      expect(typeof bundled[field]).toBe('string');
      expect(bundled[field].length).toBeGreaterThan(0);
    }
  });

  test('is internally consistent', () => {
    expect(findConfigProblems(bundled)).toEqual([]);
  });

  test('no longer points at the AI Studio project the owner cannot administer', () => {
    expect(bundled.projectId).not.toBe('industrious-healer-qxjsq');
  });

  test('uses the default Firestore database, not a named AI Studio one', () => {
    // A named database id from another project would send every read and write
    // to a database this project does not have.
    expect(bundled.firestoreDatabaseId ?? '').not.toContain('ai-studio');
  });
});

describe('detecting a mis-copied configuration', () => {
  const good = {
    apiKey: 'AIzaSyBVZlF7NmCDACRqsKfHa-AY12269b7KWTY',
    authDomain: 'xauasistenengine.firebaseapp.com',
    projectId: 'xauasistenengine',
    appId: '1:667004577676:web:ba1ef6060e55c5a7a9d8a9',
    messagingSenderId: '667004577676',
  };

  test('a clean config reports nothing', () => {
    expect(findConfigProblems(good)).toEqual([]);
  });

  test('values taken from two different projects are caught', () => {
    const problems = findConfigProblems({ ...good, authDomain: 'some-other-project.firebaseapp.com' });
    expect(problems.join(' ')).toContain('does not mention project');
  });

  test('a sender id that disagrees with the app id is caught', () => {
    const problems = findConfigProblems({ ...good, messagingSenderId: '999999999' });
    expect(problems.join(' ')).toContain('does not match');
  });

  test('a truncated app id is caught', () => {
    expect(findConfigProblems({ ...good, appId: '667004577676' }).join(' ')).toContain('app id');
  });

  test('something that is not a Google API key is caught', () => {
    expect(findConfigProblems({ ...good, apiKey: 'sk-not-a-google-key' }).join(' ')).toContain('AIza');
  });

  test('an empty config reports nothing, since absence is handled elsewhere', () => {
    expect(findConfigProblems({})).toEqual([]);
  });
});

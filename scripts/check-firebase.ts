/**
 * Reports which Firebase project the app will actually use, and whether its
 * values are complete and self consistent.
 *
 *   bun run check:firebase
 *
 * It does not contact Google. It catches the mistakes that happen while copying
 * values between the console and the app.
 */

import bundled from '../firebase-applet-config.json';

const ENV_FIELDS = {
  apiKey: 'NEXT_PUBLIC_FIREBASE_API_KEY',
  authDomain: 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  projectId: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  appId: 'NEXT_PUBLIC_FIREBASE_APP_ID',
  storageBucket: 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
} as const;

/** The four fields Firebase cannot start without. */
const REQUIRED = ['apiKey', 'authDomain', 'projectId', 'appId'] as const;

type Config = Partial<Record<keyof typeof ENV_FIELDS, string>>;

function envValue(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** Checks a config for internal contradictions and returns readable problems. */
export function findConfigProblems(config: Config): string[] {
  const problems: string[] = [];
  const { apiKey = '', authDomain = '', projectId = '', appId = '', messagingSenderId = '' } = config;

  // The auth domain is normally "<projectId>.firebaseapp.com". A mismatch means
  // values were copied from two different projects, and sign-in will open
  // against the wrong one.
  if (projectId && authDomain && !authDomain.includes(projectId)) {
    problems.push(
      `Auth domain "${authDomain}" does not mention project "${projectId}". Check both came from the same project.`
    );
  }
  // A Firebase app id looks like "1:667004577676:web:abc123".
  if (appId && !/^\d+:\d+:[a-z]+:[a-z0-9]+$/i.test(appId)) {
    problems.push(`App id "${appId}" is not shaped like a Firebase app id.`);
  }
  // The sender id is embedded in the app id, so the two must agree.
  const senderInAppId = appId.split(':')[1] ?? '';
  if (messagingSenderId && senderInAppId && messagingSenderId !== senderInAppId) {
    problems.push(
      `Messaging sender id "${messagingSenderId}" does not match the "${senderInAppId}" inside the app id.`
    );
  }
  if (apiKey && !apiKey.startsWith('AIza')) {
    problems.push(`API key "${apiKey.slice(0, 8)}..." does not look like a Google API key, which starts with AIza.`);
  }
  return problems;
}

function main() {
  console.log('\nChecking the Firebase configuration...\n');

  const fromEnv: Config = {};
  for (const [field, envName] of Object.entries(ENV_FIELDS)) {
    const v = envValue(envName);
    if (v) fromEnv[field as keyof Config] = v;
  }

  const envHasAll = REQUIRED.every((f) => fromEnv[f]);
  const envHasSome = REQUIRED.some((f) => fromEnv[f]);

  if (envHasSome && !envHasAll) {
    const missing = REQUIRED.filter((f) => !fromEnv[f]).map((f) => ENV_FIELDS[f]);
    console.log('  INCOMPLETE OVERRIDE. These are still empty:\n');
    for (const name of missing) console.log(`    ${name}`);
    console.log('\n  A partial set is ignored, so the app would silently fall back to the');
    console.log('  bundled project. Fill all four, or clear them all.\n');
    process.exit(1);
  }

  const active: Config = envHasAll ? fromEnv : (bundled as Config);
  const origin = envHasAll ? 'environment variables' : 'firebase-applet-config.json in the repository';

  console.log(`  Source       ${origin}`);
  console.log(`  Project      ${active.projectId ?? 'missing'}`);
  console.log(`  Auth domain  ${active.authDomain ?? 'missing'}`);
  console.log(`  App id       ${active.appId ?? 'missing'}`);

  const missingRequired = REQUIRED.filter((f) => !active[f]);
  if (missingRequired.length > 0) {
    console.log('\n  MISSING REQUIRED VALUES:\n');
    for (const f of missingRequired) console.log(`    ${f}`);
    console.log('');
    process.exit(1);
  }

  const problems = findConfigProblems(active);
  if (problems.length > 0) {
    console.log('\n  PROBLEMS FOUND:\n');
    for (const p of problems) console.log(`    - ${p}`);
    console.log('');
    process.exit(1);
  }

  console.log(`\n  RESULT: configuration is consistent for project "${active.projectId}".\n`);
  console.log('  This check cannot see inside the Firebase Console, so confirm there:');
  console.log('    1. Authentication, Sign-in method: Google is enabled.');
  console.log('    2. Firestore Database exists.');
  console.log('    3. Firestore Rules match firestore.rules in this repository.');
  console.log('    4. Authentication, Settings, Authorized domains includes your site.\n');
}

if (import.meta.main) main();

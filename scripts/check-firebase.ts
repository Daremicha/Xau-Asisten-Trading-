/**
 * Checks that the Firebase configuration is complete and self consistent.
 *
 *   bun run check:firebase
 *
 * It does not contact Google. It tells you which values are missing or
 * mismatched, which is where setup usually goes wrong.
 */

const REQUIRED = [
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
] as const;

const OPTIONAL = [
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_DATABASE_ID',
] as const;

function value(name: string): string {
  return (process.env[name] ?? '').trim();
}

console.log('\nChecking the Firebase configuration...\n');

const missing = REQUIRED.filter((name) => value(name).length === 0);

if (missing.length === REQUIRED.length) {
  console.log('  No Firebase variables are set.');
  console.log('  The app will use the project bundled with the repository.');
  console.log('  Google sign-in works only if you own that project and have');
  console.log('  authorised this site’s domain in it.\n');
  console.log('  Signing in is optional. Without it your data is saved in the browser.\n');
  process.exit(0);
}

if (missing.length > 0) {
  console.log('  INCOMPLETE. These are still empty:\n');
  for (const name of missing) console.log(`    ${name}`);
  console.log('\n  A partial set is ignored, so the app falls back to the bundled');
  console.log('  project. Fill all four, or clear them all.\n');
  process.exit(1);
}

for (const name of REQUIRED) console.log(`  ${name.padEnd(42)} set`);
for (const name of OPTIONAL) {
  console.log(`  ${name.padEnd(42)} ${value(name) ? 'set' : 'not set (fine)'}`);
}

const projectId = value('NEXT_PUBLIC_FIREBASE_PROJECT_ID');
const authDomain = value('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN');
const appId = value('NEXT_PUBLIC_FIREBASE_APP_ID');
const problems: string[] = [];

// The auth domain is normally "<projectId>.firebaseapp.com". A mismatch here is
// the usual cause of a sign-in popup that opens against the wrong project.
if (!authDomain.startsWith(`${projectId}.`) && !authDomain.includes(projectId)) {
  problems.push(
    `The auth domain "${authDomain}" does not mention project "${projectId}". Check you copied both from the same project.`
  );
}
if (!/^\d+:/.test(appId)) {
  problems.push(`The app id "${appId}" does not look like a Firebase app id, which starts with digits and a colon.`);
}

console.log('');
if (problems.length > 0) {
  console.log('  PROBLEMS FOUND:\n');
  for (const p of problems) console.log(`    - ${p}`);
  console.log('');
  process.exit(1);
}

console.log(`  RESULT: configuration looks consistent for project "${projectId}".\n`);
console.log('  Still to do in the Firebase Console:');
console.log('    1. Authentication, Sign-in method: enable Google.');
console.log('    2. Firestore Database: create the database.');
console.log('    3. Firestore Rules: paste the contents of firestore.rules.');
console.log('    4. Authentication, Settings, Authorized domains: add your site.\n');

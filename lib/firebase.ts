import { initializeApp, getApps, getApp, FirebaseOptions } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import bundledConfig from '../firebase-applet-config.json';

/**
 * Firebase configuration.
 *
 * The bundled JSON points at the project this app was generated in. If you do
 * not own that project you cannot authorise your own deployment domain, and
 * Google sign-in will refuse to open. Setting the NEXT_PUBLIC_FIREBASE_*
 * variables points the app at a project you control, without editing any file
 * in the repository.
 *
 * These values are public by design. A Firebase web config is visible in every
 * browser that loads the app; Firestore rules, not secrecy, are what protect
 * the data.
 */
function resolveConfig(): FirebaseOptions & { firestoreDatabaseId?: string } {
  const fromEnv = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    firestoreDatabaseId: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_ID,
  };

  // An override is only honoured when the fields Firebase actually needs are
  // present, so a half filled set of variables cannot break a working app.
  if (fromEnv.apiKey && fromEnv.projectId && fromEnv.appId && fromEnv.authDomain) {
    return fromEnv as FirebaseOptions & { firestoreDatabaseId?: string };
  }
  return bundledConfig;
}

const firebaseConfig = resolveConfig();

/** True when the app is pointed at a project supplied through the environment. */
export const usingCustomFirebaseProject = firebaseConfig !== bundledConfig;

export const firebaseProjectId = firebaseConfig.projectId;

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId || '(default)');

/**
 * Turns a Firebase auth error into something a person can act on.
 * Returns null when the user simply closed the popup.
 */
export function describeAuthError(error: unknown): string | null {
  const code = (error as { code?: string })?.code ?? '';

  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return null;
    case 'auth/unauthorized-domain':
      return `This site's address is not on the authorised list of Firebase project "${firebaseProjectId}". If you own that project, add this domain under Authentication, Settings, Authorized domains. If you do not own it, point the app at your own project with the NEXT_PUBLIC_FIREBASE_* variables. You can keep using the app without signing in; your data is saved in this browser.`;
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in popup. Allow popups for this site and try again.';
    case 'auth/operation-not-allowed':
      return `Google sign-in is switched off for Firebase project "${firebaseProjectId}". Enable the Google provider under Authentication, Sign-in method.`;
    case 'auth/network-request-failed':
      return 'The network request failed. Check your connection and try again.';
    default:
      return `Sign-in failed${code ? ` (${code})` : ''}. You can keep using the app without signing in; your data is saved in this browser.`;
  }
}

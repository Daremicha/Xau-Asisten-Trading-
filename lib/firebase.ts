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
      return `Alamat situs ini tidak ada di daftar yang diizinkan proyek Firebase "${firebaseProjectId}". Kalau kamu pemilik proyek itu, tambahkan domain ini di Authentication, Settings, Authorized domains. Kalau bukan, arahkan aplikasi ke proyekmu sendiri lewat variabel NEXT_PUBLIC_FIREBASE_*. Kamu tetap bisa memakai aplikasi tanpa login; datamu tersimpan di browser ini.`;
    case 'auth/popup-blocked':
      return 'Browser memblokir popup login. Izinkan popup untuk situs ini lalu coba lagi.';
    case 'auth/operation-not-allowed':
      return `Login Google dimatikan untuk proyek Firebase "${firebaseProjectId}". Aktifkan provider Google di Authentication, Sign-in method.`;
    case 'auth/network-request-failed':
      return 'Permintaan jaringan gagal. Cek koneksimu lalu coba lagi.';
    default:
      return `Login gagal${code ? ` (${code})` : ''}. Kamu tetap bisa memakai aplikasi tanpa login; datamu tersimpan di browser ini.`;
  }
}

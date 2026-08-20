import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';

import { firebaseConfig } from './config';

export {
  FirebaseProvider,
} from './provider';
export {
  useFirebase,
  useFirebaseApp,
  useFirestore,
} from './provider';

type FirebaseInstances = {
  app: FirebaseApp;
  firestore: Firestore;
};

export function initializeFirebase(): FirebaseInstances {
  const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
  const firestore = getFirestore(app);

  return { app, firestore };
}

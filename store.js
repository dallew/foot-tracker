// Data layer. Two interchangeable back ends with the same interface:
//  - "firebase": Firebase Auth + Cloud Firestore with an on-device cache, so every
//    write lands on the phone instantly and syncs to the cloud when online.
//  - "demo" (?demo in the URL): browser storage only, for trying the app out.
// Events live at users/{uid}/events/{id}; settings at users/{uid}.
import { firebaseConfig } from './config.js';

const DEMO = new URLSearchParams(location.search).has('demo');

export async function createStore() {
  if (DEMO) return demoStore();
  if (!firebaseConfig) return { mode: 'setup' };
  return firebaseStore();
}

// ---------------------------------------------------------------- Firebase
async function firebaseStore() {
  const fb = await import('./firebase.js');
  const app = fb.initializeApp(firebaseConfig);
  const auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence] });
  const db = fb.initializeFirestore(app, {
    localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }),
  });

  let uid = null;
  let unsubEvents = null, unsubSettings = null;
  const writeErr = e => { console.error('[FUF] write failed', e); store.onError?.(e); };
  const evRef = id => fb.doc(db, 'users', uid, 'events', id);

  const store = {
    mode: 'firebase',
    onError: null,
    onAuth(cb) {
      fb.onAuthStateChanged(auth, user => { uid = user?.uid ?? null; cb(user ? { uid: user.uid, email: user.email } : null); });
    },
    signIn: (email, pw) => fb.signInWithEmailAndPassword(auth, email, pw),
    signOut: () => { stop(); return fb.signOut(auth); },
    resetPassword: email => fb.sendPasswordResetEmail(auth, email),

    /** cb(events[], status) on every local or remote change, including while offline. */
    subscribe(cb) {
      stop();
      const q = fb.query(fb.collection(db, 'users', uid, 'events'), fb.orderBy('ts'));
      unsubEvents = fb.onSnapshot(q, { includeMetadataChanges: true }, snap => {
        const events = snap.docs.map(d => {
          const x = d.data();
          return { id: d.id, timestamp: x.ts.toDate(), type: x.type, painScore: x.painScore ?? null,
            remedy: x.remedy ?? null, note: x.note ?? null };
        });
        cb(events, { pending: snap.metadata.hasPendingWrites, fromCache: snap.metadata.fromCache });
      }, e => { console.error('[FUF] listen failed', e); store.onError?.(e); });
    },
    subscribeSettings(cb) {
      unsubSettings = fb.onSnapshot(fb.doc(db, 'users', uid), s => cb(s.exists() ? s.data() : {}), () => {});
    },
    saveSettings(patch) {
      fb.setDoc(fb.doc(db, 'users', uid), patch, { merge: true }).catch(writeErr);
    },

    // Writes are not awaited: offline, the promise only settles once the server
    // confirms, but the change is already in the local cache and on screen.
    add(ev) {
      fb.setDoc(evRef(ev.id), toDoc(ev, fb)).catch(writeErr);
    },
    update(id, patch) {
      const d = { updatedAt: fb.serverTimestamp() };
      if ('timestamp' in patch) d.ts = fb.Timestamp.fromDate(patch.timestamp);
      for (const k of ['type', 'painScore', 'remedy', 'note']) if (k in patch) d[k] = patch[k] ?? null;
      fb.updateDoc(evRef(id), d).catch(writeErr);
    },
    /** Adds many events in batches of up to 450 writes (Firestore allows 500 per batch). */
    addMany(evs) {
      for (let i = 0; i < evs.length; i += 450) {
        const b = fb.writeBatch(db);
        evs.slice(i, i + 450).forEach(ev => b.set(evRef(ev.id), toDoc(ev, fb)));
        b.commit().catch(writeErr);
      }
    },
    remove(id) { fb.deleteDoc(evRef(id)).catch(writeErr); },
    removeMany(ids) {
      const b = fb.writeBatch(db);
      ids.forEach(id => b.delete(evRef(id)));
      b.commit().catch(writeErr);
    },
  };
  function stop() { unsubEvents?.(); unsubSettings?.(); unsubEvents = unsubSettings = null; }
  return store;
}

function toDoc(ev, fb) {
  return { ts: fb.Timestamp.fromDate(ev.timestamp), type: ev.type, painScore: ev.painScore ?? null,
    remedy: ev.remedy ?? null, note: ev.note ?? null, updatedAt: fb.serverTimestamp() };
}

// ---------------------------------------------------------------- Demo
function demoStore() {
  const KEY = 'fuf-demo-events', SKEY = 'fuf-demo-settings';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  let rows = read();
  let listener = null, settingsListener = null;
  const emit = () => {
    try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch {}
    rows.sort((a, b) => a.t - b.t);
    listener?.(rows.map(r => ({ ...r, timestamp: new Date(r.t) })), { demo: true });
  };
  return {
    mode: 'demo', onError: null,
    onAuth(cb) { cb({ uid: 'demo', email: 'Demo mode' }); },
    signIn: async () => {}, signOut: async () => { location.search = ''; }, resetPassword: async () => {},
    subscribe(cb) { listener = cb; emit(); },
    subscribeSettings(cb) {
      settingsListener = cb;
      try { cb(JSON.parse(localStorage.getItem(SKEY) || '{}')); } catch { cb({}); }
    },
    saveSettings(patch) {
      let s = {}; try { s = JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch {}
      Object.assign(s, patch);
      try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch {}
      settingsListener?.(s);
    },
    add(ev) { rows.push({ id: ev.id, t: ev.timestamp.getTime(), type: ev.type, painScore: ev.painScore ?? null, remedy: ev.remedy ?? null, note: ev.note ?? null }); emit(); },
    update(id, patch) {
      const r = rows.find(x => x.id === id); if (!r) return;
      if ('timestamp' in patch) r.t = patch.timestamp.getTime();
      for (const k of ['type', 'painScore', 'remedy', 'note']) if (k in patch) r[k] = patch[k] ?? null;
      emit();
    },
    addMany(evs) {
      for (const ev of evs) rows.push({ id: ev.id, t: ev.timestamp.getTime(), type: ev.type, painScore: ev.painScore ?? null, remedy: ev.remedy ?? null, note: ev.note ?? null });
      emit();
    },
    remove(id) { rows = rows.filter(r => r.id !== id); emit(); },
    removeMany(ids) { const s = new Set(ids); rows = rows.filter(r => !s.has(r.id)); emit(); },
  };
}

// Shared ticks and notes. Local-first: every change is saved on the phone straight away and
// synced through Firebase Firestore whenever there is a connection.
import {
  initializeApp, getAuth, signInAnonymously, onAuthStateChanged,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot,
} from '../vendor/libs.js';

const FIREBASE = {
  apiKey: 'AIzaSyC2vXlxxueCeIoNbmHhSGBHPArx2wGkC2s',
  authDomain: 'sib-nyc-trip.firebaseapp.com',
  projectId: 'sib-nyc-trip',
  storageBucket: 'sib-nyc-trip.firebasestorage.app',
  messagingSenderId: '487931396673',
  appId: '1:487931396673:web:1893784fe4ab4c521cbcc0',
};

const LS_STATE = 'sib.shared.v1';
const LS_QUEUE = 'sib.queue.v1';

const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

export function createSync(tripId, onChange) {
  const saved = ls.get(LS_STATE, { status: {}, notes: {} });
  const state = { status: saved.status || {}, notes: saved.notes || {} };
  let queue = ls.get(LS_QUEUE, []);
  let db = null;
  let ready = false;
  let serverPending = false;
  let lastServerSync = 0;
  let error = null;

  const persist = () => ls.set(LS_STATE, state);
  const emit = () => onChange(api.snapshot());

  // Apply a change locally (optimistic), then send it if we can.
  function apply(op) {
    if (op.kind === 'status') {
      if (op.data.s) state.status[op.id] = op.data; else delete state.status[op.id];
    } else if (op.kind === 'note') {
      state.notes[op.id] = op.data;
    } else if (op.kind === 'note-del') {
      delete state.notes[op.id];
    }
    persist();
  }

  async function send(op) {
    const base = ['trips', tripId];
    if (op.kind === 'status') await setDoc(doc(db, ...base, 'status', op.id), op.data);
    else if (op.kind === 'note') await setDoc(doc(db, ...base, 'notes', op.id), op.data);
    else if (op.kind === 'note-del') await deleteDoc(doc(db, ...base, 'notes', op.id));
  }

  function flush() {
    if (!ready || !queue.length) return;
    const ops = queue; queue = []; ls.set(LS_QUEUE, queue);
    // Firestore keeps its own offline write queue, so once handed over the op is safe.
    for (const op of ops) send(op).catch((e) => { error = e; emit(); });
    emit();
  }

  function enqueue(op) {
    apply(op);
    queue.push(op); ls.set(LS_QUEUE, queue);
    flush();
    emit();
  }

  function listen() {
    const opts = { includeMetadataChanges: true };
    onSnapshot(collection(db, 'trips', tripId, 'status'), opts, (snap) => {
      const next = {};
      snap.forEach((d) => { const v = d.data(); if (v && v.s) next[d.id] = v; });
      for (const op of queue) if (op.kind === 'status') { if (op.data.s) next[op.id] = op.data; else delete next[op.id]; }
      state.status = next;
      serverPending = snap.metadata.hasPendingWrites;
      if (!snap.metadata.fromCache) lastServerSync = Date.now();
      persist(); emit();
    }, (e) => { error = e; emit(); });
    onSnapshot(collection(db, 'trips', tripId, 'notes'), opts, (snap) => {
      const next = {};
      snap.forEach((d) => { next[d.id] = d.data(); });
      for (const op of queue) {
        if (op.kind === 'note') next[op.id] = op.data;
        if (op.kind === 'note-del') delete next[op.id];
      }
      state.notes = next;
      serverPending = serverPending || snap.metadata.hasPendingWrites;
      if (!snap.metadata.fromCache) lastServerSync = Date.now();
      persist(); emit();
    }, (e) => { error = e; emit(); });
  }

  function start() {
    try {
      const app = initializeApp(FIREBASE);
      let localCache;
      try { localCache = persistentLocalCache({ tabManager: persistentMultipleTabManager() }); } catch { localCache = undefined; }
      db = initializeFirestore(app, localCache ? { localCache } : {});
      const auth = getAuth(app);
      onAuthStateChanged(auth, (user) => {
        if (user && !ready) { ready = true; error = null; listen(); flush(); emit(); }
      });
      const tryLogin = () => { if (!auth.currentUser) signInAnonymously(auth).catch((e) => { error = e; emit(); }); };
      tryLogin();
      window.addEventListener('online', () => { tryLogin(); emit(); });
      window.addEventListener('offline', emit);
    } catch (e) {
      error = e; emit();
    }
  }

  const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const api = {
    start,
    snapshot() {
      return {
        status: state.status,
        notes: state.notes,
        online: navigator.onLine,
        ready,
        pending: queue.length > 0 || serverPending,
        lastServerSync,
        error,
      };
    },
    setStatus(stopId, s, by) {
      enqueue({ kind: 'status', id: stopId, data: s ? { s, by, at: Date.now() } : { s: '', by, at: Date.now() } });
    },
    addNote(stopId, text, by) {
      enqueue({ kind: 'note', id: id(), data: { stop: stopId, text, by, at: Date.now() } });
    },
    deleteNote(noteId) {
      enqueue({ kind: 'note-del', id: noteId });
    },
  };
  return api;
}

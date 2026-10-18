// Shared state: ticks/skips (status), notes, added stops and live-computed routes.
// Local-first: every change is saved on the phone straight away and synced through Firebase Firestore
// whenever there is a connection.
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

const COLS = ['status', 'notes', 'added', 'routes'];
const LS_STATE = 'sib.shared.v1';
const LS_QUEUE = 'sib.queue.v1';

const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

// Firestore can't store nested arrays, so route paths are stored flat.
const flatten = (path) => path.flat();
const unflatten = (flat) => { const out = []; for (let i = 0; i + 1 < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };

function migrateOp(op) { // queue entries from the first version of the app
  if (op.col) return op;
  if (op.kind === 'status') return { col: 'status', id: op.id, data: op.data };
  if (op.kind === 'note') return { col: 'notes', id: op.id, data: op.data };
  if (op.kind === 'note-del') return { col: 'notes', id: op.id, del: true };
  return null;
}

export function createSync(tripId, onChange) {
  const saved = ls.get(LS_STATE, {});
  const state = Object.fromEntries(COLS.map((c) => [c, saved[c] || {}]));
  let queue = ls.get(LS_QUEUE, []).map(migrateOp).filter(Boolean);
  let db = null;
  let ready = false;
  const pendingByCol = {};
  let lastServerSync = 0;
  let error = null;

  const persist = () => ls.set(LS_STATE, state);
  const emit = () => onChange(api.snapshot());

  const keep = (col, data) => !(col === 'status' && !data.s);
  function applyTo(map, op) {
    if (op.del || !keep(op.col, op.data)) delete map[op.id];
    else map[op.id] = op.col === 'routes' ? { ...op.data, path: unflatten(op.data.flat) } : op.data;
  }

  async function send(op) {
    const ref = doc(db, 'trips', tripId, op.col, op.id);
    if (op.del) await deleteDoc(ref); else await setDoc(ref, op.data);
  }

  function flush() {
    if (!ready || !queue.length) return;
    const ops = queue; queue = []; ls.set(LS_QUEUE, queue);
    // Firestore keeps its own offline write queue, so once handed over the op is safe.
    for (const op of ops) send(op).catch((e) => { error = e; emit(); });
    emit();
  }

  function enqueue(op) {
    applyTo(state[op.col], op);
    persist();
    queue.push(op); ls.set(LS_QUEUE, queue);
    flush();
    emit();
  }

  function listen() {
    const opts = { includeMetadataChanges: true };
    for (const col of COLS) {
      onSnapshot(collection(db, 'trips', tripId, col), opts, (snap) => {
        const next = {};
        snap.forEach((d) => {
          const v = d.data();
          if (!v || !keep(col, v)) return;
          next[d.id] = col === 'routes' ? { ...v, path: unflatten(v.flat) } : v;
        });
        for (const op of queue) if (op.col === col) applyTo(next, op);
        state[col] = next;
        pendingByCol[col] = snap.metadata.hasPendingWrites;
        if (!snap.metadata.fromCache) lastServerSync = Date.now();
        persist(); emit();
      }, (e) => { error = e; emit(); });
    }
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

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const api = {
    start,
    snapshot() {
      return {
        status: state.status,
        notes: state.notes,
        added: state.added,
        routes: state.routes,
        online: navigator.onLine,
        ready,
        pending: queue.length > 0 || Object.values(pendingByCol).some(Boolean),
        lastServerSync,
        error,
      };
    },
    setStatus(stopId, s, by) { enqueue({ col: 'status', id: stopId, data: { s: s || '', by, at: Date.now() } }); },
    addNote(stopId, text, by) { enqueue({ col: 'notes', id: newId(), data: { stop: stopId, text, by, at: Date.now() } }); },
    deleteNote(noteId) { enqueue({ col: 'notes', id: noteId, del: true }); },
    addStop(data, by) { const id = 'x' + newId(); enqueue({ col: 'added', id, data: { ...data, by, created: Date.now() } }); return id; },
    deleteStop(id) { enqueue({ col: 'added', id, del: true }); },
    saveRoute(key, mode, path) { enqueue({ col: 'routes', id: key, data: { mode, flat: flatten(path), at: Date.now() } }); },
  };
  return api;
}

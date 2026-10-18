// Bundled at build time (GitHub Actions) into site/vendor/libs.js so the app needs no CDN and works offline.
export { default as maplibregl } from 'maplibre-gl';
export { PMTiles, Protocol, FileSource } from 'pmtiles';
export * as basemaps from '@protomaps/basemaps';
export { initializeApp } from 'firebase/app';
export { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
export {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
} from 'firebase/firestore';

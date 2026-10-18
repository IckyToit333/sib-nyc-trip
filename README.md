# Sib NYC Trip · Dec 2026

A phone-first trip map for 23 Dec 2026 – 1 Jan 2027. It installs to the home screen, works without data once opened, and syncs ticks and notes between the four of us.

## Using it
1. Open the site link on your phone (with data or Wi-Fi) and pick your name.
2. Add it to your home screen: Safari → Share → Add to Home Screen, or Chrome → ⋮ → Install app.
3. Menu → Offline map → Download (once, on Wi-Fi). After that the street map works with no data.
4. Menu → PDF backup: save the day-by-day PDF to Files or Books as a fallback.

Ticks and notes save on the phone straight away and sync whenever there is signal.

## How it's built
- `site/` is the app (plain HTML, CSS and JavaScript). The itinerary lives in `site/js/data.js`.
- `.github/workflows/deploy.yml` runs on every push: bundles the libraries (MapLibre, PMTiles, Firebase), extracts the offline map from Protomaps for the areas in `map/region.geojson`, renders the PDF backup, and deploys to GitHub Pages.
- Shared state lives in Firebase Firestore under `trips/sib-nyc-2026` (`status` and `notes` collections), with anonymous sign-in.

Map data © OpenStreetMap contributors, tiles via Protomaps.

// Online helpers for added stops: place search and walking routes, both from OpenStreetMap services.
// Search: Photon (photon.komoot.io). Walking routes: OSRM foot profile (routing.openstreetmap.de).

const NYC_BBOX = '-74.26,40.49,-73.70,41.20';

export async function searchPlaces(text, near) {
  const p = new URLSearchParams({ q: text, limit: '8', lang: 'en', bbox: NYC_BBOX });
  if (near) { p.set('lon', near[0]); p.set('lat', near[1]); }
  const res = await fetch('https://photon.komoot.io/api/?' + p.toString());
  if (!res.ok) throw new Error('Search failed');
  const json = await res.json();
  return (json.features || []).map((f) => placeFrom(f)).filter((x) => x.name);
}

export async function nameForSpot(at) {
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lon=${at[0]}&lat=${at[1]}&lang=en`);
    const f = (await res.json()).features?.[0];
    return f ? placeFrom(f) : null;
  } catch { return null; }
}

function placeFrom(f) {
  const p = f.properties || {};
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const area = p.district || p.locality || p.city || '';
  const name = p.name || street;
  return {
    name,
    sub: [p.name ? street : '', area].filter(Boolean).join(', '),
    at: f.geometry.coordinates.map((v) => Math.round(v * 1e6) / 1e6),
    q: [name, p.name ? street : '', area].filter(Boolean).join(', '),
    food: ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'bakery', 'ice_cream', 'food_court', 'deli', 'confectionery'].includes(p.osm_value),
  };
}

const inflight = new Set();
const failed = new Set();

// needs: [{ key, from: [lng, lat], to: [lng, lat] }]; save(key, mode, path)
export async function routeMissing(needs, save) {
  for (const n of needs) {
    if (!navigator.onLine) return;
    if (inflight.has(n.key) || failed.has(n.key)) continue;
    inflight.add(n.key);
    try {
      const url = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${n.from[0]},${n.from[1]};${n.to[0]},${n.to[1]}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      const json = await res.json();
      const coords = json.routes?.[0]?.geometry?.coordinates;
      if (coords && coords.length > 1) {
        const path = [n.from, ...coords.map((c) => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6]), n.to];
        save(n.key, 'walk', simplify(path));
      } else failed.add(n.key);
    } catch {
      failed.add(n.key);
      setTimeout(() => failed.delete(n.key), 60000); // try again later
    } finally {
      inflight.delete(n.key);
    }
  }
}

// Drop points that sit on a straight line (keeps Firestore docs small).
function simplify(pts, tol = 0.00002) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [out[out.length - 1], pts[i], pts[i + 1]];
    const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1e-9;
    if (cross / len > tol) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

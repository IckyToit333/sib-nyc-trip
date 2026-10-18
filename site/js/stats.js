// Distance per day, split by how you get there. Uses the routed street/track paths when available.
import { TRIP } from './data.js';
import { effectiveLegs } from './routes.js';

const R = 6371;
function km(a, b) {
  const [lon1, lat1, lon2, lat2] = [a[0], a[1], b[0], b[1]].map((x) => (x * Math.PI) / 180);
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const lineKm = (pts) => pts.slice(1).reduce((t, p, i) => t + km(pts[i], p), 0);

export function dayDistances(day, status = {}, routes = {}) {
  const out = { walk: 0, subway: 0, ferry: 0, rail: (day.mn || 0) * TRIP.metroNorthKm };
  for (const l of effectiveLegs(day, status, routes)) {
    const d = lineKm(l.path);
    if (l.mode === 'walk') out.walk += d;
    else if (l.mode === 'ferry') out.ferry += d;
    else out.subway += d;
  }
  out.steps = Math.round((out.walk * 1320) / 500) * 500; // ~0.76 m per step
  return out;
}

export const fmtKm = (v) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString('en-US') + ' km';

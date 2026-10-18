// The lines actually travelled on a day, taking skipped and added stops into account.
//   - unchanged legs use the route worked out at build time (stop.path)
//   - legs around skipped stops use build-time detours (BYPASS)
//   - legs to/from added stops use routes worked out on a phone and shared (routes)
//   - anything not routed yet is drawn straight and flagged `need` so a phone with data can route it
import { BYPASS } from './geo.js';

const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
export const legKey = (a, b) => `${a.id}>${b.id}`;

// Before any stops are added, remember each stop's original predecessor.
export function markOriginalOrder(days) {
  for (const d of days) {
    let prev = null;
    for (const s of d.stops) {
      if (!s.at || s.added) continue;
      s._origPrev = prev ? prev.id : null;
      prev = s;
    }
  }
}

export function effectiveLegs(day, status = {}, routes = {}) {
  const legs = [];
  let prev = null;
  for (const s of day.stops) {
    if (!s.at) continue;
    if (s.kind !== 'hub' && status[s.id]?.s === 'skip') continue;
    const baseMode = s.added ? 'walk' : (s.via?.m || 'walk');
    const original = !s.added && (prev ? prev.id : null) === s._origPrev;
    if (baseMode === 'train') { prev = s; continue; }
    if (original) {
      if (s.path) legs.push({ stop: s.id, mode: baseMode, path: s.path });
      else if (prev && !same(prev.at, s.at)) legs.push({ stop: s.id, mode: baseMode, path: [prev.at, s.at] });
    } else if (prev && !same(prev.at, s.at)) {
      const key = legKey(prev, s);
      const b = BYPASS[key] || routes[key];
      if (b && b.path && b.path.length > 1) legs.push({ stop: s.id, mode: b.mode || baseMode, path: b.path, detour: true });
      else legs.push({ stop: s.id, mode: baseMode, path: [prev.at, s.at], detour: true, need: baseMode === 'walk' ? key : null });
    }
    prev = s;
  }
  return legs;
}

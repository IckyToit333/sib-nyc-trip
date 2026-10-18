// The lines actually travelled on a day, taking skipped stops into account.
import { BYPASS } from './geo.js';

const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];

// status: { stopId: { s: 'done' | 'skip' } }
export function effectiveLegs(day, status = {}) {
  const legs = [];
  const placed = day.stops.filter((s) => s.at);
  let prev = null; // last stop we actually go to
  let gap = false; // were stops skipped since `prev`?
  for (const s of placed) {
    if (s.kind !== 'hub' && status[s.id]?.s === 'skip') { gap = true; continue; }
    const mode = s.via?.m || 'walk';
    if (!gap) {
      if (mode !== 'train') {
        if (s.path) legs.push({ stop: s.id, mode, path: s.path });
        else if (prev && !same(prev.at, s.at)) legs.push({ stop: s.id, mode, path: [prev.at, s.at] });
      }
    } else if (prev && mode !== 'train') {
      const b = BYPASS[`${prev.id}>${s.id}`];
      if (b) legs.push({ stop: s.id, mode: b.mode, path: b.path, detour: true });
      else if (!same(prev.at, s.at)) legs.push({ stop: s.id, mode, path: [prev.at, s.at], detour: true });
    }
    prev = s; gap = false;
  }
  return legs;
}

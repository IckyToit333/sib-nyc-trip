// Applies OpenStreetMap-checked pins and street/track routes (built by scripts/geo/geo.py) to the itinerary.
export async function applyGeo(days) {
  let geo = null;
  try { geo = await (await fetch('geo.json')).json(); } catch { return null; }
  for (const d of days) {
    for (const s of d.stops) {
      const g = geo.stops && geo.stops[s.id];
      if (g && g.at) s.at = g.at;
      const l = geo.legs && geo.legs[s.id];
      if (l && l.path && l.path.length > 1) s.path = l.path;
    }
  }
  return geo;
}

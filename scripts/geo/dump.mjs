// Prints the itinerary as JSON for scripts/geo/geo.py.
import { DAYS, GCT, TRIP } from '../../site/js/data.js';

const out = { gct: GCT, home: TRIP.home.at, hotel: TRIP.hotel.at, days: [] };
for (const d of DAYS) {
  out.days.push({
    id: d.id,
    stops: d.stops.map((s) => ({ id: s.id, at: s.at, q: s.q || null, stn: s.stn || null, kind: s.kind || null, via: s.via || null })),
  });
}
process.stdout.write(JSON.stringify(out));

#!/usr/bin/env python3
"""Pin every stop to OpenStreetMap and route every leg along real streets / tracks.

Input:  JSON from scripts/geo/dump.mjs
Output: site/geo.json  {stops: {id: {at, name, moved_m, src}}, legs: {id: {mode, how, path}}, report: [...]}

Sources (all OpenStreetMap data, polite single-threaded use, cached between builds):
  - Nominatim search for named places
  - Overpass for subway stations, subway route geometry and ferry routes
  - routing.openstreetmap.de (OSRM, foot profile) for walking routes
"""
import json, math, os, sys, time, difflib, heapq, urllib.parse, urllib.request

UA = 'sib-nyc-trip/1.0 (https://github.com/IckyToit333/sib-nyc-trip)'
CACHE_PATH = os.environ.get('GEO_CACHE', 'geo-cache/cache.json')
BBOX = (40.68, -74.05, 40.80, -73.82)  # s, w, n, e
MAX_MOVE_M = 350  # reject geocodes further than this from the hand-placed pin

cache = {}
if os.path.exists(CACHE_PATH):
    try:
        cache = json.load(open(CACHE_PATH))
    except Exception:
        cache = {}
report = []


def save_cache():
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    json.dump(cache, open(CACHE_PATH, 'w'))


def fetch(url, data=None, delay=1.1):
    key = url + ('|' + data if data else '')
    if key in cache:
        return cache[key]
    body = data.encode() if data else None
    last = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, data=body, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=240) as r:
                val = json.loads(r.read().decode())
            cache[key] = val
            time.sleep(delay)
            return val
        except Exception as e:  # noqa
            last = e
            time.sleep(4 * (attempt + 1))
    raise RuntimeError(f'fetch failed: {url[:120]} ({last})')


def overpass(q):
    return fetch('https://overpass-api.de/api/interpreter', 'data=' + urllib.parse.quote(q), delay=2)


def dist(a, b):
    """metres between [lon, lat] points"""
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(h))


def simplify(pts, tol_m=3.0):
    """Douglas-Peucker in a local metric projection."""
    if len(pts) < 3:
        return pts
    lat0 = math.radians(pts[0][1])
    xy = [(p[0] * 111320 * math.cos(lat0), p[1] * 110540) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = xy[i], xy[j]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy) or 1e-9
        best, idx = 0, None
        for k in range(i + 1, j):
            x0, y0 = xy[k]
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / L
            if d > best:
                best, idx = d, k
        if idx is not None and best > tol_m:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [[round(p[0], 6), round(p[1], 6)] for p, k in zip(pts, keep) if k]


# ---------------------------------------------------------------- geocoding
def geocode(q, hint):
    lon, lat = hint
    params = {'q': q, 'format': 'jsonv2', 'limit': 5, 'namedetails': 1,
              'viewbox': f'{lon - 0.012},{lat + 0.009},{lon + 0.012},{lat - 0.009}', 'bounded': 1}
    res = fetch('https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode(params))
    if not res:
        params.update({'q': q + ', New York', 'bounded': 0,
                       'viewbox': f'{lon - 0.05},{lat + 0.04},{lon + 0.05},{lat - 0.04}'})
        res = fetch('https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode(params))
    cands = []
    for r in res or []:
        p = [float(r['lon']), float(r['lat'])]
        cands.append((dist(p, hint), p, r))
    if not cands:
        return None
    # Nominatim's ranking first, but never jump far from the hand-placed pin.
    near = [c for c in cands if c[0] <= MAX_MOVE_M]
    pick = near[0] if near else min(cands, key=lambda c: c[0])
    d, p, r = pick
    return {'at': [round(p[0], 6), round(p[1], 6)], 'name': (r.get('name') or r.get('display_name', '')[:60]),
            'osm': f"{r.get('osm_type')}/{r.get('osm_id')}", 'moved_m': round(d)}


def load_stations():
    s, w, n, e = BBOX
    q = f'[out:json][timeout:120];(node["railway"="station"]({s},{w},{n},{e});node["railway"="station"](41.14,-73.89,41.18,-73.84););out;'
    els = overpass(q).get('elements', [])
    return [{'at': [el['lon'], el['lat']], 'name': el.get('tags', {}).get('name', ''),
             'subway': el.get('tags', {}).get('station') == 'subway' or 'subway' in el.get('tags', {}).get('network', '').lower()}
            for el in els]


def norm(t):
    return t.lower().replace('–', '-').replace('street', 'st').replace('avenue', 'av').replace('square', 'sq')


def match_station(name, hint, stations):
    best = None
    for st in stations:
        d = dist(st['at'], hint)
        if d > 700:
            continue
        sim = difflib.SequenceMatcher(None, norm(name), norm(st['name'])).ratio()
        score = sim - d / 1500
        if best is None or score > best[0]:
            best = (score, st, d)
    if not best:
        return None
    _, st, d = best
    return {'at': [round(st['at'][0], 6), round(st['at'][1], 6)], 'name': st['name'], 'osm': 'station', 'moved_m': round(d)}


# ---------------------------------------------------------------- graphs
class Graph:
    def __init__(self):
        self.adj = {}

    def add(self, a, b, w):
        self.adj.setdefault(a, []).append((b, w))
        self.adj.setdefault(b, []).append((a, w))

    def add_line(self, coords):
        prev = None
        for c in coords:
            k = (round(c[0], 7), round(c[1], 7))
            if prev is not None and prev != k:
                self.add(prev, k, dist(prev, k))
            prev = k

    def vertices(self):
        return [v for v in self.adj if isinstance(v, tuple)]

    def nearest(self, p, verts=None):
        verts = verts or self.vertices()
        return min(verts, key=lambda v: dist(v, p)) if verts else None

    def path(self, a, b):
        dist_ = {a: 0}
        prev = {}
        pq = [(0, 0, a)]
        n = 0
        while pq:
            d, _, u = heapq.heappop(pq)
            if u == b:
                break
            if d > dist_.get(u, 1e18):
                continue
            for v, w in self.adj.get(u, []):
                nd = d + w
                if nd < dist_.get(v, 1e18):
                    dist_[v] = nd
                    prev[v] = u
                    n += 1
                    heapq.heappush(pq, (nd, n, v))
        if b not in dist_:
            return None, None
        out = [b]
        while out[-1] != a:
            out.append(prev[out[-1]])
        out.reverse()
        return out, dist_[b]


def load_subway():
    s, w, n, e = BBOX
    q = f'[out:json][timeout:240];relation["route"="subway"]({s},{w},{n},{e});out geom;'
    rels = overpass(q).get('elements', [])
    lines = {}
    for r in rels:
        tags = r.get('tags', {})
        ref = (tags.get('ref') or '').upper().strip()
        name = tags.get('name', '')
        for m in r.get('members', []):
            if m.get('type') == 'way' and m.get('geometry'):
                coords = [[g['lon'], g['lat']] for g in m['geometry']]
                lines.setdefault(ref, []).append(coords)
                if 'SHUTTLE' in name.upper() and '42' in name:
                    lines.setdefault('S', []).append(coords)
    return lines


def load_ferry():
    q = '[out:json][timeout:120];way["route"="ferry"](40.69,-74.02,40.73,-73.95);out geom;'
    ways = overpass(q).get('elements', [])
    return [[[g['lon'], g['lat']] for g in w.get('geometry', [])] for w in ways]


def subway_path(a, b, lines, subway_lines, stations):
    g = Graph()
    used = [l for l in lines if subway_lines.get(l.upper())]
    for l in used:
        for coords in subway_lines[l.upper()]:
            g.add_line(coords)
    if not used:
        for ways in subway_lines.values():
            for coords in ways:
                g.add_line(coords)
    verts = g.vertices()
    if not verts:
        return None
    # Station hubs model transfers between lines at the same station.
    lo = min(a[0], b[0]) - 0.02; hi = max(a[0], b[0]) + 0.02
    la = min(a[1], b[1]) - 0.02; ha = max(a[1], b[1]) + 0.02
    sts = [st for st in stations if st['subway'] and lo <= st['at'][0] <= hi and la <= st['at'][1] <= ha]
    grid = {}
    for v in verts:
        grid.setdefault((int(v[0] / 0.002), int(v[1] / 0.002)), []).append(v)
    hubs = []
    for i, st in enumerate(sts):
        key = f'st:{i}'
        cx, cy = int(st['at'][0] / 0.002), int(st['at'][1] / 0.002)
        linked = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for v in grid.get((cx + dx, cy + dy), []):
                    dd = dist(v, st['at'])
                    if dd < 150:
                        g.add(key, v, 60 + dd)
                        linked = True
        if linked:
            hubs.append((key, st))
    for i in range(len(hubs)):
        for j in range(i + 1, len(hubs)):
            dd = dist(hubs[i][1]['at'], hubs[j][1]['at'])
            if dd < 420:
                g.add(hubs[i][0], hubs[j][0], 120 + dd * 2)
    if not hubs:
        return None
    sa = min(hubs, key=lambda h: dist(h[1]['at'], a))
    sb = min(hubs, key=lambda h: dist(h[1]['at'], b))
    if dist(sa[1]['at'], a) > 900 or dist(sb[1]['at'], b) > 900 or sa[0] == sb[0]:
        return None
    nodes, length = g.path(sa[0], sb[0])
    if not nodes or length > 3.5 * dist(a, b) + 1500:
        return None
    pts = [list(sa[1]['at'])] + [list(v) for v in nodes if isinstance(v, tuple)] + [list(sb[1]['at'])]
    return [list(a)] + simplify(pts, 6) + [list(b)]


def ferry_path(a, b, ferry_ways):
    g = Graph()
    for coords in ferry_ways:
        g.add_line(coords)
    verts = g.vertices()
    if not verts:
        return None
    va, vb = g.nearest(a, verts), g.nearest(b, verts)
    if dist(va, a) > 500 or dist(vb, b) > 500:
        return None
    nodes, length = g.path(va, vb)
    if not nodes or length > 4 * dist(a, b) + 1000:
        return None
    return [list(a)] + simplify([list(v) for v in nodes], 8) + [list(b)]


def walk_path(a, b):
    if dist(a, b) < 25:
        return None
    url = (f'https://routing.openstreetmap.de/routed-foot/route/v1/driving/'
           f'{a[0]:.6f},{a[1]:.6f};{b[0]:.6f},{b[1]:.6f}?overview=full&geometries=geojson')
    res = fetch(url)
    routes = res.get('routes') or []
    if not routes:
        return None
    coords = routes[0]['geometry']['coordinates']
    if routes[0].get('distance', 0) > 4 * dist(a, b) + 400:
        return None
    return [list(a)] + simplify(coords, 2.5) + [list(b)]


# ---------------------------------------------------------------- main
def main():
    src = json.load(open(sys.argv[1]))
    out_path = sys.argv[2]
    gct = src['gct']
    out = {'generated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'stops': {}, 'legs': {}, 'report': report}

    stations = load_stations()
    print('stations', len(stations))

    # 1. pins
    for d in src['days']:
        for s in d['stops']:
            hint = s['at']
            if not hint:
                continue
            res = None
            try:
                if s.get('stn'):
                    res = match_station(s['stn'], hint, stations)
                elif s.get('q'):
                    res = geocode(s['q'], hint)
            except Exception as e:  # noqa
                report.append({'id': s['id'], 'issue': f'lookup failed: {e}'})
            if res and res['moved_m'] > MAX_MOVE_M:
                report.append({'id': s['id'], 'issue': f"rejected {res['name']} ({res['moved_m']} m away)"})
                res = None
            if res:
                out['stops'][s['id']] = res
                if res['moved_m'] > 60:
                    report.append({'id': s['id'], 'moved_m': res['moved_m'], 'to': res['name']})
            elif s.get('q') or s.get('stn'):
                report.append({'id': s['id'], 'issue': 'no match, kept hand-placed pin'})
        save_cache()

    def pos(s):
        return out['stops'].get(s['id'], {}).get('at') or s['at']

    # 2. legs
    subway_lines = None
    ferry_ways = None
    for d in src['days']:
        prev = None
        for i, s in enumerate(d['stops']):
            p = pos(s)
            if not p:
                continue
            via = s.get('via') or {}
            mode = via.get('m', 'walk')
            a = prev
            if a is None and mode == 'subway':
                a = gct
            path, how = None, 'straight'
            if a is not None and mode != 'train' and dist(a, p) >= 25:
                try:
                    if mode == 'walk':
                        path = walk_path(a, p); how = 'streets'
                    elif mode == 'subway':
                        if subway_lines is None:
                            subway_lines = load_subway(); print('subway lines', sorted(subway_lines))
                        path = subway_path(a, p, via.get('lines') or [], subway_lines, stations); how = 'tracks'
                    elif mode == 'ferry':
                        if ferry_ways is None:
                            ferry_ways = load_ferry(); print('ferry ways', len(ferry_ways))
                        path = ferry_path(a, p, ferry_ways); how = 'ferry route'
                except Exception as e:  # noqa
                    report.append({'id': s['id'], 'issue': f'route failed: {e}'})
                if not path:
                    path, how = [list(a), list(p)], 'straight'
                    report.append({'id': s['id'], 'issue': f'{mode} leg drawn straight'})
                out['legs'][s['id']] = {'mode': mode, 'how': how, 'path': path}
            prev = p
        save_cache()

    # 3. detours: skipping 1-3 consecutive stops (not stations) re-routes from the stop before to the stop after
    out['bypass'] = {}
    for d in src['days']:
        seq = [s for s in d['stops'] if pos(s)]
        for i in range(len(seq)):
            for k in (1, 2, 3):
                j = i + k + 1
                if j >= len(seq):
                    break
                skipped = seq[i + 1:j]
                if any(x.get('kind') == 'hub' for x in skipped):
                    break
                A, C = seq[i], seq[j]
                vias = [(x.get('via') or {}) for x in seq[i + 1:j + 1]]
                modes = [v.get('m', 'walk') for v in vias]
                if 'train' in modes:
                    continue
                a, c = pos(A), pos(C)
                key = f"{A['id']}>{C['id']}"
                path, mode = None, 'walk'
                try:
                    if 'ferry' in modes:
                        mode = 'ferry'
                    elif 'subway' in modes:
                        mode = 'subway'
                        lines = []
                        for v in vias:
                            for l in v.get('lines') or []:
                                if l not in lines:
                                    lines.append(l)
                        if subway_lines is None:
                            subway_lines = load_subway()
                        path = subway_path(a, c, lines, subway_lines, stations)
                    else:
                        path = walk_path(a, c)
                except Exception as e:  # noqa
                    report.append({'id': key, 'issue': f'detour failed: {e}'})
                if dist(a, c) < 25:
                    continue
                out['bypass'][key] = {'mode': mode, 'path': path or [list(a), list(c)]}
        save_cache()
    print('detours', len(out['bypass']))

    json.dump(out, open(out_path, 'w'), separators=(',', ':'))
    print(json.dumps(report, indent=1))
    print('stops pinned', len(out['stops']), 'legs', len(out['legs']))


if __name__ == '__main__':
    main()

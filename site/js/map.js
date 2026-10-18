import { maplibregl, PMTiles, Protocol, FileSource, basemaps } from '../vendor/libs.js';
import { ICONS } from './icons.js';
import { effectiveLegs } from './routes.js';

export const MAP_URL = 'map/nyc.pmtiles';
export const MAP_CACHE = 'sib-offline-map';

const BASE = location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
export const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

function baseLayers() {
  try {
    if (typeof basemaps.namedFlavor === 'function') {
      return basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang: 'en' });
    }
    return basemaps.layers('protomaps', 'light', 'en');
  } catch (e) {
    console.warn('basemap layers failed', e);
    return [{ id: 'bg', type: 'background', paint: { 'background-color': '#EDE8DF' } }];
  }
}

export function makeStyle(sourceUrl) {
  return {
    version: 8,
    glyphs: BASE + 'vendor/fonts/{fontstack}/{range}.pbf',
    sprite: BASE + 'vendor/sprites/v4/light',
    sources: {
      protomaps: {
        type: 'vector', url: sourceUrl,
        attribution: '<a href="https://openstreetmap.org/copyright" target="_blank">© OpenStreetMap</a> · <a href="https://protomaps.com" target="_blank">Protomaps</a>',
      },
    },
    layers: baseLayers(),
  };
}

export async function isMapDownloaded() {
  try { return !!(await (await caches.open(MAP_CACHE)).match(MAP_URL)); } catch { return false; }
}

// Prefer the downloaded copy (works with no data); otherwise stream tiles from the site.
async function resolveSource() {
  try {
    const hit = await (await caches.open(MAP_CACHE)).match(MAP_URL);
    if (hit) {
      const blob = await hit.blob();
      const p = new PMTiles(new FileSource(new File([blob], 'nyc.pmtiles')));
      protocol.add(p);
      return { url: 'pmtiles://' + p.source.getKey(), offline: true };
    }
  } catch (e) { console.warn('offline map unreadable', e); }
  const p = new PMTiles(new URL(MAP_URL, BASE).href);
  protocol.add(p);
  return { url: 'pmtiles://' + p.source.getKey(), offline: false };
}

export async function downloadMap(onProgress) {
  const res = await fetch(MAP_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('Download failed (' + res.status + ')');
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress && onProgress(got, total);
  }
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  const cache = await caches.open(MAP_CACHE);
  await cache.put(MAP_URL, new Response(blob, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(blob.size) } }));
  try { await navigator.storage?.persist?.(); } catch { /* optional */ }
  return blob.size;
}

export async function deleteMap() {
  try { await caches.delete(MAP_CACHE); } catch { /* ignore */ }
}

function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

export class TripMap {
  constructor(container, { days, trip, onStopTap, onDayTap }) {
    this.days = days; this.trip = trip;
    this.onStopTap = onStopTap; this.onDayTap = onDayTap;
    this.container = container;
    this.markers = new Map();
    this.dayId = null; this.selId = null; this.status = {};
    this.padding = { top: 130, bottom: 200, left: 30, right: 30 };
    this.offline = false;
  }

  async init() {
    const src = await resolveSource();
    this.offline = src.offline;
    this.map = new maplibregl.Map({
      container: this.container,
      style: makeStyle(src.url),
      center: [-73.985, 40.745], zoom: 12, minZoom: 9, maxZoom: 18.5,
      attributionControl: { compact: true },
      pitchWithRotate: false, dragRotate: false, touchPitch: false,
      fadeDuration: 0,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true,
    }), 'top-right');
    this.map.on('style.load', () => this.addOverlays());
    this.map.on('error', (e) => console.warn('map error', e && e.error));
    this.buildMarkers();
    await new Promise((r) => this.map.once('load', r));
  }

  async useDownloaded() {
    const src = await resolveSource();
    this.offline = src.offline;
    this.map.setStyle(makeStyle(src.url));
  }

  addOverlays() {
    const m = this.map;
    if (m.getSource('legs')) return;
    const legs = this.legFeatures(); const dots = [];
    for (const d of this.days) {
      for (const s of d.stops) {
        if (s.at && s.kind !== 'hub') dots.push({ type: 'Feature', properties: { day: d.id, stop: s.id, color: d.color }, geometry: { type: 'Point', coordinates: s.at } });
      }
    }
    m.addSource('legs', { type: 'geojson', data: { type: 'FeatureCollection', features: legs } });
    m.addSource('dots', { type: 'geojson', data: { type: 'FeatureCollection', features: dots } });
    m.addLayer({ id: 'legs-casing', type: 'line', source: 'legs', filter: ['!=', ['get', 'mode'], 'walk'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-width': 6, 'line-opacity': 0.9 } });
    m.addLayer({ id: 'legs-transit', type: 'line', source: 'legs', filter: ['!=', ['get', 'mode'], 'walk'], layout: { 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3.5 } });
    m.addLayer({ id: 'legs-walk', type: 'line', source: 'legs', filter: ['==', ['get', 'mode'], 'walk'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-dasharray': [0.1, 2] } });
    m.addLayer({ id: 'dots', type: 'circle', source: 'dots', paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 8], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    if (!this._handlers) {
      this._handlers = true;
      m.on('click', 'dots', (e) => { const f = e.features?.[0]; if (f) this.onDayTap(f.properties.day, f.properties.stop); });
      m.on('mouseenter', 'dots', () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', 'dots', () => { m.getCanvas().style.cursor = ''; });
    }
    this.applyFilters();
  }

  buildMarkers() {
    const home = el(`<div class="pin-place" title="${this.trip.home.name}">${ICONS.home}</div>`);
    new maplibregl.Marker({ element: home }).setLngLat(this.trip.home.at).addTo(this.map);
    const hotel = el(`<div class="pin-place hotel" title="${this.trip.hotel.name}">${ICONS.bed}</div>`);
    new maplibregl.Marker({ element: hotel }).setLngLat(this.trip.hotel.at).addTo(this.map);

    for (const d of this.days) {
      let n = 0;
      for (const s of d.stops) {
        const isHub = s.kind === 'hub';
        if (!isHub) n++;
        s._n = isHub ? null : n;
        if (!s.at) continue;
        const node = el(`<div class="pin ${s.kind || ''}" style="--c:${d.color}" role="button" aria-label="${s.name}">${isHub ? '' : n}</div>`);
        node.addEventListener('click', (e) => { e.stopPropagation(); this.onStopTap(d.id, s.id); });
        const marker = new maplibregl.Marker({ element: node, anchor: 'center' }).setLngLat(s.at);
        this.markers.set(s.id, { marker, node, day: d.id, stop: s, shown: false });
      }
    }
  }

  legFeatures() {
    const out = [];
    for (const d of this.days) {
      for (const l of effectiveLegs(d, this.status)) {
        out.push({ type: 'Feature', properties: { day: d.id, color: d.color, mode: l.mode }, geometry: { type: 'LineString', coordinates: l.path } });
      }
    }
    return out;
  }

  setStatus(status) {
    this.status = status;
    const src = this.map && this.map.getSource && this.map.getSource('legs');
    if (src) src.setData({ type: 'FeatureCollection', features: this.legFeatures() });
    for (const [id, m] of this.markers) {
      const st = status[id]?.s;
      m.node.classList.toggle('done', st === 'done');
      m.node.classList.toggle('skip', st === 'skip');
      if (m.stop.kind !== 'hub') m.node.innerHTML = st === 'done' ? ICONS.tick : (m.stop._n ?? '');
    }
  }

  setPadding(p) { this.padding = { ...this.padding, ...p }; }

  applyFilters() {
    const m = this.map; if (!m || !m.getLayer('legs-walk')) return;
    const all = this.dayId === 'all';
    const f = all ? null : ['==', ['get', 'day'], this.dayId || ''];
    const base = (extra) => (f ? ['all', f, extra] : extra);
    m.setFilter('legs-walk', base(['==', ['get', 'mode'], 'walk']));
    m.setFilter('legs-transit', base(['!=', ['get', 'mode'], 'walk']));
    m.setFilter('legs-casing', base(['!=', ['get', 'mode'], 'walk']));
    m.setLayoutProperty('dots', 'visibility', all ? 'visible' : 'none');
    for (const id of ['legs-walk', 'legs-transit']) m.setPaintProperty(id, 'line-opacity', all ? 0.45 : 0.9);
  }

  showDay(dayId) {
    this.dayId = dayId;
    for (const [, m] of this.markers) {
      const want = m.day === dayId;
      if (want && !m.shown) { m.marker.addTo(this.map); m.shown = true; }
      if (!want && m.shown) { m.marker.remove(); m.shown = false; }
    }
    this.applyFilters();
    this.fit();
  }

  fit(animate = true) {
    const pts = [];
    if (this.dayId === 'all') {
      for (const d of this.days) for (const s of d.stops) if (s.at) pts.push(s.at);
    } else {
      const d = this.days.find((x) => x.id === this.dayId);
      // flyTo/easeTo leave their padding on the map, and fitBounds would add it again; reset first.
      this.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      if (d?.home) { this.map.flyTo({ center: this.trip.home.at, zoom: 13.5, padding: this.padding, duration: animate ? 800 : 0 }); return; }
      // Frame the places you visit; stations and the trip home to Grand Central sit outside if needed.
      for (const s of d?.stops || []) if (s.at && s.kind !== 'hub') pts.push(s.at);
      if (!pts.length) for (const s of d?.stops || []) if (s.at) pts.push(s.at);
    }
    if (!pts.length) return;
    this.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    pts.forEach((p) => b.extend(p));
    this.map.fitBounds(b, { padding: this.padding, maxZoom: 15.5, duration: animate ? 800 : 0 });
  }

  select(stopId, fly = true) {
    if (this.selId && this.markers.get(this.selId)) this.markers.get(this.selId).node.classList.remove('sel');
    this.selId = stopId;
    const m = stopId && this.markers.get(stopId);
    if (!m) return;
    m.node.classList.add('sel');
    if (fly) this.map.easeTo({ center: m.stop.at, zoom: Math.max(this.map.getZoom(), 15), padding: this.padding, duration: 600 });
  }

  resize() { this.map && this.map.resize(); }
}

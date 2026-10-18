// Builds the printable offline backup (one page per day). Rendered to PDF in GitHub Actions.
import { maplibregl, PMTiles, FileSource } from '../vendor/libs.js';
import { TRIP, DAYS, LINE_COLORS } from './data.js';
import { makeStyle, protocol, MAP_URL } from './map.js';
import { applyGeo } from './geo.js';

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const log = (...a) => console.log('[print]', ...a);

async function loadSource() {
  const blob = await (await fetch(MAP_URL)).blob();
  const p = new PMTiles(new FileSource(new File([blob], 'nyc.pmtiles')));
  protocol.add(p);
  return 'pmtiles://' + p.source.getKey();
}

function features() {
  const legs = []; const pts = [];
  for (const d of DAYS) {
    let prev = null; let n = 0;
    for (const s of d.stops) {
      const hub = s.kind === 'hub';
      if (!hub) n++;
      if (!s.at) continue;
      const mode = s.via?.m || 'walk';
      if (s.path && mode !== 'train') {
        legs.push({ type: 'Feature', properties: { day: d.id, color: d.color, walk: mode === 'walk' }, geometry: { type: 'LineString', coordinates: s.path } });
      } else if (prev && mode !== 'train' && !(prev[0] === s.at[0] && prev[1] === s.at[1])) {
        legs.push({ type: 'Feature', properties: { day: d.id, color: d.color, walk: mode === 'walk' }, geometry: { type: 'LineString', coordinates: [prev, s.at] } });
      }
      prev = s.at;
      pts.push({ type: 'Feature', properties: { day: d.id, color: d.color, label: hub ? '' : String(n), hub }, geometry: { type: 'Point', coordinates: s.at } });
    }
  }
  return { legs, pts };
}

function waitIdle(map, ms = 20000) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    map.once('idle', () => { clearTimeout(t); resolve(); });
  });
}

async function renderMaps() {
  const url = await loadSource();
  const map = new maplibregl.Map({
    container: 'render', style: makeStyle(url), interactive: false, attributionControl: false,
    preserveDrawingBuffer: true, pixelRatio: 2, fadeDuration: 0, center: [-73.985, 40.745], zoom: 12,
  });
  await new Promise((r) => map.once('load', r));
  const { legs, pts } = features();
  map.addSource('legs', { type: 'geojson', data: { type: 'FeatureCollection', features: legs } });
  map.addSource('pts', { type: 'geojson', data: { type: 'FeatureCollection', features: pts } });
  map.addSource('places', { type: 'geojson', data: { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { label: 'Home' }, geometry: { type: 'Point', coordinates: TRIP.home.at } },
    { type: 'Feature', properties: { label: 'Westin' }, geometry: { type: 'Point', coordinates: TRIP.hotel.at } },
  ] } });
  map.addLayer({ id: 'legs-c', type: 'line', source: 'legs', filter: ['!', ['get', 'walk']], paint: { 'line-color': '#fff', 'line-width': 6 } });
  map.addLayer({ id: 'legs-t', type: 'line', source: 'legs', filter: ['!', ['get', 'walk']], paint: { 'line-color': ['get', 'color'], 'line-width': 3.5 } });
  map.addLayer({ id: 'legs-w', type: 'line', source: 'legs', filter: ['get', 'walk'], layout: { 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-dasharray': [0.1, 2] } });
  map.addLayer({ id: 'places', type: 'circle', source: 'places', paint: { 'circle-color': '#14213D', 'circle-radius': 7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'places-l', type: 'symbol', source: 'places', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top' }, paint: { 'text-color': '#14213D', 'text-halo-color': '#fff', 'text-halo-width': 2 } });
  map.addLayer({ id: 'pts', type: 'circle', source: 'pts', paint: { 'circle-color': ['case', ['get', 'hub'], '#fff', ['get', 'color']], 'circle-radius': ['case', ['get', 'hub'], 6, 11], 'circle-stroke-color': ['case', ['get', 'hub'], ['get', 'color'], '#fff'], 'circle-stroke-width': ['case', ['get', 'hub'], 3, 2] } });
  map.addLayer({ id: 'pts-l', type: 'symbol', source: 'pts', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#fff' } });

  const images = {};
  for (const d of DAYS) {
    const f = ['==', ['get', 'day'], d.id];
    map.setFilter('legs-c', ['all', f, ['!', ['get', 'walk']]]);
    map.setFilter('legs-t', ['all', f, ['!', ['get', 'walk']]]);
    map.setFilter('legs-w', ['all', f, ['get', 'walk']]);
    map.setFilter('pts', f); map.setFilter('pts-l', f);
    if (d.home || !d.stops.some((s) => s.at)) {
      map.jumpTo({ center: TRIP.home.at, zoom: 14 });
    } else {
      const coords = d.stops.filter((s) => s.at).map((s) => s.at);
      const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
      coords.forEach((c) => b.extend(c));
      map.fitBounds(b, { padding: 45, maxZoom: 16, duration: 0 });
    }
    await waitIdle(map);
    images[d.id] = map.getCanvas().toDataURL('image/jpeg', 0.86);
    log('rendered', d.id);
  }
  map.remove();
  return images;
}

function bullets(lines) {
  return (lines || []).map((l) => `<span class="num" style="background:${LINE_COLORS[l] || '#777'};${['N', 'Q', 'R', 'W'].includes(l) ? 'color:#111' : ''};width:14px;height:14px;line-height:14px;font-size:7pt">${l}</span>`).join(' ');
}

function dayPage(d, img) {
  if (d.home) {
    return `<section class="page"><div class="band" style="background:${d.color}"><span class="d">${d.dow} ${d.num} Dec</span><span class="t">Christmas Day at home</span></div>
      <img class="mapimg" src="${img}" alt=""><div class="home">At home in Ossining<br><br>${d.tips.map(esc).join('<br>')}</div></section>`;
  }
  let n = 0;
  const rows = d.stops.map((s) => {
    const hub = s.kind === 'hub';
    if (!hub) n++;
    const via = s.via && s.via.m !== 'walk' ? `<div class="via">${bullets(s.via.lines)} ${esc(s.via.text || '')}</div>` : '';
    return `<tr><td class="time">${esc(s.t)}</td>
      <td class="n"><span class="num ${hub ? 'hub' : ''} ${s.kind === 'food' ? 'food' : ''}" style="background:${d.color};border-color:${d.color}">${hub ? '' : n}</span></td>
      <td>${via}<span class="tick"></span> <span class="name">${esc(s.name)}</span>${s.flag ? `<span class="flag">${esc(s.flag)}</span>` : ''}${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}</td>
      <td class="cost">${hub ? '' : esc(s.cost || '')}</td></tr>`;
  }).join('');
  const date = /^\d+$/.test(d.num) ? `${d.dow} ${d.num} Dec` : `${d.dow} ${d.num}`;
  return `<section class="page">
    <div class="band" style="background:${d.color}"><span class="d">${date}</span><span class="t">${esc(d.title)}</span></div>
    <div class="meta"><b>Start:</b> ${esc(d.start)}${d.end ? ` &nbsp;·&nbsp; <b>End:</b> ${esc(d.end)}` : ''}</div>
    <img class="mapimg" src="${img}" alt="">
    <table>${rows}</table>
    ${d.tips?.length ? `<ul class="tips">${d.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function cover() {
  return `<section class="page cover">
    <h1>NYC · Dec 2026</h1>
    <h2>Offline backup · 23 Dec 2026 – 1 Jan 2027 · Ty, Tim, Ash & DT</h2>
    <h3>Bases</h3>
    <ul><li><b>Home:</b> Ossining, NY (Metro-North Hudson Line, ~55 min to Grand Central)</li>
    <li><b>30 Dec:</b> Westin Grand Central, 212 E 42nd St</li></ul>
    <h3>Getting around</h3>
    <ul>
      <li>Each person taps their own contactless card or phone at the subway gate. The $35 weekly cap is per card.</li>
      <li>Buy Metro-North tickets in the MTA TrainTime app before boarding; buying on the train costs more.</li>
      <li>Weekly Metro-North ticket: buy on 23 or 24 Dec so it runs Sat 26 Dec – Fri 1 Jan.</li>
      <li>On 24 Dec, 31 Dec and 1 Jan, check TrainTime for holiday timetables.</li>
      <li>Emergency: 911.</li>
    </ul>
    <h3>How to read the maps</h3>
    <div class="key">
      <span><span class="num" style="background:#14213D">1</span> stop, in visiting order</span>
      <span><span class="num food" style="background:#14213D">2</span> food stop</span>
      <span><span class="num hub" style="border-color:#14213D"></span> station / transfer</span>
      <span>dotted line = walk · solid line = subway / ferry</span>
    </div>
    <h3>Days</h3>
    <ul>${DAYS.map((d) => `<li><span class="sw" style="background:${d.color}"></span> <b>${d.dow} ${d.num}</b> – ${esc(d.title)}</li>`).join('')}</ul>
    <p class="note" style="margin-top:8mm">The live app (with shared ticks and notes) is on your home screen. This PDF is a fallback with no data needed. Pins are approximate.</p>
  </section>`;
}

(async () => {
  try {
    await applyGeo(DAYS);
    const imgs = await renderMaps();
    document.getElementById('pages').innerHTML = cover() + DAYS.map((d) => dayPage(d, imgs[d.id])).join('');
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
    window.__printDone = true;
    log('done');
  } catch (e) {
    console.error('[print] failed', e);
    window.__printError = String(e && e.stack || e);
  }
})();

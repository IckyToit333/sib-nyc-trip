import { TRIP, DAYS, LINE_COLORS } from './data.js';
import { ICONS } from './icons.js';
import { createSync } from './sync.js';
import { TripMap, downloadMap, deleteMap, isMapDownloaded } from './map.js';
import { applyGeo } from './geo.js';
import { dayDistances, fmtKm } from './stats.js';
import { markOriginalOrder, effectiveLegs } from './routes.js';
import { searchPlaces, nameForSpot, routeMissing } from './live.js';

const $ = (sel) => document.querySelector(sel);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const isWide = () => matchMedia('(min-width: 860px)').matches;
const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);

const STOP_BY_ID = new Map();
const indexStops = () => { STOP_BY_ID.clear(); DAYS.forEach((d) => d.stops.forEach((s) => STOP_BY_ID.set(s.id, { day: d, stop: s }))); };
indexStops();
{ // number the planned (non-transit) stops per day; added stops show a "+"
  for (const d of DAYS) { let n = 0; for (const s of d.stops) s._n = s.kind === 'hub' ? null : ++n; }
}

// ---------- Added stops (shared through Firebase) ----------
let addedSig = '';
function applyAdded() {
  const list = Object.entries(ui.shared.added || {}).map(([id, a]) => ({ id, ...a }))
    .filter((a) => typeof a.lng === 'number' && typeof a.lat === 'number' && a.name)
    .sort((a, b) => (a.created || 0) - (b.created || 0));
  const sig = JSON.stringify(list.map((a) => [a.id, a.day, a.after, a.lng, a.lat, a.name, a.t, a.cost, a.kind, a.note]));
  if (sig === addedSig) return false;
  addedSig = sig;
  for (const d of DAYS) d.stops = d.stops.filter((s) => !s.added);
  for (const a of list) {
    const d = DAYS.find((x) => x.id === a.day);
    if (!d || d.home) continue;
    const stop = {
      id: a.id, added: true, by: a.by, created: a.created, _n: '+', _anchor: a.after || null,
      t: a.t || '', name: a.name, at: [a.lng, a.lat], kind: a.kind === 'food' ? 'food' : undefined,
      cost: a.cost || '', note: a.note || '', q: a.q || null,
    };
    let idx = a.after ? d.stops.findIndex((s) => s.id === a.after) : -1;
    if (a.after && idx < 0) idx = d.stops.length - 1;
    let j = idx + 1;
    while (j < d.stops.length && d.stops[j].added && d.stops[j]._anchor === stop._anchor) j++;
    d.stops.splice(j, 0, stop);
  }
  indexStops();
  if (ui.sel && !STOP_BY_ID.has(ui.sel)) ui.sel = null;
  return true;
}

// Work out walking routes for legs that touch added stops, once, on whichever phone is online.
function requestMissingRoutes() {
  if (!ui.shared.ready || !navigator.onLine) return;
  const needs = [];
  for (const d of DAYS) {
    for (const l of effectiveLegs(d, ui.shared.status, ui.shared.routes)) {
      if (l.need) needs.push({ key: l.need, from: l.path[0], to: l.path[l.path.length - 1] });
    }
  }
  if (needs.length) routeMissing(needs, (key, mode, path) => sync.saveRoute(key, mode, path));
}

const ui = {
  dayId: null,
  sel: null,
  who: (() => { // earlier versions stored short names
    const w = LS.get('sib.who', null);
    const full = { Ty: 'Tylah', Ash: 'Ashlee', DT: 'Du Toit' }[w];
    if (full) LS.set('sib.who', full);
    return full || w;
  })(),
  shared: { status: {}, notes: {}, online: navigator.onLine, ready: false, pending: false, lastServerSync: 0, error: null },
  sheet: 'half',
  version: null,
  mapReady: false,
  mapDownloaded: false,
  downloading: null,
};

// ---------- Time helpers (New York) ----------
const nyDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: TRIP.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const fmtWhen = (ms) => {
  if (!ms) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: TRIP.timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
};
const TODAY = nyDate();
const todayDay = DAYS.find((d) => d.date === TODAY);

// ---------- Shared state ----------
const sync = createSync(TRIP.id, (snap) => {
  ui.shared = snap;
  const changed = applyAdded();
  renderPill();
  renderTabs();
  renderSheet(false);
  tripMap && ui.mapReady && tripMap.update(snap.status, snap.routes, changed);
  requestMissingRoutes();
});
ui.shared = sync.snapshot();

const statusOf = (id) => ui.shared.status[id]?.s || '';
const notesFor = (id) => Object.entries(ui.shared.notes).filter(([, n]) => n.stop === id).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
function dayProgress(d) {
  const real = d.stops.filter((s) => s.kind !== 'hub');
  const done = real.filter((s) => statusOf(s.id)).length;
  return { done, total: real.length };
}

// ---------- Rendering: tabs ----------
function renderTabs() {
  const tabs = $('#dayTabs');
  const items = [`<button class="day-tab all" role="tab" data-day="all" aria-selected="${ui.dayId === 'all'}"><span class="dow">Trip</span><span class="num">All</span></button>`];
  for (const d of DAYS) {
    const p = dayProgress(d);
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    items.push(`<button class="day-tab${d.date === TODAY ? ' today' : ''}" role="tab" style="--c:${d.color}" data-day="${d.id}" aria-selected="${ui.dayId === d.id}" aria-label="${d.dow} ${d.num}: ${esc(d.title)}">
      <span class="dow">${d.dow}</span><span class="num">${d.num}</span>${d.home ? '<span class="dot"></span>' : `<span class="bar"><b style="width:${pct}%"></b></span>`}</button>`);
  }
  tabs.innerHTML = items.join('');
}

// ---------- Rendering: sheet ----------
function bullets(lines) {
  return `<span class="bullets">${lines.map((l) => `<span class="bullet${['N', 'Q', 'R', 'W'].includes(l) ? ' dark' : ''}" style="background:${LINE_COLORS[l] || '#777'}">${l}</span>`).join('')}</span>`;
}
function legHTML(s) {
  const v = s.via;
  if (!v || v.m === 'walk') return '';
  const icon = v.m === 'ferry' ? ICONS.ferry : ICONS.train;
  const lead = v.lines?.length ? bullets(v.lines) : `<span class="mode-ico">${icon}</span>`;
  return `<li class="leg">${lead}<span>${esc(v.text || '')}</span></li>`;
}
function directions(s) {
  const [lng, lat] = s.at;
  const transit = s.via && s.via.m !== 'walk';
  // Hand the place name to the maps app so it navigates to its own exact entry for the place.
  const place = s.q ? `${s.q}, New York, NY` : s.stn ? `${s.stn} station, New York, NY` : `${lat},${lng}`;
  const g = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}&travelmode=${transit ? 'transit' : 'walking'}`;
  const a = `https://maps.apple.com/?daddr=${encodeURIComponent(place)}&sll=${lat},${lng}&dirflg=${transit ? 'r' : 'w'}`;
  return `<a class="btn" href="${g}" target="_blank" rel="noopener">${ICONS.nav} Google Maps</a>${isApple ? `<a class="btn" href="${a}" target="_blank" rel="noopener">${ICONS.nav} Apple Maps</a>` : ''}`;
}
function stopHTML(d, s, nextId) {
  const st = statusOf(s.id);
  const sel = ui.sel === s.id;
  const notes = notesFor(s.id);
  const hub = s.kind === 'hub';
  const badge = hub ? `<span class="badge hub"></span>` : `<span class="badge ${s.kind === 'food' ? 'food' : ''} ${s.added ? 'added' : ''}">${st === 'done' ? ICONS.tickSm : s._n}</span>`;
  const tags = [
    s.cost && !hub ? `<span class="tag">${esc(s.cost)}</span>` : '',
    s.flag ? `<span class="tag flag">${esc(s.flag)}</span>` : '',
    nextId === s.id ? '<span class="tag next">Next</span>' : '',
    notes.length ? `<span class="tag notes">${notes.length} note${notes.length > 1 ? 's' : ''}</span>` : '',
    s.added ? `<span class="tag added">Added by ${esc(s.by || 'someone')}</span>` : '',
  ].join('');
  const statusInfo = ui.shared.status[s.id];
  const more = sel ? `
    <div class="stop-more">
      ${statusInfo?.s ? `<p class="who-line">${statusInfo.s === 'done' ? 'Done' : 'Skipped'} by ${esc(statusInfo.by || 'someone')} · ${fmtWhen(statusInfo.at)}</p>` : ''}
      ${s.note ? `<p>${esc(s.note)}</p>` : ''}
      <div class="actions">
        <button class="btn ${st === 'done' ? 'on' : ''}" data-act="done" data-id="${s.id}">${ICONS.tickSm} ${st === 'done' ? 'Done' : 'Mark done'}</button>
        ${hub ? '' : `<button class="btn ${st === 'skip' ? 'on-skip' : ''}" data-act="skip" data-id="${s.id}">${ICONS.skip} ${st === 'skip' ? 'Skipped' : 'Skip'}</button>`}
        ${s.at ? directions(s) : ''}
        ${hub ? '' : `<button class="btn" data-act="add-after" data-id="${s.id}">${ICONS.plus} Add a stop after this</button>`}
        ${s.added ? `<button class="btn danger" data-act="remove-added" data-id="${s.id}">${ICONS.trash} Remove</button>` : ''}
      </div>
      ${s.added ? `<p class="who-line" style="margin-top:8px">Added by ${esc(s.by || 'someone')} · ${fmtWhen(s.created)}</p>` : ''}
      <div class="notes">
        ${notes.map(([nid, n]) => `<div class="note"><div class="meta">${esc(n.by || 'Someone')} · ${fmtWhen(n.at)}</div>${esc(n.text)}${n.by && n.by === ui.who ? `<button class="del" data-act="note-del" data-id="${nid}" aria-label="Delete note">${ICONS.trash}</button>` : ''}</div>`).join('')}
      </div>
      <form class="note-form" data-id="${s.id}">
        <textarea rows="1" placeholder="Add a note for everyone…" aria-label="Add a note" maxlength="500"></textarea>
        <button class="btn primary" type="submit">Add</button>
      </form>
    </div>` : '';
  return `<li class="stop ${hub ? 'hub' : ''} ${st} ${sel ? 'sel' : ''}" id="stop-${s.id}">
    <div class="stop-main" data-act="open" data-id="${s.id}" role="button" tabindex="0" aria-expanded="${sel}">
      ${badge}
      <span class="stop-txt"><span class="stop-time">${esc(s.t)}${tags ? ' ' + tags : ''}</span><span class="stop-name">${esc(s.name)}</span></span>
      <button class="check" data-act="done" data-id="${s.id}" aria-label="${st === 'done' ? 'Mark not done' : 'Mark done'}"><i>${st === 'skip' ? ICONS.x : ICONS.tick}</i></button>
    </div>${more}</li>`;
}

function statsHTML(dist) {
  const transitLabel = dist.ferry > 0.05 ? 'subway & ferry' : 'subway';
  const transit = dist.subway + dist.ferry;
  return `<div class="stats">
    <div class="stat"><span class="stat-ico">${ICONS.walk}</span><b>${fmtKm(dist.walk)}</b><small>walking${dist.steps ? ` · ~${dist.steps.toLocaleString('en-US')} steps` : ''}</small></div>
    <div class="stat"><span class="stat-ico">${ICONS.train}</span><b>${transit > 0.05 ? fmtKm(transit) : '–'}</b><small>${transitLabel}</small></div>
    <div class="stat"><span class="stat-ico">${ICONS.train}</span><b>${dist.rail ? fmtKm(dist.rail) : '–'}</b><small>Metro-North</small></div>
  </div>`;
}

function transitLinks() {
  const g = (o, d) => `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&travelmode=transit`;
  return `<div class="links">
    <a class="link-chip" target="_blank" rel="noopener" href="${g('Ossining Station, Ossining, NY', 'Grand Central Terminal, New York, NY')}">${ICONS.train} Ossining → GCT</a>
    <a class="link-chip" target="_blank" rel="noopener" href="${g('Grand Central Terminal, New York, NY', 'Ossining Station, Ossining, NY')}">${ICONS.train} GCT → Ossining</a>
    <a class="link-chip" target="_blank" rel="noopener" href="https://www.mta.info/guides/apps">${ICONS.link} TrainTime app</a>
  </div>`;
}

function renderSheet(scrollToSel = true) {
  const head = $('#sheetHead');
  const body = $('#sheetBody');
  const keepScroll = body.scrollTop;
  // Keep any half-typed note (and focus) across re-renders triggered by sync.
  const drafts = {};
  body.querySelectorAll('.note-form').forEach((f) => { const ta = f.querySelector('textarea'); if (ta.value) drafts[f.dataset.id] = ta.value; });
  const act = document.activeElement;
  const focusId = act && act.matches('.note-form textarea') ? act.closest('.note-form').dataset.id : null;
  const caret = focusId ? act.selectionStart : 0;
  if (ui.dayId === 'all') {
    document.documentElement.style.setProperty('--day', 'var(--ink)');
    let done = 0; let total = 0;
    const sum = { walk: 0, subway: 0, ferry: 0, rail: 0, steps: 0 };
    DAYS.forEach((d) => {
      const p = dayProgress(d); done += p.done; total += p.total;
      const x = dayDistances(d, ui.shared.status, ui.shared.routes); for (const k of Object.keys(sum)) sum[k] += x[k];
    });
    head.innerHTML = `<div class="dh-date">23 Dec – 1 Jan<span class="count">${done} of ${total} done</span></div>
      <h2 class="dh-title">The whole trip</h2><div class="dh-prog"><b style="width:${total ? (done / total) * 100 : 0}%"></b></div>`;
    body.innerHTML = `<div class="day-meta">${statsHTML(sum)}<p class="small-note">Walking between stops only. Wandering inside parks, markets and museums adds more.</p></div>` + DAYS.map((d) => {
      const p = dayProgress(d);
      return `<button class="day-card" style="--c:${d.color}" data-act="day" data-id="${d.id}"><span class="sw"></span>
        <span><div class="dc-date">${d.dow} ${d.num}${d.date === TODAY ? ' · Today' : ''}</div><div class="dc-title">${esc(d.title)}</div>
        <div class="dc-sub">${d.home ? 'At home' : `${p.total} stops · ${fmtKm(dayDistances(d, ui.shared.status, ui.shared.routes).walk)} walking · ${p.done} done`}</div></span><span class="chev">${ICONS.chev}</span></button>`;
    }).join('');
  } else {
    const d = DAYS.find((x) => x.id === ui.dayId);
    document.documentElement.style.setProperty('--day', d.color);
    const p = dayProgress(d);
    head.innerHTML = `<div class="dh-date">${d.dow} ${d.num}${/^\d+$/.test(d.num) ? ' Dec' : ''}${d.date === TODAY ? ' · Today' : ''}${d.home ? '' : `<span class="count">${p.done} of ${p.total} done</span>`}</div>
      <h2 class="dh-title">${esc(d.title)}</h2>${d.home ? '' : `<div class="dh-prog"><b style="width:${p.total ? (p.done / p.total) * 100 : 0}%"></b></div>`}`;
    if (d.home) {
      body.innerHTML = `<div class="home-card"><div class="big">🎄</div><h3>At home in Ossining</h3>${d.tips.map((t) => `<p>${esc(t)}</p>`).join('')}</div>`;
    } else {
      const nextId = d.date === TODAY ? d.stops.find((s) => s.kind !== 'hub' && !statusOf(s.id))?.id : null;
      const meta = `<div class="day-meta">
        ${statsHTML(dayDistances(d, ui.shared.status, ui.shared.routes))}
        <div class="row">${ICONS.clock}<span>${esc(d.start)}</span></div>
        ${d.end ? `<div class="row">${ICONS.flagEnd}<span>${esc(d.end)}</span></div>` : ''}
        ${d.tips?.length ? `<ul>${d.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        ${transitLinks()}
      </div>`;
      const list = d.stops.map((s) => (s.added ? '' : legHTML(s)) + stopHTML(d, s, nextId)).join('');
      body.innerHTML = meta + `<ul class="stops">${list}</ul><button class="add-stop" data-act="add" data-id="${d.id}">${ICONS.plus} Add a stop to this day</button>`;
    }
  }
  body.scrollTop = keepScroll;
  body.querySelectorAll('.note-form').forEach((f) => {
    const ta = f.querySelector('textarea');
    if (drafts[f.dataset.id]) ta.value = drafts[f.dataset.id];
    if (focusId === f.dataset.id) { ta.focus({ preventScroll: true }); try { ta.setSelectionRange(caret, caret); } catch { /* ignore */ } }
  });
  if (scrollToSel && ui.sel) {
    const node = document.getElementById('stop-' + ui.sel);
    if (node) body.scrollTo({ top: Math.max(0, node.offsetTop - body.offsetTop - 8), behavior: 'smooth' });
  }
  layoutSheet(false);
}

function renderPill() {
  const pill = $('#syncPill');
  const s = ui.shared;
  let cls = ''; let text = 'Connecting…';
  if (!s.online) { cls = s.pending ? 'pending' : 'off'; text = s.pending ? 'Offline · saved' : 'Offline'; }
  else if (s.error && !s.ready) { cls = 'pending'; text = 'Sync paused'; }
  else if (!s.ready) { cls = ''; text = 'Connecting…'; }
  else if (s.pending) { cls = 'pending'; text = 'Syncing…'; }
  else { cls = 'ok'; text = 'Synced'; }
  pill.className = 'pill ' + cls;
  pill.querySelector('span').textContent = text;
}

// ---------- Selection ----------
function setDay(dayId, { stop = null, fit = true, sheet = null } = {}) {
  ui.dayId = dayId;
  ui.sel = stop;
  LS.set('sib.day', dayId);
  history.replaceState(null, '', '#' + dayId + (stop ? '/' + stop : ''));
  renderTabs();
  if (sheet) setSheet(sheet, false);
  renderSheet();
  const tab = document.querySelector(`.day-tab[data-day="${dayId}"]`);
  tab && tab.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  if (tripMap && ui.mapReady) {
    tripMap.showDay(dayId === 'all' ? 'all' : dayId);
    tripMap.select(stop, false);
    if (stop) tripMap.select(stop, true);
  }
}

function selectStop(stopId, { fly = true } = {}) {
  const hit = STOP_BY_ID.get(stopId);
  if (!hit) return;
  if (ui.dayId !== hit.day.id) { setDay(hit.day.id, { stop: stopId, sheet: 'half' }); return; }
  ui.sel = ui.sel === stopId && !fly ? null : stopId;
  history.replaceState(null, '', '#' + ui.dayId + (ui.sel ? '/' + ui.sel : ''));
  if (ui.sheet === 'peek') setSheet('half', false);
  renderSheet();
  if (tripMap && ui.mapReady) tripMap.select(ui.sel, fly && !!ui.sel);
}

// ---------- Actions ----------
function ensureWho(then) {
  if (ui.who) { then(); return; }
  openWho(then);
}
function toggleStatus(id, value) {
  ensureWho(() => {
    const cur = statusOf(id);
    const next = cur === value ? '' : value;
    sync.setStatus(id, next, ui.who);
    if (next === 'done' && navigator.vibrate) navigator.vibrate(12);
  });
}

$('#sheetBody').addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const { act, id } = t.dataset;
  if (act === 'open') { selectStop(id, { fly: ui.sel !== id }); }
  else if (act === 'done') { e.stopPropagation(); toggleStatus(id, 'done'); }
  else if (act === 'skip') { toggleStatus(id, 'skip'); }
  else if (act === 'day') { setDay(id, { sheet: 'half' }); }
  else if (act === 'note-del') { if (confirm('Delete this note?')) sync.deleteNote(id); }
  else if (act === 'add') { ensureWho(() => openAdd({ day: id, after: lastStopId(id) })); }
  else if (act === 'add-after') { const hit = STOP_BY_ID.get(id); ensureWho(() => openAdd({ day: hit.day.id, after: id })); }
  else if (act === 'remove-added') {
    const hit = STOP_BY_ID.get(id);
    if (hit && confirm(`Remove “${hit.stop.name}” from the plan for everyone?`)) { sync.deleteStop(id); ui.sel = null; toast('Stop removed.'); }
  }
});
$('#sheetBody').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.stop-main')) { e.preventDefault(); e.target.click(); }
});
$('#sheetBody').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target.closest('.note-form');
  const ta = form.querySelector('textarea');
  const text = ta.value.trim();
  if (!text) return;
  ensureWho(() => { sync.addNote(form.dataset.id, text, ui.who); ta.value = ''; });
});
$('#dayTabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-day]');
  if (t) setDay(t.dataset.day, { sheet: ui.sheet === 'full' ? 'half' : null });
});

// ---------- Bottom sheet ----------
const sheetEl = $('#sheet');
function sheetMetrics() {
  const h = sheetEl.offsetHeight;
  const vh = $('#app').offsetHeight;
  const peekVisible = 22 + $('#sheetHead').offsetHeight + 6;
  return { h, positions: { full: 0, half: Math.max(0, h - Math.round(vh * 0.46)), peek: Math.max(0, h - peekVisible) } };
}
function layoutSheet(refit = true) {
  const top = $('.top');
  const pt = parseFloat(getComputedStyle(top).paddingTop) || 0;
  document.documentElement.style.setProperty('--top-h', (top.offsetHeight - pt) + 'px');
  if (isWide()) {
    document.documentElement.style.setProperty('--sheet-visible', '0px');
    sheetEl.style.setProperty('--sheet-y', '0px');
    tripMap && tripMap.setPadding({ top: 40, bottom: 40, left: 40, right: 60 });
    return;
  }
  const { h, positions } = sheetMetrics();
  const y = positions[ui.sheet];
  sheetEl.style.setProperty('--sheet-y', y + 'px');
  const visible = Math.min(h - y, $('#app').offsetHeight * 0.6);
  document.documentElement.style.setProperty('--sheet-visible', visible + 'px');
  const notice = $('#mapNotice');
  const noticeH = notice.hidden ? 0 : notice.offsetHeight + 8;
  tripMap && tripMap.setPadding({ top: top.offsetHeight + noticeH + 24, bottom: visible + 24, left: 36, right: 60 });
  if (refit && tripMap && ui.mapReady && ui.sheet !== 'full') tripMap.fit();
}
function setSheet(pos, refit = true) { ui.sheet = pos; layoutSheet(refit); }

(function dragSheet() {
  let start = null;
  const handles = [$('#sheetGrip'), $('#sheetHead')];
  const onDown = (e) => {
    if (isWide()) return;
    const { positions } = sheetMetrics();
    start = { y: e.clientY, base: positions[ui.sheet], t: performance.now(), moved: false, positions };
    sheetEl.classList.add('dragging');
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!start) return;
    const dy = e.clientY - start.y;
    if (Math.abs(dy) > 5) start.moved = true;
    const y = Math.min(start.positions.peek, Math.max(0, start.base + dy));
    sheetEl.style.setProperty('--sheet-y', y + 'px');
  };
  const onUp = (e) => {
    if (!start) return;
    sheetEl.classList.remove('dragging');
    const dy = e.clientY - start.y;
    const v = dy / Math.max(1, performance.now() - start.t);
    let pos;
    if (!start.moved) pos = ui.sheet === 'peek' ? 'half' : ui.sheet === 'half' ? 'peek' : 'half';
    else if (v < -0.5) pos = ui.sheet === 'peek' ? 'half' : 'full';
    else if (v > 0.5) pos = ui.sheet === 'full' ? 'half' : 'peek';
    else {
      const y = start.base + dy;
      pos = Object.entries(start.positions).sort((a, b) => Math.abs(a[1] - y) - Math.abs(b[1] - y))[0][0];
    }
    start = null;
    setSheet(pos);
  };
  handles.forEach((h) => {
    h.addEventListener('pointerdown', onDown);
    h.addEventListener('pointermove', onMove);
    h.addEventListener('pointerup', onUp);
    h.addEventListener('pointercancel', onUp);
  });
})();
window.addEventListener('resize', () => { layoutSheet(false); tripMap && tripMap.resize(); });

// ---------- Panels ----------
function openPanel(id) { $('#scrim').hidden = false; $(id).hidden = false; }
function closePanels() { $('#scrim').hidden = true; $('#menu').hidden = true; $('#who').hidden = true; $('#add').hidden = true; }
$('#scrim').addEventListener('click', () => { if (!$('#who').hidden && !ui.who) return; closePanels(); });

let whoThen = null;
function openWho(then) {
  whoThen = then || null;
  $('#who').innerHTML = `<h2>Who’s using this phone?</h2><p>Your name goes on the stops you tick off and the notes you add.</p>
    <div class="people">${TRIP.people.map((p) => `<button type="button" data-who="${esc(p)}" class="${ui.who === p ? 'on' : ''}">${esc(p)}</button>`).join('')}</div>`;
  openPanel('#who');
}
$('#who').addEventListener('click', (e) => {
  const b = e.target.closest('[data-who]');
  if (!b) return;
  ui.who = b.dataset.who; LS.set('sib.who', ui.who);
  closePanels();
  renderSheet(false);
  const t = whoThen; whoThen = null; t && t();
});

function fmtMB(bytes) { return bytes ? (bytes / 1048576).toFixed(bytes > 10485760 ? 0 : 1) + ' MB' : ''; }
function renderMenu() {
  const s = ui.shared;
  const mapBytes = ui.version?.mapBytes;
  const dl = ui.downloading;
  const mapCard = dl
    ? `<div class="card"><div class="row">${ICONS.download}<div class="grow"><b>Downloading map…</b><p class="small">${fmtMB(dl.got)}${dl.total ? ' of ' + fmtMB(dl.total) : ''}</p></div></div><div class="progress"><b style="width:${dl.total ? (dl.got / dl.total) * 100 : 5}%"></b></div></div>`
    : ui.mapDownloaded
      ? `<div class="card"><div class="row">${ICONS.download}<div class="grow"><b>Saved on this phone</b><p class="small">The street map works with no data.</p></div><button class="btn" data-menu="map-delete">Remove</button></div></div>`
      : `<div class="card"><div class="row">${ICONS.download}<div class="grow"><b>Save the map for offline use</b><p class="small">${mapBytes ? fmtMB(mapBytes) + ' · ' : ''}Do this once, on Wi-Fi.</p></div><button class="btn primary" data-menu="map-download">Download</button></div></div>`;
  $('#menu').innerHTML = `
    <button class="icon-btn close" data-menu="close" aria-label="Close">${ICONS.close}</button>
    <h2>Trip app</h2>
    <h3>You</h3>
    <div class="card row">${ICONS.user}<div class="grow"><b>${esc(ui.who || 'Not set')}</b><p class="small">Shown on your ticks and notes</p></div><button class="btn" data-menu="who">Change</button></div>
    <h3>Offline map</h3>${mapCard}
    <h3>PDF backup</h3>
    <div class="card row">${ICONS.file}<div class="grow"><b>Day-by-day PDF</b><p class="small">A map and stop list for each day. Save it to Files or Books.</p></div><a class="btn" href="${TRIP.pdf}" target="_blank" rel="noopener" download>Open</a></div>
    <h3>Put it on your home screen</h3>
    <div class="card row">${ICONS.phone}<div class="grow"><p class="small" style="margin:0">${isApple ? 'In Safari, tap <b>Share</b> → <b>Add to Home Screen</b>.' : 'In Chrome, tap <b>⋮</b> → <b>Add to Home screen</b> or <b>Install app</b>.'} Open it once with data so it saves itself.</p></div></div>
    <h3>Live transit</h3>
    <div class="card">${transitLinks()}<p class="small">Each stop’s Directions button gives live walking or subway routes (needs data).</p></div>
    <h3>Sync</h3>
    <div class="card row">${ICONS.sync}<div class="grow"><b>${esc($('#syncPill span').textContent)}</b><p class="small">${s.lastServerSync ? 'Last synced ' + fmtWhen(s.lastServerSync) + ' NY time' : 'Ticks and notes save on this phone and sync when there is signal.'}</p></div></div>
    <p class="small" style="margin-top:18px">Built from the “Sib Trip Ideas” doc${ui.version?.build ? ' · version ' + esc(ui.version.build) : ''}. Pins are approximate; flag any that look off.</p>`;
}
$('#menuBtn').innerHTML = ICONS.menu;
$('#menuBtn').addEventListener('click', () => { renderMenu(); openPanel('#menu'); });
$('#syncPill').addEventListener('click', () => { renderMenu(); openPanel('#menu'); });
$('#menu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-menu]');
  if (!b) return;
  const a = b.dataset.menu;
  if (a === 'close') closePanels();
  else if (a === 'who') { closePanels(); openWho(); }
  else if (a === 'map-download') startMapDownload();
  else if (a === 'map-delete') { if (confirm('Remove the offline map from this phone?')) { await deleteMap(); ui.mapDownloaded = false; renderMenu(); location.reload(); } }
});

async function startMapDownload() {
  if (ui.downloading) return;
  ui.downloading = { got: 0, total: ui.version?.mapBytes || 0 };
  renderMenu(); renderNotice();
  try {
    await downloadMap((got, total) => {
      ui.downloading = { got, total: total || ui.version?.mapBytes || 0 };
      if (!$('#menu').hidden) renderMenu();
      renderNotice();
    });
    ui.downloading = null;
    ui.mapDownloaded = true;
    LS.set('sib.mapVersion', ui.version?.mapVersion || '');
    toast('Map saved. It now works without data.');
    tripMap && ui.mapReady && tripMap.useDownloaded();
  } catch (err) {
    ui.downloading = null;
    toast('Map download failed. Try again on Wi-Fi.');
    console.warn(err);
  }
  if (!$('#menu').hidden) renderMenu();
  renderNotice();
}

// ---------- Notices & toast ----------
function renderNotice() {
  const n = $('#mapNotice');
  const dismissed = LS.get('sib.noticeDismissed', false);
  if (ui.downloading) {
    const { got, total } = ui.downloading;
    n.innerHTML = `<span>Saving map… ${total ? Math.round((got / total) * 100) + '%' : fmtMB(got)}</span>`;
    n.hidden = false; return;
  }
  if (ui.mapDownloaded) { n.hidden = true; return; }
  if (!navigator.onLine && !ui.mapDownloaded) {
    n.innerHTML = `<span>You’re offline and the street map isn’t saved on this phone. Stops, ticks and notes still work.</span>`;
    n.hidden = false; return;
  }
  if (dismissed) { n.hidden = true; return; }
  const size = ui.version?.mapBytes ? ` (${fmtMB(ui.version.mapBytes)})` : '';
  n.innerHTML = `<span>Save the map${size} so it works without data. Best on Wi-Fi.</span><button type="button" data-n="dl">Save</button><button type="button" class="x" data-n="x" aria-label="Dismiss">${ICONS.close}</button>`;
  n.hidden = false;
}
$('#mapNotice').addEventListener('click', (e) => {
  const b = e.target.closest('[data-n]');
  if (!b) return;
  if (b.dataset.n === 'dl') startMapDownload();
  else { LS.set('sib.noticeDismissed', true); renderNotice(); }
});
window.addEventListener('online', () => { renderNotice(); renderPill(); });
window.addEventListener('offline', () => { renderNotice(); renderPill(); });

let toastTimer = null;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? `<button type="button">${esc(action.label)}</button>` : '');
  if (action) t.querySelector('button').onclick = action.run;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 12000 : 3500);
}

// ---------- Service worker (offline app + updates) ----------
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('SW failed', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('The trip app was updated.', { label: 'Reload', run: () => location.reload() });
  });
}

// ---------- Add a stop ----------
function lastStopId(dayId) {
  const d = DAYS.find((x) => x.id === dayId);
  const real = d.stops.filter((s) => s.kind !== 'hub');
  const last = real[real.length - 1];
  return last ? last.id : null;
}
const draft = { day: null, after: null, name: '', at: null, q: null, t: '', cost: '', kind: 'sight', note: '', results: [], searching: false, searchMsg: '' };

function openAdd({ day, after }) {
  Object.assign(draft, { day, after, name: '', at: null, q: null, t: '', cost: '', kind: 'sight', note: '', results: [], searching: false, searchMsg: '' });
  renderAdd();
  openPanel('#add');
  setTimeout(() => $('#addSearch')?.focus(), 150);
}

function renderAdd() {
  const d = DAYS.find((x) => x.id === draft.day);
  const options = [`<option value="">Start of the day</option>`]
    .concat(d.stops.map((s) => `<option value="${s.id}" ${draft.after === s.id ? 'selected' : ''}>${esc((s.t ? s.t + ' · ' : '') + (s.added ? '+ ' : (s._n ? s._n + '. ' : '')) + s.name)}</option>`)).join('');
  const results = draft.results.map((r, i) => `<button type="button" class="result" data-pick="${i}"><b>${esc(r.name)}</b><small>${esc(r.sub)}</small></button>`).join('');
  $('#add').innerHTML = `
    <button class="icon-btn close" data-add="close" aria-label="Close">${ICONS.close}</button>
    <h2>Add a stop · ${d.dow} ${d.num}</h2>
    <h3>Where</h3>
    ${draft.at ? `<div class="card picked"><div class="row">${ICONS.pin}<div class="grow"><b>${esc(draft.name || 'Dropped pin')}</b><p class="small">${draft.q ? esc(draft.q) : 'Spot picked on the map'}</p></div><button type="button" class="btn" data-add="clear">Change</button></div></div>` : `
    <form class="search" data-add-form="search">
      <input id="addSearch" type="search" placeholder="Search a place, e.g. Joe's Pizza" value="${esc(draft.searchText || '')}" autocomplete="off" enterkeyhint="search">
      <button class="btn primary" type="submit">Search</button>
    </form>
    ${draft.searching ? '<p class="small">Searching…</p>' : ''}
    ${draft.searchMsg ? `<p class="small">${esc(draft.searchMsg)}</p>` : ''}
    <div class="results">${results}</div>
    <button type="button" class="btn wide" data-add="pick">${ICONS.pin} Pick the spot on the map</button>`}
    <h3>Details</h3>
    <form class="add-form" data-add-form="save">
      <label>Name<input name="name" value="${esc(draft.name)}" required maxlength="80" placeholder="What is it?"></label>
      <label>Comes after<select name="after">${options}</select></label>
      <div class="two">
        <label>Time<input name="t" value="${esc(draft.t)}" maxlength="12" placeholder="e.g. 2:30"></label>
        <label>Cost<input name="cost" value="${esc(draft.cost)}" maxlength="16" placeholder="e.g. ~$10"></label>
      </div>
      <div class="seg" role="radiogroup" aria-label="Type">
        <button type="button" data-kind="sight" class="${draft.kind === 'sight' ? 'on' : ''}">Sight / activity</button>
        <button type="button" data-kind="food" class="${draft.kind === 'food' ? 'on' : ''}">Food / drink</button>
      </div>
      <label>Note<textarea name="note" rows="2" maxlength="300" placeholder="Optional">${esc(draft.note)}</textarea></label>
      <button class="btn primary wide" type="submit" ${draft.at ? '' : 'disabled'}>Add to ${d.dow} ${d.num}</button>
      ${draft.at ? '' : '<p class="small">Search for the place or pick it on the map first.</p>'}
    </form>`;
}

function keepDraftFields() {
  const f = $('#add .add-form');
  if (!f) return;
  draft.name = f.name.value; draft.after = f.after.value || null; draft.t = f.t.value; draft.cost = f.cost.value; draft.note = f.note.value;
}

$('#add').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    keepDraftFields();
    const r = draft.results[Number(pick.dataset.pick)];
    Object.assign(draft, { at: r.at, name: draft.name || r.name, q: r.q, kind: r.food ? 'food' : draft.kind, results: [] });
    renderAdd(); return;
  }
  const kind = e.target.closest('[data-kind]');
  if (kind) { keepDraftFields(); draft.kind = kind.dataset.kind; renderAdd(); return; }
  const b = e.target.closest('[data-add]');
  if (!b) return;
  if (b.dataset.add === 'close') closePanels();
  else if (b.dataset.add === 'clear') { keepDraftFields(); draft.at = null; draft.q = null; renderAdd(); }
  else if (b.dataset.add === 'pick') { keepDraftFields(); startPick(); }
});

$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.dataset.addForm === 'search') {
    keepDraftFields();
    const text = form.querySelector('input').value.trim();
    draft.searchText = text;
    if (!text) return;
    if (!navigator.onLine) { draft.searchMsg = 'Search needs data. Use “Pick the spot on the map” instead.'; renderAdd(); return; }
    draft.searching = true; draft.searchMsg = ''; renderAdd();
    try {
      const d = DAYS.find((x) => x.id === draft.day);
      const anchor = (draft.after && STOP_BY_ID.get(draft.after)?.stop.at) || d.stops.find((s) => s.at)?.at;
      draft.results = await searchPlaces(text, anchor);
      draft.searchMsg = draft.results.length ? '' : 'Nothing found. Try another name, or pick the spot on the map.';
    } catch {
      draft.searchMsg = 'Search didn’t work just now. Try again, or pick the spot on the map.';
    }
    draft.searching = false; renderAdd();
    return;
  }
  keepDraftFields();
  if (!draft.at || !draft.name.trim()) return;
  const id = sync.addStop({
    day: draft.day, after: draft.after || null, name: draft.name.trim(), lng: draft.at[0], lat: draft.at[1],
    q: draft.q || null, t: draft.t.trim(), cost: draft.cost.trim(), kind: draft.kind, note: draft.note.trim(),
  }, ui.who);
  closePanels();
  setDay(draft.day, { stop: id, sheet: 'half' });
  toast(navigator.onLine ? 'Stop added for everyone.' : 'Stop added. It will sync and get its walking route when you have data.');
});

// Pick a spot: move the map under a fixed crosshair, then confirm.
function pickCentre() {
  const top = $('.top').getBoundingClientRect().bottom;
  const sheetTop = isWide() ? window.innerHeight : $('#sheet').getBoundingClientRect().top;
  const mapBox = $('#map').getBoundingClientRect();
  return { x: (isWide() ? mapBox.left + mapBox.width / 2 : window.innerWidth / 2) - mapBox.left, y: (top + sheetTop) / 2 - mapBox.top, top: (top + sheetTop) / 2 };
}
function startPick() {
  if (!tripMap || !ui.mapReady) { toast('The map isn’t ready yet.'); return; }
  closePanels();
  if (!isWide()) setSheet('peek', false);
  const c = pickCentre();
  const cross = $('#crosshair');
  cross.style.top = c.top + 'px';
  cross.style.left = (isWide() ? $('#map').getBoundingClientRect().left + c.x : window.innerWidth / 2) + 'px';
  cross.hidden = false;
  $('#pickBar').hidden = false;
}
function endPick() { $('#crosshair').hidden = true; $('#pickBar').hidden = true; setSheet('half', false); }
$('#pickBar').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pickbar]');
  if (!b) return;
  if (b.dataset.pickbar === 'cancel') { endPick(); openPanel('#add'); return; }
  const c = pickCentre();
  const at = tripMap.pointAt(c.x, c.y);
  endPick();
  Object.assign(draft, { at, q: null });
  renderAdd(); openPanel('#add');
  if (!draft.name && navigator.onLine) {
    const place = await nameForSpot(at);
    if (place && !draft.name && $('#add .add-form')) {
      keepDraftFields();
      if (!draft.name) { draft.name = place.name; draft.q = null; if (place.food) draft.kind = 'food'; renderAdd(); }
    }
  }
});

// ---------- Boot ----------
$('#fitBtn').innerHTML = ICONS.fit;
$('#fitBtn').addEventListener('click', () => tripMap && ui.mapReady && tripMap.fit());

let tripMap = null;
function initialDay() {
  const [hDay, hStop] = location.hash.slice(1).split('/');
  if (hDay && (hDay === 'all' || DAYS.some((d) => d.id === hDay))) return { day: hDay, stop: hStop && STOP_BY_ID.has(hStop) ? hStop : null };
  if (todayDay) return { day: todayDay.id, stop: null };
  return { day: LS.get('sib.day', 'all'), stop: null };
}

(async function boot() {
  await applyGeo(DAYS);
  markOriginalOrder(DAYS);
  applyAdded();
  const start = initialDay();
  ui.dayId = start.day; ui.sel = start.stop;
  renderTabs(); renderPill();
  setSheet(isWide() ? 'half' : 'half', false);
  renderSheet();
  sync.start();
  if (!ui.who) setTimeout(() => openWho(), 400);

  fetch('version.json', { cache: 'no-cache' }).then((r) => r.json()).then((v) => { ui.version = v; renderNotice(); }).catch(() => {});
  ui.mapDownloaded = await isMapDownloaded();
  renderNotice();

  try {
    tripMap = new TripMap('map', {
      days: DAYS, trip: TRIP,
      onStopTap: (dayId, stopId) => selectStop(stopId, { fly: false }),
      onDayTap: (dayId, stopId) => setDay(dayId, { stop: stopId, sheet: 'half' }),
    });
    await tripMap.init();
    ui.mapReady = true;
    layoutSheet(false);
    tripMap.update(ui.shared.status, ui.shared.routes, false);
    tripMap.showDay(ui.dayId);
    if (ui.sel) tripMap.select(ui.sel, true);
  } catch (e) {
    console.error(e);
    const n = $('#mapNotice');
    n.innerHTML = '<span>The map couldn’t load on this device. The stop list still works.</span>';
    n.hidden = false;
  }
})();

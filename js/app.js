import * as maplibregl from '../lib/maplibre-gl.mjs';
import CONFIG from './config.js';

const T = CONFIG.theme;
const V = { ...CONFIG.view };
const $ = (id) => document.getElementById(id);

const state = {
  types: [],            // all parsed types
  byId: new Map(),
  cases: new Map(),     // case ID -> row object
  caseHeaders: [],
  countryBoxes: new Map(), // iso -> { a: [w,s,e,n], b: [w,s,e,n] } (b = longitudes 0..360)
  selected: null,
  onlyStories: false,
};

// ── Helpers ────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const splitList = (s) => String(s ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

function showMessage(text, persist = false) {
  const m = $('message');
  m.textContent = text;
  m.hidden = !text;
  if (text && !persist) setTimeout(() => { if (m.textContent === text) m.hidden = true; }, 4000);
}

// Find the sheet header for each configured column (case-insensitive, prefix match allowed).
function resolveColumns(headers, wanted) {
  const out = {};
  for (const [key, label] of Object.entries(wanted)) {
    const l = label.toLowerCase();
    out[key] = headers.find((h) => h.trim().toLowerCase() === l)
      ?? headers.find((h) => h.trim().toLowerCase().startsWith(l))
      ?? null;
  }
  return out;
}

async function loadCSV(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} loading ${url}`);
  const text = await res.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' });
  return { rows: parsed.data, headers: parsed.meta.fields ?? [] };
}

// ── Data ───────────────────────────────────────────────────
function parseTypes({ rows, headers }) {
  const c = resolveColumns(headers, CONFIG.typeColumns);
  const missing = Object.entries(c).filter(([, v]) => !v).map(([k]) => CONFIG.typeColumns[k]);
  if (missing.length) console.warn('Columns not found in Types sheet:', missing);
  const get = (row, key) => (c[key] ? String(row[c[key]] ?? '').trim() : '');

  const types = [];
  for (const row of rows) {
    const id = get(row, 'id');
    if (!id) continue;
    const lat = parseFloat(get(row, 'lat'));
    const lon = parseFloat(get(row, 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { console.warn(`${id}: no usable coordinates`); continue; }
    types.push({
      id, lat, lon,
      family: get(row, 'family'),
      name: get(row, 'name'),
      translit: get(row, 'translit'),
      native: get(row, 'native'),
      form: get(row, 'form'),
      period: get(row, 'period'),
      core: splitList(get(row, 'core')).map((x) => x.toUpperCase()),
      fringe: splitList(get(row, 'fringe')).map((x) => x.toUpperCase()),
      cases: splitList(get(row, 'cases')),
    });
  }
  return types;
}

function parseCases({ rows, headers }) {
  const c = resolveColumns(headers, CONFIG.caseColumns);
  const map = new Map();
  for (const row of rows) {
    const id = c.id ? String(row[c.id] ?? '').trim() : '';
    if (id) map.set(id, row);
  }
  state.caseCols = c;
  state.caseHeaders = headers;
  return map;
}

function computeCountryBoxes(geojson) {
  for (const f of geojson.features) {
    const a = [Infinity, Infinity, -Infinity, -Infinity];
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (coords) => {
      if (typeof coords[0] === 'number') {
        const [x, y] = coords;
        const xb = x < 0 ? x + 360 : x;
        a[0] = Math.min(a[0], x); a[2] = Math.max(a[2], x);
        b[0] = Math.min(b[0], xb); b[2] = Math.max(b[2], xb);
        a[1] = b[1] = Math.min(a[1], y); a[3] = b[3] = Math.max(a[3], y);
        return;
      }
      coords.forEach(walk);
    };
    walk(f.geometry.coordinates);
    const iso = f.properties.iso;
    const prev = state.countryBoxes.get(iso);
    state.countryBoxes.set(iso, prev ? { a: union(prev.a, a), b: union(prev.b, b) } : { a, b });
  }
}
const union = (p, q) => [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])];

const expandIso = (codes) => codes.flatMap((code) => CONFIG.isoAliases[code] ?? [code]);

// Bounds of a type's countries plus its point, picking whichever side of the antimeridian is tighter.
function boundsFor(type) {
  let a = [type.lon, type.lat, type.lon, type.lat];
  const lonB = type.lon < 0 ? type.lon + 360 : type.lon;
  let b = [lonB, type.lat, lonB, type.lat];
  for (const iso of expandIso([...type.core, ...type.fringe])) {
    const box = state.countryBoxes.get(iso);
    if (!box) continue;
    a = union(a, box.a); b = union(b, box.b);
  }
  const best = (b[2] - b[0]) < (a[2] - a[0]) ? b : a;
  return [[best[0], best[1]], [best[2], best[3]]];
}

function featureCollection() {
  const list = state.onlyStories ? state.types.filter((t) => t.cases.length) : state.types;
  return {
    type: 'FeatureCollection',
    features: list.map((t) => ({
      type: 'Feature',
      properties: { id: t.id },
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
    })),
  };
}

// ── Map ────────────────────────────────────────────────────
function graticule(step = 20) {
  const lines = [];
  for (let lon = -180; lon < 180; lon += step) {
    const coords = [];
    for (let lat = -80; lat <= 80; lat += 2) coords.push([lon, lat]);
    lines.push(coords);
  }
  for (let lat = -80; lat <= 80; lat += step) {
    const coords = [];
    for (let lon = -180; lon <= 180; lon += 2) coords.push([lon, lat]);
    lines.push(coords);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
}

function hatchImage(color, opacity) {
  const size = 8;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = color;
  ctx.globalAlpha = opacity;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = -size; i <= size * 2; i += size) { ctx.moveTo(i, size); ctx.lineTo(i + size, 0); }
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    projection: { type: V.projection },
    sky: T.atmosphere ? { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 5, 0.3, 7, 0] } : undefined,
    sources: {},
    layers: [{ id: 'ocean', type: 'background', paint: { 'background-color': T.ocean } }],
  },
  center: V.center,
  zoom: V.zoom,
  maxZoom: V.maxZoom,
  attributionControl: false,
  renderWorldCopies: false,
});
const mapLoaded = new Promise((resolve) => map.once('load', resolve));
document.body.style.background = T.space;

function addLayers(countries) {
  map.addImage('hatch', hatchImage(T.fringe, T.fringeOpacity));
  map.addSource('graticule', { type: 'geojson', data: graticule() });
  map.addSource('countries', { type: 'geojson', data: countries });
  map.addSource('types', {
    type: 'geojson', data: featureCollection(),
    cluster: true, clusterRadius: V.clusterRadius, clusterMaxZoom: V.clusterMaxZoom,
  });
  const none = ['in', ['get', 'iso'], ['literal', []]];
  map.addLayer({ id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': T.graticule, 'line-width': 0.6 } });
  map.addLayer({ id: 'land', type: 'fill', source: 'countries', paint: { 'fill-color': T.land } });
  map.addLayer({ id: 'fringe', type: 'fill', source: 'countries', filter: none, paint: { 'fill-pattern': 'hatch' } });
  map.addLayer({ id: 'core', type: 'fill', source: 'countries', filter: none, paint: { 'fill-color': T.core, 'fill-opacity': T.coreOpacity } });
  map.addLayer({ id: 'borders', type: 'line', source: 'countries', paint: { 'line-color': T.border, 'line-width': T.borderWidth } });
  map.addLayer({
    id: 'points', type: 'circle', source: 'types', filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': T.point, 'circle-radius': T.pointRadius,
      'circle-stroke-color': T.pointStroke, 'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'selected', type: 'circle', source: 'types', filter: ['==', ['get', 'id'], ''],
    paint: {
      'circle-color': 'rgba(0,0,0,0)', 'circle-radius': T.pointRadius + 5,
      'circle-stroke-color': T.selectedRing, 'circle-stroke-width': 1.5,
    },
  });
}

// Clusters are drawn as HTML elements so they can be styled in CSS (.cluster).
const clusterMarkers = new Map();
let clustersOnScreen = new Map();
function updateClusters() {
  const next = new Map();
  for (const f of map.querySourceFeatures('types')) {
    const p = f.properties;
    if (!p.cluster) continue;
    const key = p.cluster_id;
    if (next.has(key)) continue;
    let marker = clusterMarkers.get(key);
    if (!marker) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'cluster';
      el.textContent = p.point_count;
      el.style.setProperty('--size', `${Math.round(24 + Math.sqrt(p.point_count) * 5)}px`);
      el.setAttribute('aria-label', `${p.point_count} types, zoom in`);
      const coords = f.geometry.coordinates;
      el.addEventListener('click', (e) => { e.stopPropagation(); openCluster(key, coords); });
      marker = new maplibregl.Marker({ element: el, opacityWhenCovered: 0 }).setLngLat(coords);
      clusterMarkers.set(key, marker);
    }
    next.set(key, marker);
    if (!clustersOnScreen.has(key)) marker.addTo(map);
  }
  for (const [key, marker] of clustersOnScreen) if (!next.has(key)) marker.remove();
  clustersOnScreen = next;
}
function resetClusters() {
  for (const m of clustersOnScreen.values()) m.remove();
  clustersOnScreen = new Map();
  clusterMarkers.clear();
}

async function openCluster(clusterId, coords) {
  const source = map.getSource('types');
  const zoom = await source.getClusterExpansionZoom(clusterId);
  if (zoom > V.clusterMaxZoom || zoom > V.maxZoom) {
    // Points that sit on (almost) the same spot never separate: list them instead.
    const leaves = await source.getClusterLeaves(clusterId, 500, 0);
    showList(leaves.map((l) => state.byId.get(l.properties.id)).filter(Boolean));
  } else {
    map.easeTo({ center: coords, zoom: zoom + 0.2, duration: 700 });
  }
}

// ── Selection and panels ───────────────────────────────────
function select(id, { fly = true } = {}) {
  const type = state.byId.get(id);
  if (!type) return;
  state.selected = id;
  map.setFilter('core', ['in', ['get', 'iso'], ['literal', expandIso(type.core)]]);
  map.setFilter('fringe', ['in', ['get', 'iso'], ['literal', expandIso(type.fringe)]]);
  map.setFilter('selected', ['==', ['get', 'id'], id]);
  renderType(type);
  closeStory();
  history.replaceState(null, '', `#${id}`);

  if (fly && V.onClick === 'fit') {
    const panel = $('panel').getBoundingClientRect();
    const narrow = window.innerWidth < 760;
    map.fitBounds(boundsFor(type), {
      padding: narrow
        ? { top: 40, bottom: window.innerHeight * 0.62 + 20, left: 40, right: 40 }
        : { top: 60, bottom: 60, left: 280, right: panel.width + 60 },
      maxZoom: 6, duration: 1200,
    });
  }
}

function clearSelection() {
  state.selected = null;
  const none = ['in', ['get', 'iso'], ['literal', []]];
  map.setFilter('core', none);
  map.setFilter('fringe', none);
  map.setFilter('selected', ['==', ['get', 'id'], '']);
  $('panel').hidden = true;
  closeStory();
  history.replaceState(null, '', location.pathname + location.search);
}

function renderType(t) {
  const caseItems = t.cases.map((cid) => {
    const row = state.cases.get(cid);
    const title = row && state.caseCols.title ? row[state.caseCols.title] : '';
    return row
      ? `<li><button type="button" data-case="${esc(cid)}">${esc(title || cid)}</button></li>`
      : `<li class="missing">${esc(cid)} — not found in Cases</li>`;
  }).join('');

  const showNative = t.native && t.native !== t.translit;
  $('panel-body').innerHTML = `
    <figure class="type-image" id="type-image"></figure>
    ${t.family ? `<p class="family">${esc(t.family)}</p>` : ''}
    <h1 class="translit">${esc(t.translit || t.name)}</h1>
    ${showNative ? `<p class="native">${esc(t.native)}</p>` : ''}
    ${t.translit ? `<p class="type-name">${esc(t.name)}</p>` : ''}
    <dl class="fields">
      ${t.form ? `<dt>Form</dt><dd>${esc(t.form)}</dd>` : ''}
      ${t.period ? `<dt>Period of use</dt><dd>${esc(t.period)}</dd>` : ''}
    </dl>
    ${t.cases.length ? `<section class="stories"><h2>Stories</h2><ul>${caseItems}</ul></section>` : ''}
    <p class="meta">${esc(t.id)} · ${t.lat}, ${t.lon}</p>`;
  $('panel').hidden = false;
  $('panel-body').scrollTop = 0;
  loadImage(t.id, $('type-image'));
}

// Try images/T014.jpg, .jpeg, .png, .webp in turn.
function loadImage(id, figure) {
  const exts = [...CONFIG.images.extensions];
  const tryNext = () => {
    if (state.selected !== id) return;
    const ext = exts.shift();
    if (!ext) {
      if (CONFIG.images.showEmptySlot) { figure.classList.add('empty'); figure.textContent = `no image yet · ${id}`; }
      else figure.remove();
      return;
    }
    const img = new Image();
    img.alt = '';
    img.onload = () => { if (state.selected === id) { figure.replaceChildren(img); } };
    img.onerror = tryNext;
    img.src = `${CONFIG.images.folder}${id}.${ext}`;
  };
  tryNext();
}

function showList(types) {
  state.selected = null;
  $('panel-body').innerHTML = `
    <p class="list-title">${types.length} types in this spot</p>
    <ul class="type-list">${types.map((t) => `<li><button type="button" data-type="${esc(t.id)}">${esc(t.translit || t.name)}<small>${esc(t.id)} · ${esc(t.family)}</small></button></li>`).join('')}</ul>`;
  $('panel').hidden = false;
}

function openStory(cid) {
  const row = state.cases.get(cid);
  if (!row) return;
  const cols = state.caseCols;
  const hidden = new Set(CONFIG.caseHiddenColumns.map((h) => h.toLowerCase()));
  const story = cols.story ? String(row[cols.story] ?? '').trim() : '';
  const fields = state.caseHeaders
    .filter((h) => !hidden.has(h.trim().toLowerCase()) && String(row[h] ?? '').trim())
    .map((h) => `<dt>${esc(h)}</dt><dd>${esc(row[h])}</dd>`).join('');
  $('story-body').innerHTML = `
    <h1 class="story-title">${esc((cols.title && row[cols.title]) || cid)}</h1>
    ${story ? `<div class="story-text">${esc(story)}</div>` : ''}
    ${fields ? `<dl class="fields">${fields}</dl>` : ''}
    ${!story && !fields ? '<p class="meta">No story text yet.</p>' : ''}
    <p class="meta">${esc(cid)}</p>`;
  $('story').hidden = false;
  $('story-body').scrollTop = 0;
}
function closeStory() { $('story').hidden = true; }

// ── Controls ───────────────────────────────────────────────
function syncControls() {
  document.querySelectorAll('[data-projection]').forEach((b) => b.classList.toggle('active', b.dataset.projection === V.projection));
  document.querySelectorAll('[data-onclick]').forEach((b) => b.classList.toggle('active', b.dataset.onclick === V.onClick));
}
function updateCount() {
  const shown = featureCollection().features.length;
  const withStories = state.types.filter((t) => t.cases.length).length;
  $('count').textContent = state.onlyStories
    ? `${shown} of ${state.types.length} types`
    : `${state.types.length} types · ${withStories} with stories`;
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.projection) { V.projection = t.dataset.projection; map.setProjection({ type: V.projection }); syncControls(); }
  if (t.dataset.onclick) { V.onClick = t.dataset.onclick; syncControls(); }
  if (t.dataset.case) openStory(t.dataset.case);
  if (t.dataset.type) select(t.dataset.type);
  if (t.dataset.close === 'panel') clearSelection();
  if (t.dataset.close === 'story') closeStory();
});
$('filter-stories').addEventListener('change', (e) => {
  state.onlyStories = e.target.checked;
  resetClusters();
  map.getSource('types').setData(featureCollection());
  updateCount();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('story').hidden) closeStory(); else clearSelection();
});

// ── Start ──────────────────────────────────────────────────
async function start() {
  syncControls();
  showMessage('Loading data…', true);
  let typesCSV, casesCSV, countries;
  try {
    [typesCSV, casesCSV, countries] = await Promise.all([
      loadCSV(CONFIG.data.types),
      loadCSV(CONFIG.data.cases).catch((err) => { console.warn('Cases not loaded:', err); return { rows: [], headers: [] }; }),
      fetch(CONFIG.data.countries).then((r) => r.json()),
    ]);
  } catch (err) {
    console.error(err);
    showMessage('Could not load the data. Check the CSV links in js/config.js.', true);
    return;
  }
  state.types = parseTypes(typesCSV);
  state.byId = new Map(state.types.map((t) => [t.id, t]));
  state.cases = parseCases(casesCSV);
  computeCountryBoxes(countries);
  showMessage('');
  updateCount();

  await mapLoaded;
  {
    addLayers(countries);
    map.on('render', () => { if (map.getSource('types') && map.isSourceLoaded('types')) updateClusters(); });
    map.on('click', 'points', (e) => select(e.features[0].properties.id));
    map.on('mouseenter', 'points', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'points', () => { map.getCanvas().style.cursor = ''; });
    map.on('click', (e) => {
      if (!map.queryRenderedFeatures(e.point, { layers: ['points'] }).length && state.selected) clearSelection();
    });
    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (fromHash && state.byId.has(fromHash)) select(fromHash);
  }
}
start();

window.atlas = { map, state, select };

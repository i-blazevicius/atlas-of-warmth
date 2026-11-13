import * as maplibregl from '../lib/maplibre-gl.mjs';
// config.js is loaded with the same cache-busting query as this file.
const CONFIG = (await import(`./config.js${new URL(import.meta.url).search}`)).default;

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
  onlyImages: false,
  images: null,         // Set of type IDs that have an image (from the repository's images folder)
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
      // core/fringe hold both country codes (RUS) and region codes (US-CA); regions contain a hyphen.
      cases: [...new Set(get(row, 'cases').match(new RegExp(CONFIG.caseIdPattern, 'g')) ?? [])],
      inferGaps: get(row, 'inferGaps').toLowerCase() !== 'no',
      names: [],          // local names from the Names tab, filled in by parseNames
    });
  }
  return types;
}

// Names tab: local names per type and place.
function parseNames({ rows, headers }) {
  const c = resolveColumns(headers, CONFIG.nameColumns);
  const get = (row, key) => (c[key] ? String(row[c[key]] ?? '').trim() : '');
  for (const row of rows) {
    const t = state.byId.get(get(row, 'type'));
    const name = get(row, 'name');
    if (!t || !name) continue;
    t.names.push({
      name,
      native: get(row, 'native'),
      language: get(row, 'language'),
      where: splitList(get(row, 'where')).map((x) => x.toUpperCase()),
      lat: parseFloat(get(row, 'lat')),
      lon: parseFloat(get(row, 'lon')),
      note: get(row, 'note'),
    });
  }
}

// Point-in-polygon against the country shapes, for placing name dots.
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInCountry(lon, lat, iso) {
  for (const geom of state.countryShapes.get(iso) ?? []) {
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
    for (const poly of polys) {
      if (pointInRing(lon, lat, poly[0]) && !poly.slice(1).some((hole) => pointInRing(lon, lat, hole))) return true;
    }
  }
  return false;
}
// Where a name's dot goes: its own coordinates; else the type's centre if that lies in the name's
// first area (its country); else a point inside that area.
function nameDot(t, n) {
  if (Number.isFinite(n.lat) && Number.isFinite(n.lon)) return [n.lon, n.lat];
  const code = n.where[0];
  if (!code) return [t.lon, t.lat];
  const iso = isRegion(code) ? regionCountry(code) : (CONFIG.isoAliases[code]?.[0] ?? code);
  if (iso && pointInCountry(t.lon, t.lat, iso) && (!isRegion(code) || n.where.length === 1 && t.names.length === 1)) return [t.lon, t.lat];
  const label = state.labels?.[isRegion(code) ? code : iso];
  return label ?? [t.lon, t.lat];
}
// Does a name belong to a country (directly, or through one of its regions)?
const nameIn = (n, iso) => n.where.some((c) => (isRegion(c) ? regionCountry(c) === iso : expandIso([c]).includes(iso)));
// Name to show for a type in a given country (or null for the type's own name).
const nameIndexFor = (t, iso) => t.names.findIndex((n) => nameIn(n, iso));
function displayName(t, i) {
  const n = t.names[i];
  return n ? { name: n.name, native: n.native, language: n.language }
    : { name: t.translit || t.name, native: t.native, language: '' };
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

// Unlisted neighbours whose land border is mostly shared with the listed countries.
function inferredGaps(listed) {
  if (!CONFIG.inferGaps?.on || !state.borders) return [];
  const set = new Set(listed);
  const out = [];
  for (const [iso, neighbours] of Object.entries(state.borders)) {
    if (set.has(iso)) continue;
    let total = 0, shared = 0, dirs = 0;
    for (const [n, [len, bits]] of Object.entries(neighbours)) {
      total += len;
      if (set.has(n)) { shared += len; dirs |= bits; }
    }
    if (!total || shared / total < CONFIG.inferGaps.share) continue;
    // dirs: 36 bits, one per 10° of direction from the country's centre where a listed border lies.
    let run = 0, widest = 0;
    for (let i = 0; i < 72; i++) { if (dirs & (1 << (i % 36))) run = 0; else widest = Math.max(widest, ++run); }
    if (Math.min(widest, 36) * 10 <= CONFIG.inferGaps.maxGap) out.push(iso);
  }
  return out;
}

const isRegion = (code) => code.includes('-');
const countriesOf = (codes) => codes.filter((c) => !isRegion(c));
const regionsOf = (codes) => codes.filter(isRegion);
const expandIso = (codes) => countriesOf(codes).flatMap((code) => CONFIG.isoAliases[code] ?? [code]);
// Country (ISO3) that a region code belongs to, e.g. US-CA -> USA.
const regionCountry = (code) => state.regionIndex?.prefixes[code.split('-')[0]] ?? null;

// Region shapes are stored per country and loaded the first time they are needed.
const regionFiles = new Map();
function loadRegionFile(iso3) {
  if (!regionFiles.has(iso3)) {
    regionFiles.set(iso3, fetch(`${CONFIG.data.regions}${iso3}.geojson`)
      .then((r) => (r.ok ? r.json() : { features: [] }))
      .catch(() => ({ features: [] })));
  }
  return regionFiles.get(iso3);
}
async function regionFeatures(codes, role) {
  const wanted = new Set(codes);
  const files = await Promise.all([...new Set(codes.map(regionCountry).filter(Boolean))].map(loadRegionFile));
  const found = files.flatMap((fc) => fc.features.filter((f) => wanted.has(f.properties.code)));
  const missing = codes.filter((c) => !found.some((f) => f.properties.code === c));
  if (missing.length) console.warn('Region codes not found:', missing.join(', '));
  return found.map((f) => ({ ...f, properties: { ...f.properties, role } }));
}
function featureBox(f) {
  const a = [Infinity, Infinity, -Infinity, -Infinity], b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      const xb = c[0] < 0 ? c[0] + 360 : c[0];
      a[0] = Math.min(a[0], c[0]); a[2] = Math.max(a[2], c[0]);
      b[0] = Math.min(b[0], xb); b[2] = Math.max(b[2], xb);
      a[1] = b[1] = Math.min(a[1], c[1]); a[3] = b[3] = Math.max(a[3], c[1]);
      return;
    }
    c.forEach(walk);
  };
  walk(f.geometry.coordinates);
  return { a, b };
}

// Bounds of a type's countries plus its point, picking whichever side of the antimeridian is tighter.
function boundsFor(type, regions = []) {
  let a = [type.lon, type.lat, type.lon, type.lat];
  const lonB = type.lon < 0 ? type.lon + 360 : type.lon;
  let b = [lonB, type.lat, lonB, type.lat];
  const boxes = [...expandIso([...type.core, ...type.fringe]).map((iso) => state.countryBoxes.get(iso)), ...regions.map(featureBox)];
  for (const box of boxes) {
    if (!box) continue;
    a = union(a, box.a); b = union(b, box.b);
  }
  const best = (b[2] - b[0]) < (a[2] - a[0]) ? b : a;
  return [[best[0], best[1]], [best[2], best[3]]];
}

function visibleTypes() {
  return state.types.filter((t) =>
    (!state.onlyStories || t.cases.length) && (!state.onlyImages || state.images?.has(t.id)));
}

function dotFeatures(t) {
  // One dot per local name (types without names keep their single centre dot).
  const dots = t.names.length ? t.names.map((n, i) => [i, nameDot(t, n)]) : [[-1, [t.lon, t.lat]]];
  return dots.map(([n, coords]) => ({ type: 'Feature', properties: { id: t.id, n }, geometry: { type: 'Point', coordinates: coords } }));
}
// The open type's dots are kept out of the clusters (drawn from their own source) so they stay visible.
function selectedCollection() {
  const t = state.byId.get(state.selected);
  return { type: 'FeatureCollection', features: t ? spreadDots(dotFeatures(t)) : [] };
}

function featureCollection() {
  const features = [];
  for (const t of visibleTypes()) {
    if (t.id === state.selected) continue;
    features.push(...dotFeatures(t));
  }
  return { type: 'FeatureCollection', features: spreadDots(features) };
}

function spreadDots(features) {
  // Dots placed on exactly the same spot (e.g. several names in one country) are fanned out
  // in a small ring, so they separate when zoomed in.
  const groups = new Map();
  for (const f of features) {
    const key = f.geometry.coordinates.map((v) => v.toFixed(3)).join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [lon, lat] = group[0].geometry.coordinates;
    const r = 0.25 + 0.04 * group.length; // degrees
    group.forEach((f, i) => {
      const a = (2 * Math.PI * i) / group.length;
      f.geometry.coordinates = [lon + (r * Math.cos(a)) / Math.cos((lat * Math.PI) / 180), lat + r * Math.sin(a)];
    });
  }
  return features;
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
});
// Flat map limits: no zooming out past one world width, and no scrolling past the latitudes in
// view.flatLatitudes (hides Antarctica). Sideways scrolling stays free.
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
const mercLat = (f) => (360 / Math.PI) * Math.atan(Math.exp(Math.PI * (1 - 2 * f))) - 90;
function flatConstrain(lngLat, zoom) {
  const [south, north] = V.flatLatitudes;
  const top = mercY(north), bottom = mercY(south);
  const { clientWidth: w, clientHeight: h } = map.getCanvas();
  const minZoom = Math.max(Math.log2(w / 512), Math.log2(h / (512 * (bottom - top))));
  const z = Math.min(Math.max(zoom, minZoom), V.maxZoom);
  const size = 512 * 2 ** z;
  const y = Math.min(Math.max(mercY(lngLat.lat) * size, top * size + h / 2), bottom * size - h / 2);
  return { center: new maplibregl.LngLat(lngLat.lng, mercLat(y / size)), zoom: z };
}

function applyProjection() {
  map.setProjection({ type: V.projection });
  // No tilting or turning on either view (right-drag, two-finger twist or tilt).
  map.setTransformConstrain(V.projection === 'mercator' ? flatConstrain : null);
  map.jumpTo({ center: map.getCenter(), zoom: map.getZoom() }); // re-apply limits now
}

map.dragRotate.disable();
map.touchZoomRotate.disableRotation();
map.touchPitch.disable();
map.keyboard.disableRotation();

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
  // Climate underlays: Web Mercator images covering the whole world, hidden until chosen.
  for (const name of Object.keys(CONFIG.climate.layers)) {
    map.addSource(`climate-${name}`, {
      type: 'image', url: `${CONFIG.climate.folder}${name}.webp`,
      coordinates: [[-180, 85.0511], [180, 85.0511], [180, -85.0511], [-180, -85.0511]],
    });
    map.addLayer({
      id: `climate-${name}`, type: 'raster', source: `climate-${name}`,
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': CONFIG.climate.opacity, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
    });
  }
  // Sea drawn over the climate images, so coastlines stay crisp (Natural Earth 1:50m ocean).
  map.addSource('ocean', { type: 'geojson', data: CONFIG.data.ocean });
  map.addLayer({ id: 'ocean-mask', type: 'fill', source: 'ocean', layout: { visibility: 'none' }, paint: { 'fill-color': T.ocean } });
  map.addLayer({ id: 'fringe', type: 'fill', source: 'countries', filter: none, paint: { 'fill-pattern': 'hatch' } });
  map.addLayer({ id: 'core', type: 'fill', source: 'countries', filter: none, paint: { 'fill-color': T.core, 'fill-opacity': T.coreOpacity } });
  map.addSource('regions', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'region-fringe', type: 'fill', source: 'regions', filter: ['==', ['get', 'role'], 'fringe'], paint: { 'fill-pattern': 'hatch' } });
  map.addLayer({ id: 'region-core', type: 'fill', source: 'regions', filter: ['==', ['get', 'role'], 'core'], paint: { 'fill-color': T.core, 'fill-opacity': T.coreOpacity } });
  // Outlines of the selected type's area, so it stays readable over a climate underlay.
  map.addLayer({ id: 'core-line', type: 'line', source: 'countries', filter: none, paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline } });
  map.addLayer({ id: 'fringe-line', type: 'line', source: 'countries', filter: none, paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline * 0.6, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'region-core-line', type: 'line', source: 'regions', filter: ['==', ['get', 'role'], 'core'], paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline } });
  map.addLayer({ id: 'region-fringe-line', type: 'line', source: 'regions', filter: ['==', ['get', 'role'], 'fringe'], paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline * 0.6, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'borders', type: 'line', source: 'countries', paint: { 'line-color': T.border, 'line-width': T.borderWidth } });
  map.addLayer({ id: 'country-selected', type: 'line', source: 'countries', filter: none, paint: { 'line-color': T.countryOutline, 'line-width': T.countryOutlineWidth } });
  map.addLayer({
    id: 'points', type: 'circle', source: 'types', filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': T.point, 'circle-radius': T.pointRadius,
      'circle-stroke-color': T.pointStroke, 'circle-stroke-width': 1.5,
    },
  });
  // Invisible, larger circle so the dots are easier to click
  map.addLayer({
    id: 'points-hit', type: 'circle', source: 'types', filter: ['!', ['has', 'point_count']],
    paint: { 'circle-radius': T.pointRadius + 6, 'circle-color': '#000', 'circle-opacity': 0 },
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
    showList(leaves.map((l) => [state.byId.get(l.properties.id), l.properties.n]).filter(([t]) => t));
  } else {
    map.easeTo({ center: coords, zoom: zoom + 0.2, duration: 700 });
  }
}

// ── Selection and panels ───────────────────────────────────
function setArea(core, fringe) {
  const f = (list) => ['in', ['get', 'iso'], ['literal', list]];
  map.setFilter('core', f(core)); map.setFilter('core-line', f(core));
  map.setFilter('fringe', f(fringe)); map.setFilter('fringe-line', f(fringe));
}

// Countries shaded as "less prevalent / likely" because they sit inside the type's area.
// Countries listed only by region count as neighbours, but are never filled in whole.
function gapsFor(type) {
  if (!type.inferGaps) return [];
  if (type._gaps) return type._gaps;
  const all = [...type.core, ...type.fringe];
  const partial = [...new Set(regionsOf(all).map(regionCountry).filter(Boolean))];
  type._gaps = inferredGaps([...expandIso(all), ...partial]).filter((iso) => !partial.includes(iso));
  return type._gaps;
}

// Mark which of the selected type's dots is the active one.
// The open type's dots are drawn as HTML elements (like the clusters) so they sit on top of them.
// Styled in CSS: .dot-selected, and .dot-selected.active for the one whose name is shown.
let selectedMarkers = [];
function markDots(id, n) {
  for (const m of selectedMarkers) m.getElement().classList.toggle('active', Number(m.getElement().dataset.n) === n);
}
// Rebuild the clustered dots and the open type's dots (after the open type changes).
function refreshDots() {
  resetClusters();
  map.getSource('types').setData(featureCollection());
  for (const m of selectedMarkers) m.remove();
  selectedMarkers = selectedCollection().features.map((f) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'dot-selected';
    el.dataset.n = f.properties.n;
    const t = state.byId.get(f.properties.id);
    el.title = displayName(t, f.properties.n).name;
    el.addEventListener('click', (e) => { e.stopPropagation(); select(f.properties.id, { name: f.properties.n }); });
    return new maplibregl.Marker({ element: el, opacityWhenCovered: 0 }).setLngLat(f.geometry.coordinates).addTo(map);
  });
}

// Switch the open type's card and active dot to another of its names, and fit that name's area.
async function switchName(i, { fly = true } = {}) {
  const type = state.byId.get(state.selected);
  if (!type || !type.names[i]) return;
  state.nameIndex = i;
  markDots(type.id, i);
  const scroll = $('panel-body').scrollTop;
  renderType(type, i);
  $('panel-body').scrollTop = scroll;
  if (!fly || V.onClick !== 'fit') return;
  const n = type.names[i];
  const id = type.id;
  const regions = await regionFeatures(regionsOf(n.where), 'name');
  if (state.selected !== id || state.nameIndex !== i) return;
  const [lon, lat] = nameDot(type, n);
  fitIfNeeded(boundsFor({ lon, lat, core: countriesOf(n.where), fringe: [] }, regions));
}

async function select(id, { fly = true, name = null } = {}) {
  const type = state.byId.get(id);
  if (!type) return;
  // Clicking another dot (or name) of the type that is already open just switches names.
  if (state.selected === id && name !== null && name >= 0 && !$('panel').hidden) { switchName(name, { fly }); return; }
  state.selected = id;
  state.nameIndex = name ?? (type.names.length ? 0 : -1);
  state.country = null;
  map.setFilter('country-selected', ['in', ['get', 'iso'], ['literal', []]]);
  setArea(expandIso(type.core), [...expandIso(type.fringe), ...gapsFor(type)]);
  refreshDots();
  markDots(id, state.nameIndex);
  map.getSource('regions').setData({ type: 'FeatureCollection', features: [] });
  renderType(type, state.nameIndex);
  closeStory();
  history.replaceState(null, '', `#${id}`);

  const regions = [
    ...(await regionFeatures(regionsOf(type.core), 'core')),
    ...(await regionFeatures(regionsOf(type.fringe), 'fringe')),
  ];
  if (state.selected !== id) return; // another type was clicked meanwhile
  map.getSource('regions').setData({ type: 'FeatureCollection', features: regions });
  if (fly && V.onClick === 'fit') fitIfNeeded(boundsFor(type, regions));
}

// Zoom out to show the whole extent if it doesn't fit; never zoom in.
// If it fits at the current zoom but is partly off-screen, pan to it.
function fitIfNeeded(bounds) {
  const panel = $('panel').getBoundingClientRect();
  const narrow = window.innerWidth < 760;
  const padding = narrow
    ? { top: 40, bottom: window.innerHeight * 0.62 + 20, left: 40, right: 40 }
    : { top: 60, bottom: 60, left: 280, right: panel.width + 60 };
  // On the flat map, use the copy of the world nearest to the current view.
  if (V.projection === 'mercator') {
    const mid = (bounds[0][0] + bounds[1][0]) / 2;
    const shift = Math.round((map.getCenter().lng - mid) / 360) * 360;
    bounds = [[bounds[0][0] + shift, bounds[0][1]], [bounds[1][0] + shift, bounds[1][1]]];
  }
  const cam = map.cameraForBounds(bounds, { padding });
  if (!cam) return;
  if (cam.zoom < map.getZoom()) {
    map.easeTo({ ...cam, duration: 1200 });
    return;
  }
  // Does the extent already sit inside the padded screen area?
  const w = map.getCanvas().clientWidth, h = map.getCanvas().clientHeight;
  const corners = [[bounds[0][0], bounds[0][1]], [bounds[1][0], bounds[1][1]], [bounds[0][0], bounds[1][1]], [bounds[1][0], bounds[0][1]]];
  const inside = corners.every((c) => {
    const p = map.project(c);
    return p.x >= padding.left && p.x <= w - padding.right && p.y >= padding.top && p.y <= h - padding.bottom;
  });
  if (!inside) map.easeTo({ center: cam.center, duration: 1000 });
}

function clearSelection() {
  state.selected = null;
  state.country = null;
  const none = ['in', ['get', 'iso'], ['literal', []]];
  setArea([], []);
  map.setFilter('country-selected', none);
  map.getSource('regions').setData({ type: 'FeatureCollection', features: [] });
  if (map.getSource('types')) refreshDots();
  $('panel').hidden = true;
  closeStory();
  history.replaceState(null, '', location.pathname + location.search);
}

function renderType(t, nameIndex = -1) {
  const caseItems = t.cases.map((cid) => {
    const row = state.cases.get(cid);
    const title = row && state.caseCols.title ? row[state.caseCols.title] : '';
    return row
      ? `<li><button type="button" data-case="${esc(cid)}">${esc(title || cid)}</button></li>`
      : `<li class="missing">${esc(cid)} — not found in Cases</li>`;
  }).join('');

  const shown = displayName(t, nameIndex);
  const showNative = shown.native && shown.native !== shown.name;
  // All local names, each switching the heading; the current one is marked.
  const others = t.names.length > 1 || (t.names.length === 1 && t.names[0].name !== (t.translit || t.name))
    ? `<p class="also-known">${t.names.map((n, i) => `<button type="button" data-name="${i}" class="${i === nameIndex ? 'current' : ''}" title="${esc(n.language)}${n.note ? ' · ' + esc(n.note) : ''}">${esc(n.name)}<span>${esc(n.where.slice(0, 2).join(' '))}${n.where.length > 2 ? '…' : ''}</span></button>`).join('')}</p>`
    : '';
  $('panel-body').innerHTML = `
    <figure class="type-image" id="type-image"></figure>
    ${t.family ? `<p class="family">${esc(t.family)}</p>` : ''}
    <h1 class="translit">${esc(shown.name)}</h1>
    ${showNative ? `<p class="native">${esc(shown.native)}</p>` : ''}
    ${shown.language ? `<p class="language">${esc(shown.language)}</p>` : ''}
    ${others}
    <p class="type-name">${esc(t.name)}</p>
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
    img.onload = () => {
      if (state.selected !== id) return;
      figure.replaceChildren(img);
      const c = state.credits?.[id];
      if (c) {
        const cap = document.createElement('figcaption');
        const label = c.text ?? [c.author, c.licence].filter(Boolean).join(' · ');
        cap.innerHTML = c.source ? `<a href="${esc(c.source)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label);
        figure.append(cap);
      }
    };
    img.onerror = tryNext;
    img.src = `${CONFIG.images.folder}${id}.${ext}`;
  };
  tryNext();
}

// items: [type, nameIndex] pairs; the local name is shown, with the type's own name small below.
const typeItems = (items) => `<ul class="type-list">${items.map(([t, i]) => {
  const shown = displayName(t, i);
  return `<li><button type="button" data-type="${esc(t.id)}" data-n="${i}">${esc(shown.name)}<small>${esc(t.id)} · ${esc(t.name)}</small></button></li>`;
}).join('')}</ul>`;

function showList(items) {
  if (state.selected) clearSelection();
  $('panel-body').innerHTML = `<p class="list-title">${items.length} types in this spot</p>${typeItems(items)}`;
  $('panel').hidden = false;
}

// Click on a country (or a region inside it): list every type found there.
function showCountry(iso, name) {
  clearSelection();
  state.country = iso;
  map.setFilter('country-selected', ['==', ['get', 'iso'], iso]);
  const inCodes = (codes) => expandIso(codes).includes(iso) || regionsOf(codes).some((c) => regionCountry(c) === iso);
  const wide = [], less = [];
  for (const t of state.types) {
    const item = [t, nameIndexFor(t, iso)];
    if (inCodes(t.core)) wide.push(item);
    else if (inCodes(t.fringe) || gapsFor(t).includes(iso)) less.push(item);
  }
  const section = (title, list) => (list.length ? `<p class="list-title">${title}</p>${typeItems(list)}` : '');
  $('panel-body').innerHTML = `
    <h1 class="story-title">${esc(name)}</h1>
    ${section('Widely used', wide)}
    ${section('Less prevalent / likely', less)}
    ${!wide.length && !less.length ? '<p class="meta">No types recorded here yet.</p>' : ''}`;
  $('panel').hidden = false;
  $('panel-body').scrollTop = 0;
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

// ── Climate underlay ───────────────────────────────────────
const climate = { current: CONFIG.climate.start, opacity: CONFIG.climate.opacity, legend: null };
function applyClimate() {
  for (const name of Object.keys(CONFIG.climate.layers)) {
    if (!map.getLayer(`climate-${name}`)) continue;
    map.setLayoutProperty(`climate-${name}`, 'visibility', name === climate.current ? 'visible' : 'none');
    map.setPaintProperty(`climate-${name}`, 'raster-opacity', climate.opacity);
  }
  if (map.getLayer('ocean-mask')) map.setLayoutProperty('ocean-mask', 'visibility', CONFIG.climate.layers[climate.current] ? 'visible' : 'none');
  document.querySelectorAll('[data-climate]').forEach((b) => b.classList.toggle('active', b.dataset.climate === climate.current));
  const layer = CONFIG.climate.layers[climate.current];
  $('climate-detail').hidden = !layer;
  $('credit').hidden = !layer;
  if (!layer) return;
  $('credit').textContent = CONFIG.climate.credit;
  $('climate-title').textContent = layer.title;
  $('climate-low').textContent = layer.low;
  $('climate-high').textContent = layer.high;
  $('climate-opacity').value = climate.opacity;
  const stops = climate.legend?.[climate.current]?.stops;
  if (stops) $('climate-bar').style.background = `linear-gradient(to right, ${stops.map(([p, c]) => `${c} ${p * 100}%`).join(', ')})`;
}
$('climate-opacity').addEventListener('input', (e) => { climate.opacity = Number(e.target.value); applyClimate(); });

// ── Controls ───────────────────────────────────────────────
function syncControls() {
  document.querySelectorAll('[data-projection]').forEach((b) => b.classList.toggle('active', b.dataset.projection === V.projection));
  document.querySelectorAll('[data-onclick]').forEach((b) => b.classList.toggle('active', b.dataset.onclick === V.onClick));
}
function updateCount() {
  const shown = visibleTypes().length;
  const withStories = state.types.filter((t) => t.cases.length).length;
  const withImages = state.images ? state.types.filter((t) => state.images.has(t.id)).length : null;
  $('count').textContent = state.onlyStories || state.onlyImages
    ? `${shown} of ${state.types.length} types`
    : `${state.types.length} types · ${withStories} with stories${withImages !== null ? ` · ${withImages} with images` : ''}`;
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.projection) { V.projection = t.dataset.projection; applyProjection(); syncControls(); }
  if (t.dataset.onclick) { V.onClick = t.dataset.onclick; syncControls(); }
  if (t.dataset.climate) { climate.current = t.dataset.climate; applyClimate(); }
  if (t.dataset.case) openStory(t.dataset.case);
  if (t.dataset.type) select(t.dataset.type, { name: t.dataset.n !== undefined ? Number(t.dataset.n) : null });
  if (t.dataset.name !== undefined && state.selected) switchName(Number(t.dataset.name));
  if (t.dataset.close === 'panel') clearSelection();
  if (t.dataset.close === 'story') closeStory();
});
function refilter() {
  refreshDots();
  updateCount();
}
$('filter-stories').addEventListener('change', (e) => { state.onlyStories = e.target.checked; refilter(); });
$('filter-images').addEventListener('change', (e) => { state.onlyImages = e.target.checked; refilter(); });

// Which types have an image: list the repository's images folder (GitHub API, no login needed).
async function loadImageList() {
  const { owner, repo, branch } = CONFIG.github;
  const folder = CONFIG.images.folder.replace(/\/$/, '');
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${folder}?ref=${branch}`);
    if (!res.ok) throw new Error(res.status);
    const exts = new Set(CONFIG.images.extensions);
    state.images = new Set((await res.json())
      .map((f) => f.name.match(/^(.+)\.([a-z0-9]+)$/i))
      .filter((m) => m && exts.has(m[2].toLowerCase()))
      .map((m) => m[1]));
  } catch {
    $('filter-images').disabled = true;
    $('filter-images').closest('label').title = 'Could not read the image list';
  }
  updateCount();
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('story').hidden) closeStory(); else clearSelection();
});

// ── Start ──────────────────────────────────────────────────
async function start() {
  syncControls();
  showMessage('Loading data…', true);
  let typesCSV, casesCSV, countries, namesCSV;
  try {
    [typesCSV, casesCSV, countries, namesCSV] = await Promise.all([
      loadCSV(CONFIG.data.types),
      loadCSV(CONFIG.data.cases).catch((err) => { console.warn('Cases not loaded:', err); return { rows: [], headers: [] }; }),
      fetch(CONFIG.data.countries).then((r) => r.json()),
      (CONFIG.data.names ? loadCSV(CONFIG.data.names) : Promise.resolve(null)).catch((err) => { console.warn('Names not loaded:', err); return null; }),
      fetch(CONFIG.data.labels).then((r) => r.json()).then((x) => { state.labels = x; }).catch(() => {}),
      fetch(CONFIG.data.credits, { cache: 'no-store' }).then((r) => r.json()).then((c) => { state.credits = c; }).catch(() => {}),
      fetch(CONFIG.data.borders).then((r) => r.json()).then((b) => { state.borders = b; }).catch(() => {}),
      fetch(`${CONFIG.climate.folder}legend.json`).then((r) => r.json()).then((x) => { climate.legend = x; }).catch(() => {}),
      fetch(`${CONFIG.data.regions}index.json`).then((r) => r.json()).then((x) => { state.regionIndex = x; }).catch(() => {}),
    ]);
  } catch (err) {
    console.error(err);
    showMessage('Could not load the data. Check the CSV links in js/config.js.', true);
    return;
  }
  state.types = parseTypes(typesCSV);
  state.byId = new Map(state.types.map((t) => [t.id, t]));
  state.cases = parseCases(casesCSV);
  state.countryShapes = new Map();
  for (const f of countries.features) {
    if (!state.countryShapes.has(f.properties.iso)) state.countryShapes.set(f.properties.iso, []);
    state.countryShapes.get(f.properties.iso).push(f.geometry);
  }
  if (namesCSV) parseNames(namesCSV);
  computeCountryBoxes(countries);
  showMessage('');
  updateCount();
  loadImageList();

  await mapLoaded;
  applyProjection();
  {
    addLayers(countries);
    applyClimate();
    map.on('render', () => { if (map.getSource('types') && map.isSourceLoaded('types')) updateClusters(); });
    for (const layer of ['points-hit']) {
      map.on('click', layer, (e) => {
        const p = e.features[0].properties;
        select(p.id, { name: Number(p.n) });
      });
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
    map.on('click', (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ['points-hit'] }).length) return;
      const land = map.queryRenderedFeatures(e.point, { layers: ['land'] })[0];
      if (land) showCountry(land.properties.iso, land.properties.name);
      else clearSelection();
    });
    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (fromHash && state.byId.has(fromHash)) select(fromHash);
  }
}
start();

window.atlas = { map, state, select, selectedCollection };

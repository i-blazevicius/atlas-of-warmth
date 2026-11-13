import * as maplibregl from '../lib/maplibre-gl.mjs';
// config.js is loaded with the same cache-busting query as this file.
const CONFIG = (await import(`./config.js${new URL(import.meta.url).search}`)).default;

// Address-bar overrides for the experiments: ?cards=float, ?flat=equalearth (or =mercator / =panel).
{
  const q = new URLSearchParams(location.search);
  if (q.get('cards')) CONFIG.cards = q.get('cards');
  if (q.get('flat')) CONFIG.flatProjection = /equal/i.test(q.get('flat')) ? 'equalEarth' : 'mercator';
}
const FLOAT = CONFIG.cards === 'float';
if (FLOAT) document.body.classList.add('float-cards');

// ── Equal Earth on the flat map (experiment) ───────────────
// MapLibre only draws Web Mercator, so every coordinate is moved to where Equal Earth would put it and
// written back as a "fake" longitude/latitude that Mercator then draws in that spot. Data is kept in real
// coordinates; mapCoords / toMap convert just before handing things to the map.
const EE = { A1: 1.340264, A2: -0.081106, A3: 0.000893, A4: 0.003796, M: Math.sqrt(3) / 2 };
EE.xmax = Math.PI / (EE.M * EE.A1);
const rad = Math.PI / 180;
function eeForward([lon, lat]) {
  const k = Math.round(lon / 360), l = (lon - 360 * k) * rad; // keep whole-world shifts as they are
  const th = Math.asin(EE.M * Math.sin(Math.max(-90, Math.min(90, lat)) * rad)), t2 = th * th, t6 = t2 * t2 * t2;
  const x = (2 * Math.sqrt(3) * l * Math.cos(th)) / (3 * (EE.A1 + 3 * EE.A2 * t2 + t6 * (7 * EE.A3 + 9 * EE.A4 * t2)));
  const y = th * (EE.A1 + EE.A2 * t2 + t6 * (EE.A3 + EE.A4 * t2));
  return [(x / EE.xmax) * 180 + 360 * k, (2 * Math.atan(Math.exp((y * Math.PI) / EE.xmax)) - Math.PI / 2) / rad];
}
function eeInverse([lonF, latF]) {
  const k = Math.round(lonF / 360);
  const x = ((lonF - 360 * k) / 180) * EE.xmax;
  const y = (Math.log(Math.tan(Math.PI / 4 + (latF * rad) / 2)) * EE.xmax) / Math.PI;
  let th = y / EE.A1;
  for (let i = 0; i < 12; i++) {
    const t2 = th * th, t6 = t2 * t2 * t2;
    const f = th * (EE.A1 + EE.A2 * t2 + t6 * (EE.A3 + EE.A4 * t2)) - y;
    th -= f / (EE.A1 + 3 * EE.A2 * t2 + t6 * (7 * EE.A3 + 9 * EE.A4 * t2));
  }
  const t2 = th * th, t6 = t2 * t2 * t2;
  const l = (3 * x * (EE.A1 + 3 * EE.A2 * t2 + t6 * (7 * EE.A3 + 9 * EE.A4 * t2))) / (2 * Math.sqrt(3) * Math.cos(th));
  return [l / rad + 360 * k, Math.asin(Math.max(-1, Math.min(1, Math.sin(th) / EE.M))) / rad];
}
let eeOn = false; // true while the flat map is showing Equal Earth
const mapCoords = (c) => (eeOn ? eeForward(c) : c);
// Convert a GeoJSON object for the map, adding points along long edges (Equal Earth bends meridians).
function toMap(geo, step = 1) {
  if (!eeOn || !geo) return geo;
  const line = (cs) => {
    const out = [];
    cs.forEach((c, i) => {
      if (i) {
        const p = cs[i - 1], n = Math.ceil(Math.max(Math.abs(c[0] - p[0]), Math.abs(c[1] - p[1])) / step);
        for (let j = 1; j < n; j++) out.push(eeForward([p[0] + ((c[0] - p[0]) * j) / n, p[1] + ((c[1] - p[1]) * j) / n]));
      }
      out.push(eeForward(c));
    });
    return out;
  };
  const geom = (g) => {
    if (!g) return g;
    switch (g.type) {
      case 'Point': return { ...g, coordinates: eeForward(g.coordinates) };
      case 'MultiPoint': return { ...g, coordinates: g.coordinates.map(eeForward) };
      case 'LineString': return { ...g, coordinates: line(g.coordinates) };
      case 'MultiLineString': case 'Polygon': return { ...g, coordinates: g.coordinates.map(line) };
      case 'MultiPolygon': return { ...g, coordinates: g.coordinates.map((p) => p.map(line)) };
      case 'GeometryCollection': return { ...g, geometries: g.geometries.map(geom) };
      default: return g;
    }
  };
  if (geo.type === 'FeatureCollection') return { ...geo, features: geo.features.map((f) => ({ ...f, geometry: geom(f.geometry) })) };
  if (geo.type === 'Feature') return { ...geo, geometry: geom(geo.geometry) };
  return geom(geo);
}
// Box [w, s, e, n] in real degrees → the box it covers on the map (sampled, since edges bend).
function boxToMap([w, s, e, n]) {
  if (!eeOn) return [w, s, e, n];
  const pts = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) pts.push(eeForward([w + ((e - w) * i) / 4, s + ((n - s) * j) / 4]));
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

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
// first the name's own coordinates; then the type's centre if it lies in one of the name's countries
// (country codes only); otherwise one dot in the middle of all its areas (if that middle falls inside
// one of them), else inside the area nearest to that middle.
function nameDot(t, n) {
  if (Number.isFinite(n.lat) && Number.isFinite(n.lon)) return [n.lon, n.lat];
  if (!n.where.length) return [t.lon, t.lat];
  const geoIso = (c) => (isRegion(c) ? regionCountry(c) : (CONFIG.isoAliases[c]?.[0] ?? c));
  const countries = n.where.filter((c) => !isRegion(c)).map(geoIso);
  if (countries.some((iso) => pointInCountry(t.lon, t.lat, iso))) return [t.lon, t.lat];
  const labels = n.where.map((c) => state.labels?.[isRegion(c) ? c : geoIso(c)]).filter(Boolean);
  if (!labels.length) return [t.lon, t.lat];
  if (labels.length === 1) return labels[0];
  const mid = [labels.reduce((a, l) => a + l[0], 0) / labels.length, labels.reduce((a, l) => a + l[1], 0) / labels.length];
  const owners = [...new Set(n.where.map(geoIso))];
  if (owners.some((iso) => pointInCountry(mid[0], mid[1], iso))) return mid;
  return labels.reduce((best, l) => (Math.hypot(l[0] - mid[0], l[1] - mid[1]) < Math.hypot(best[0] - mid[0], best[1] - mid[1]) ? l : best));
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
// Each area of a type (countries, regions) as [w, s, e, n], plus a tiny box for its dot.
const fitCountries = (type) => expandIso([...type.core, ...type.fringe]).filter((iso) => !(V.fitIgnore ?? []).includes(iso));
function boxesFor(type, regions = []) {
  const boxes = [...fitCountries(type).map((iso) => state.countryBoxes.get(iso)), ...regions.map(featureBox)]
    .filter(Boolean)
    .map((box) => ((box.a[2] - box.a[0]) > 180 ? box.b : box.a));
  return boxes;
}

function boundsFor(type, regions = []) {
  let a = [type.lon, type.lat, type.lon, type.lat];
  const lonB = type.lon < 0 ? type.lon + 360 : type.lon;
  let b = [lonB, type.lat, lonB, type.lat];
  const boxes = [...fitCountries(type).map((iso) => state.countryBoxes.get(iso)), ...regions.map(featureBox)];
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

// Raw dot positions of a type: one per local name (types without names keep their centre dot).
const rawDots = (t) => (t.names.length ? t.names.map((n, i) => [i, nameDot(t, n)]) : [[-1, [t.lon, t.lat]]]);

// Final dot positions for every type, worked out once for the whole map so that a dot sits in the
// same place whether it is clustered, open or filtered. Dots closer than DOT_GAP degrees to each
// other (e.g. two types placed in the middle of the same region) are fanned out in a small ring.
const DOT_GAP = 0.3;
const dotPositions = new Map();   // "T014:0" -> [lon, lat]
function computeDotPositions() {
  dotPositions.clear();
  const all = [];
  for (const t of state.types) for (const [n, c] of rawDots(t)) all.push({ key: `${t.id}:${n}`, c });
  const groups = [];
  for (const d of all) {
    const near = groups.find((g) => {
      const [lon, lat] = g[0].c;
      return Math.abs(d.c[1] - lat) < DOT_GAP && Math.abs(d.c[0] - lon) * Math.cos((lat * Math.PI) / 180) < DOT_GAP;
    });
    if (near) near.push(d); else groups.push([d]);
  }
  for (const g of groups) {
    if (g.length < 2) { dotPositions.set(g[0].key, g[0].c); continue; }
    const lon = g.reduce((a, d) => a + d.c[0], 0) / g.length, lat = g.reduce((a, d) => a + d.c[1], 0) / g.length;
    const r = 0.25 + 0.04 * g.length; // degrees
    g.forEach((d, i) => {
      const a = (2 * Math.PI * i) / g.length - Math.PI / 2;
      dotPositions.set(d.key, [lon + (r * Math.cos(a)) / Math.cos((lat * Math.PI) / 180), lat + r * Math.sin(a)]);
    });
  }
  state.dotGroups = groups.filter((g) => g.length > 1).map((g) => g.map((d) => d.key));
}

function dotFeatures(t) {
  return rawDots(t).map(([n, c]) => ({
    type: 'Feature', properties: { id: t.id, n },
    geometry: { type: 'Point', coordinates: mapCoords(dotPositions.get(`${t.id}:${n}`) ?? c) },
  }));
}
// The open type's dots are kept out of the clusters (drawn from their own source) so they stay visible.
function selectedCollection() {
  const t = state.byId.get(state.selected);
  return { type: 'FeatureCollection', features: t ? dotFeatures(t) : [] };
}

const isStandout = (id) => CONFIG.standout?.ids?.includes(id);
// Stand-out types (e.g. T000) are drawn from their own source and never clustered.
function standoutCollection() {
  const features = [];
  for (const t of visibleTypes()) if (isStandout(t.id) && t.id !== state.selected) features.push(...dotFeatures(t));
  return { type: 'FeatureCollection', features };
}

function featureCollection() {
  const features = [];
  for (const t of visibleTypes()) {
    if (t.id === state.selected || isStandout(t.id)) continue;
    features.push(...dotFeatures(t));
  }
  return { type: 'FeatureCollection', features };
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

// Diagonal hatching drawn pixel by pixel (no anti-aliased edges), so tiles join without seams.
// Drawn at 2× and registered with pixelRatio 2 so the lines stay crisp.
const HATCH = { spacing: 6, width: 1.5, ratio: 2 };   // in screen pixels
function hatchImage(color, opacity) {
  const step = HATCH.spacing * HATCH.ratio, w = Math.round(HATCH.width * HATCH.ratio);
  const size = step * 4;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x + y) % step < w) {
        const k = (y * size + x) * 4;
        data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = Math.round(255 * opacity);
      }
    }
  }
  return { width: size, height: size, data };
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
  const [south, north] = V.flatLatitudes.map((lat) => mapCoords([0, lat])[1]);
  const top = mercY(north), bottom = mercY(south);
  const { clientWidth: w, clientHeight: h } = map.getCanvas();
  const minZoom = Math.max(Math.log2(w / 512), Math.log2(h / (512 * (bottom - top))));
  const z = Math.min(Math.max(zoom, minZoom), V.maxZoom);
  const size = 512 * 2 ** z;
  const y = Math.min(Math.max(mercY(lngLat.lat) * size, top * size + h / 2), bottom * size - h / 2);
  return { center: new maplibregl.LngLat(lngLat.lng, mercLat(y / size)), zoom: z };
}

function applyProjection() {
  const real = eeOn ? eeInverse(map.getCenter().toArray()) : map.getCenter().toArray();
  const ee = V.projection === 'mercator' && CONFIG.flatProjection === 'equalEarth';
  map.setProjection({ type: V.projection });
  if (ee !== eeOn) {
    eeOn = ee;
    if (map.getSource('countries')) redrawGeometry();
  }
  // No tilting or turning on either view (right-drag, two-finger twist or tilt).
  map.setTransformConstrain(V.projection === 'mercator' ? flatConstrain : null);
  map.jumpTo({ center: mapCoords(real), zoom: map.getZoom() }); // re-apply limits now
}
// Climate image placement: Web Mercator images, or the Equal Earth ones when that is on.
function climateImage(name) {
  if (!eeOn) return { url: `${CONFIG.climate.folder}${name}.webp`, coordinates: [[-180, 85.0511], [180, 85.0511], [180, -85.0511], [-180, -85.0511]] };
  const top = eeForward([0, 90])[1];
  return { url: `${CONFIG.climate.folder}${name}-ee.webp`, coordinates: [[-180, top], [180, top], [180, -top], [-180, -top]] };
}
// Hand every shape to the map again after switching between Mercator and Equal Earth.
function redrawGeometry() {
  map.getSource('countries').setData(toMap(state.countriesGeo));
  map.getSource('ocean').setData(toMap(state.oceanGeo) ?? { type: 'FeatureCollection', features: [] });
  map.getSource('graticule').setData(toMap(graticule()));
  map.getSource('regions').setData(toMap(state.regionsGeo));
  for (const name of Object.keys(CONFIG.climate.layers)) map.getSource(`climate-${name}`).updateImage(climateImage(name));
  refreshDots();
  for (const c of cards) {
    const t = state.byId.get(c.id);
    c.marker.setLngLat(mapCoords(dotPositions.get(`${c.id}:${c.n}`) ?? [t.lon, t.lat]));
  }
}

map.dragRotate.disable();
map.touchZoomRotate.disableRotation();
map.touchPitch.disable();
map.keyboard.disableRotation();

const mapLoaded = new Promise((resolve) => map.once('load', resolve));
document.body.style.background = T.space;

function addLayers(countries) {
  map.addImage('hatch', hatchImage(T.fringe, T.fringeOpacity), { pixelRatio: HATCH.ratio });
  map.addSource('graticule', { type: 'geojson', data: toMap(graticule()) });
  map.addSource('countries', { type: 'geojson', data: toMap(countries) });
  map.addSource('types', {
    type: 'geojson', data: featureCollection(),
    cluster: true, clusterRadius: V.clusterRadius, clusterMaxZoom: V.clusterMaxZoom,
  });
  const none = ['in', ['get', 'iso'], ['literal', []]];
  map.addLayer({ id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': T.graticule, 'line-width': 0.6 } });
  map.addLayer({ id: 'land', type: 'fill', source: 'countries', paint: { 'fill-color': T.land } });
  // Climate underlays: Web Mercator images covering the whole world, hidden until chosen.
  for (const name of Object.keys(CONFIG.climate.layers)) {
    map.addSource(`climate-${name}`, { type: 'image', ...climateImage(name) });
    map.addLayer({
      id: `climate-${name}`, type: 'raster', source: `climate-${name}`,
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': CONFIG.climate.opacity, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
    });
  }
  // Sea drawn over the climate images, so coastlines stay crisp (Natural Earth 1:50m ocean).
  map.addSource('ocean', { type: 'geojson', data: toMap(state.oceanGeo) ?? { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'ocean-mask', type: 'fill', source: 'ocean', layout: { visibility: 'none' }, paint: { 'fill-color': T.ocean } });
  map.addLayer({ id: 'fringe', type: 'fill', source: 'countries', filter: none, paint: { 'fill-pattern': 'hatch' } });
  map.addLayer({ id: 'core', type: 'fill', source: 'countries', filter: none, paint: { 'fill-color': T.core, 'fill-opacity': T.coreOpacity } });
  map.addSource('regions', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'region-fringe', type: 'fill', source: 'regions', filter: ['==', ['get', 'role'], 'fringe'], paint: { 'fill-pattern': 'hatch' } });
  map.addLayer({ id: 'region-core', type: 'fill', source: 'regions', filter: ['==', ['get', 'role'], 'core'], paint: { 'fill-color': T.core, 'fill-opacity': T.coreOpacity } });
  // Outlines of the selected type's area, so it stays readable over a climate underlay.
  map.addLayer({ id: 'core-line', type: 'line', source: 'countries', filter: none, paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline } });
  map.addLayer({ id: 'fringe-line', type: 'line', source: 'countries', filter: none, paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline * 0.6, 'line-dasharray': [2, 1.5] } });
  // Region outlines switched off for now; remove the // to bring them back.
  // map.addLayer({ id: 'region-core-line', type: 'line', source: 'regions', filter: ['==', ['get', 'role'], 'core'], paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline } });
  // map.addLayer({ id: 'region-fringe-line', type: 'line', source: 'regions', filter: ['==', ['get', 'role'], 'fringe'], paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline * 0.6, 'line-dasharray': [2, 1.5] } });
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
      el.style.setProperty('--size', `${Math.round(21 + Math.sqrt(p.point_count) * 4.4)}px`);
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

// If an open-type dot lands on a cluster bubble, push it out to the bubble's edge so it isn't
// mistaken for part of the cluster.
function nudgeSelected() {
  if (!selectedMarkers.length && !standoutMarkers.length) return;
  const bubbles = [...clustersOnScreen.values()].map((m) => ({
    p: map.project(m.getLngLat()),
    r: parseFloat(m.getElement().style.getPropertyValue('--size')) / 2 || 15,
  }));
  for (const m of [...selectedMarkers, ...standoutMarkers]) {
    const p = map.project(m.getLngLat());
    let offset = [0, 0];
    for (const b of bubbles) {
      const dx = p.x - b.p.x, dy = p.y - b.p.y;
      const d = Math.hypot(dx, dy);
      const need = b.r + 12; // bubble radius + half the dot + a gap
      if (d >= need) continue;
      // Direction away from the bubble's centre (straight up-right if they coincide).
      const ux = d > 0.5 ? dx / d : 0.7071, uy = d > 0.5 ? dy / d : -0.7071;
      offset = [ux * need - dx, uy * need - dy];
      break;
    }
    const cur = m.getOffset();
    if (Math.abs(cur.x - offset[0]) > 0.5 || Math.abs(cur.y - offset[1]) > 0.5) m.setOffset(offset);
  }
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
let standoutMarkers = [];   // stand-out types (T000), also drawn above the clusters
function markDots(id, n) {
  for (const m of selectedMarkers) m.getElement().classList.toggle('active', Number(m.getElement().dataset.n) === n);
}
// Rebuild the clustered dots and the open type's dots (after the open type changes).
function refreshDots() {
  resetClusters();
  map.getSource('types').setData(featureCollection());
  for (const m of [...selectedMarkers, ...standoutMarkers]) m.remove();
  standoutMarkers = standoutCollection().features.map((f) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'dot-standout';
    el.title = displayName(state.byId.get(f.properties.id), f.properties.n).name;
    el.addEventListener('click', (e) => { e.stopPropagation(); select(f.properties.id, { name: f.properties.n }); });
    return new maplibregl.Marker({ element: el, opacityWhenCovered: 0 }).setLngLat(f.geometry.coordinates).addTo(map);
  });
  selectedMarkers = selectedCollection().features.map((f) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `dot-selected${isStandout(f.properties.id) ? ' standout' : ''}`;
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
  if (FLOAT) showCard(type, i);
  else {
    const scroll = $('panel-body').scrollTop;
    renderType(type, i);
    $('panel-body').scrollTop = scroll;
  }
  if (!fly || V.onClick !== 'fit') return;
  const n = type.names[i];
  const id = type.id;
  const regions = await regionFeatures(regionsOf(n.where), 'name');
  if (state.selected !== id || state.nameIndex !== i) return;
  const [lon, lat] = dotPositions.get(`${type.id}:${i}`) ?? nameDot(type, n);
  const area = { lon, lat, core: countriesOf(n.where), fringe: [] };
  fitIfNeeded(boundsFor(area, regions), boxesFor(area, regions), [lon, lat]);
}

async function select(id, { fly = true, name = null } = {}) {
  const type = state.byId.get(id);
  if (!type) return;
  // Clicking another dot (or name) of the type that is already open just switches names.
  const open = FLOAT ? !!cardFor(id) : !$('panel').hidden;
  if (state.selected === id && name !== null && name >= 0 && open) { switchName(name, { fly }); return; }
  state.selected = id;
  state.nameIndex = name ?? (type.names.length ? 0 : -1);
  state.country = null;
  map.setFilter('country-selected', ['in', ['get', 'iso'], ['literal', []]]);
  setArea(expandIso(type.core), [...expandIso(type.fringe), ...gapsFor(type)]);
  refreshDots();
  markDots(id, state.nameIndex);
  state.regionsGeo = { type: 'FeatureCollection', features: [] };
  map.getSource('regions').setData(state.regionsGeo);
  if (FLOAT) { $('panel').hidden = true; showCard(type, state.nameIndex); }
  else renderType(type, state.nameIndex);
  closeStory();
  history.replaceState(null, '', `#${id}`);

  const regions = [
    ...(await regionFeatures(regionsOf(type.core), 'core')),
    ...(await regionFeatures(regionsOf(type.fringe), 'fringe')),
  ];
  if (state.selected !== id) return; // another type was clicked meanwhile
  state.regionsGeo = { type: 'FeatureCollection', features: regions };
  map.getSource('regions').setData(toMap(state.regionsGeo));
  if (fly && V.onClick === 'fit') {
    const n = type.names[state.nameIndex];
    fitIfNeeded(boundsFor(type, regions), boxesFor(type, regions), dotPositions.get(`${type.id}:${state.nameIndex}`) ?? [type.lon, type.lat]);
  }
}

// Camera rules after selecting a type (or one of its names), when "Fit extent" is on:
//  1. If any of its areas is entirely off screen, bring the whole extent into view (zooming out if needed).
//  2. If every area is at least partly on screen, leave the view alone (no need to show all of Russia)...
//  3. ...unless the whole extent is tiny on screen (e.g. Liechtenstein): then zoom in a little.
function fitIfNeeded(bounds, boxes = [], dot = null) {
  const panel = $('panel').getBoundingClientRect();
  const narrow = window.innerWidth < 760;
  const padding = narrow
    ? { top: 40, bottom: window.innerHeight * 0.62 + 20, left: 40, right: 40 }
    : { top: 60, bottom: 60, left: 280, right: (FLOAT ? 0 : panel.width) + 60 };
  // Equal Earth: work with where things are drawn, not their real coordinates.
  if (eeOn) {
    const [w, s, e, n] = boxToMap([bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]]);
    bounds = [[w, s], [e, n]];
    boxes = boxes.map(boxToMap);
    if (dot) dot = eeForward(dot);
  }
  // On the flat map, use the copy of the world nearest to the current view.
  let shift = 0;
  if (V.projection === 'mercator') {
    const mid = (bounds[0][0] + bounds[1][0]) / 2;
    shift = Math.round((map.getCenter().lng - mid) / 360) * 360;
    bounds = [[bounds[0][0] + shift, bounds[0][1]], [bounds[1][0] + shift, bounds[1][1]]];
  }
  const w = map.getCanvas().clientWidth, h = map.getCanvas().clientHeight;
  const view = { x0: padding.left, y0: padding.top, x1: w - padding.right, y1: h - padding.bottom };
  const screenRect = ([west, south, east, north]) => {
    const pts = [[west, south], [east, north], [west, north], [east, south], [(west + east) / 2, (south + north) / 2]]
      .map(([x, y]) => map.project([x + shift, y]));
    return { x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)),
      y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) };
  };
  const onScreen = (r) => r.x1 >= view.x0 && r.x0 <= view.x1 && r.y1 >= view.y0 && r.y0 <= view.y1;
  const cam = map.cameraForBounds(bounds, { padding });
  if (!cam) return;
  // No areas left to fit (e.g. only Russia): just make sure the dot is in view.
  if (!boxes.length) {
    if (dot && !onScreen(screenRect([dot[0], dot[1], dot[0], dot[1]]))) map.easeTo({ center: [dot[0] + shift, dot[1]], duration: 1000 });
    return;
  }
  const allVisible = boxes.every((b) => onScreen(screenRect(b)));

  if (!allVisible) {
    if (cam.zoom < map.getZoom()) map.easeTo({ ...cam, duration: 1200 });
    else map.easeTo({ center: cam.center, duration: 1000 });
    return;
  }
  // Areas in view but the dot is not (e.g. opened from a country list): just pan to the dot.
  if (dot && !onScreen(screenRect([dot[0], dot[1], dot[0], dot[1]]))) {
    map.easeTo({ center: [dot[0] + shift, dot[1]], duration: 1000 });
    return;
  }
  // Everything is (partly) in view: only act if the whole extent is very small on screen.
  const all = screenRect([bounds[0][0] - shift, bounds[0][1], bounds[1][0] - shift, bounds[1][1]]);
  const size = Math.max(all.x1 - all.x0, all.y1 - all.y0, 1);
  if (size < V.smallArea) {
    const zoom = Math.min(map.getZoom() + Math.log2(V.smallAreaTarget / size), V.smallAreaMaxZoom, cam.zoom);
    if (zoom > map.getZoom() + 0.2) map.easeTo({ center: cam.center, zoom, duration: 1000 });
  }
}

function clearSelection() {
  state.selected = null;
  state.country = null;
  const none = ['in', ['get', 'iso'], ['literal', []]];
  setArea([], []);
  map.setFilter('country-selected', none);
  state.regionsGeo = { type: 'FeatureCollection', features: [] };
  map.getSource('regions').setData(state.regionsGeo);
  if (map.getSource('types')) refreshDots();
  $('panel').hidden = true;
  if (FLOAT) closeAllCards();
  closeStory();
  history.replaceState(null, '', location.pathname + location.search);
}

function renderType(t, nameIndex = -1, body = $('panel-body')) {
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
  body.innerHTML = `
    <figure class="type-image"></figure>
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
    <p class="meta">${esc(t.id)} · ${Math.abs(t.lat)}° ${t.lat < 0 ? 'S' : 'N'}, ${Math.abs(t.lon)}° ${t.lon < 0 ? 'W' : 'E'}</p>`;
  if (body === $('panel-body')) { $('panel').hidden = false; body.scrollTop = 0; }
  loadImage(t.id, body.querySelector('.type-image'));
}

// ── Floating cards (CONFIG.cards = 'float') ────────────────
// Each open type gets a small card beside its dot; up to CONFIG.maxCards at once. Opening one more
// closes the oldest, and a card closes when its dot leaves the screen. The newest/clicked card is the
// "current" type: its area is shaded and its dots coloured.
const cards = [];   // { id, n, marker, el }
function cardFor(id) { return cards.find((c) => c.id === id); }
function showCard(t, n) {
  let card = cardFor(t.id);
  if (!card) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<button type="button" class="close" data-close-card aria-label="Close">×</button><div class="card-body"></div>`;
    el.dataset.type = t.id;
    // Keep map gestures and clicks from passing through a card to the map; handle its clicks here.
    for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'dblclick']) {
      el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    const wrap = document.createElement('div');
    wrap.className = 'card-anchor';
    wrap.append(el);
    card = { id: t.id, n, el, marker: null };
    card.marker = new maplibregl.Marker({ element: wrap, anchor: 'left' }).setLngLat([0, 0]).addTo(map);
    cards.push(card);
    while (cards.length > (CONFIG.maxCards ?? 5)) closeCard(cards[0]);
  } else {
    cards.splice(cards.indexOf(card), 1); cards.push(card); // newest last
  }
  card.n = n;
  renderType(t, n, card.el.querySelector('.card-body'));
  const pt = map.project(mapCoords(dotPositions.get(`${t.id}:${n}`) ?? [t.lon, t.lat]));
  const right = pt.x < map.getCanvas().clientWidth * 0.62;
  const down = pt.y < map.getCanvas().clientHeight * 0.5;
  card.marker.remove();
  // Hang the card from the dot's corner, towards the side (and up or down) with more room.
  const anchor = `${down ? 'top' : 'bottom'}-${right ? 'left' : 'right'}`;
  card.marker = new maplibregl.Marker({ element: card.marker.getElement(), anchor, offset: [right ? 14 : -14, down ? -14 : 14] })
    .setLngLat(mapCoords(dotPositions.get(`${t.id}:${n}`) ?? [t.lon, t.lat])).addTo(map);
  // The current card on top, older ones below in order.
  cards.forEach((c, i) => {
    c.el.classList.toggle('current', c === card);
    c.marker.getElement().style.zIndex = c === card ? 20 : 10 + i;
  });
}
function closeCard(card, { reselect = true } = {}) {
  const i = cards.indexOf(card);
  if (i < 0) return;
  cards.splice(i, 1);
  card.marker.remove();
  if (state.selected === card.id) {
    const next = cards[cards.length - 1];
    if (next && reselect) select(next.id, { name: next.n, fly: false });
    else clearSelection();
  }
}
function closeAllCards() { while (cards.length) { const c = cards.pop(); c.marker.remove(); } }
// Close cards whose dot has left the screen (or gone round the back of the globe).
function pruneCards() {
  if (!cards.length) return;
  const w = map.getCanvas().clientWidth, h = map.getCanvas().clientHeight;
  for (const c of [...cards]) {
    const ll = c.marker.getLngLat();
    const p = map.project(ll);
    const off = p.x < 0 || p.y < 0 || p.x > w || p.y > h || map.transform?.isLocationOccluded?.(ll);
    if (off) closeCard(c);
  }
}

// Try images/T014.jpg, .jpeg, .png, .webp in turn.
function loadImage(id, figure) {
  const exts = [...CONFIG.images.extensions];
  const tryNext = () => {
    if (!figure.isConnected) return;
    const ext = exts.shift();
    if (!ext) {
      if (CONFIG.images.showEmptySlot) { figure.classList.add('empty'); figure.textContent = `no image yet · ${id}`; }
      else figure.remove();
      return;
    }
    const img = new Image();
    img.alt = '';
    img.onload = () => {
      if (!figure.isConnected) return;
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
  $('count').textContent = shown === state.types.length ? `${shown} types` : `${shown} of ${state.types.length} types`;
}

document.addEventListener('click', (e) => onClick(e));
function onClick(e) {
  const cardEl = e.target.closest('.card');
  if (cardEl) {
    const card = cardFor(cardEl.dataset.type);
    if (e.target.closest('[data-close-card]')) { closeCard(card); return; }
    if (card && state.selected !== card.id) {
      select(card.id, { name: card.n, fly: false });
      if (!e.target.closest('button')) return;
    }
  }
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
}
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
      fetch(CONFIG.data.ocean).then((r) => r.json()).then((x) => { state.oceanGeo = x; }).catch(() => {}),
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
  state.countriesGeo = countries;
  state.countryShapes = new Map();
  for (const f of countries.features) {
    if (!state.countryShapes.has(f.properties.iso)) state.countryShapes.set(f.properties.iso, []);
    state.countryShapes.get(f.properties.iso).push(f.geometry);
  }
  if (namesCSV) parseNames(namesCSV);
  computeCountryBoxes(countries);
  computeDotPositions();
  showMessage('');
  updateCount();
  loadImageList();

  await mapLoaded;
  applyProjection();
  {
    addLayers(countries);
    refreshDots();
    applyClimate();
    map.on('render', () => { if (map.getSource('types') && map.isSourceLoaded('types')) { updateClusters(); nudgeSelected(); } });
    if (FLOAT) map.on('moveend', pruneCards);
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

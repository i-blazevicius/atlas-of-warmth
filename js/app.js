import * as maplibregl from '../lib/maplibre-gl.mjs';
// config.js is loaded with the same cache-busting query as this file.
const CONFIG = (await import(`./config.js${new URL(import.meta.url).search}`)).default;

// Address-bar override for the experiment: ?flat=equalearth (or =mercator).
{
  const q = new URLSearchParams(location.search);
  if (q.get('flat')) CONFIG.flatProjection = /equal/i.test(q.get('flat')) ? 'equalEarth' : 'mercator';
}

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

// Map colours: the built-in ones (CONFIG.theme, left untouched) with the style version's on top.
const T = { ...CONFIG.theme };
const V = { ...CONFIG.view };

// Style version (fonts and colours) from data/styles.json, applied before anything is drawn. See js/styles.js.
const { createCore } = await import(`./core.js${new URL(import.meta.url).search}`);
const Styles = await import(`./styles.js${new URL(import.meta.url).search}`);
const styleLib = await Styles.loadLibrary(CONFIG);
const startStyle = Styles.startingStyle(styleLib.lib, CONFIG);
if (startStyle) {
  Styles.applyCss(startStyle, styleLib.lib.fonts, { remember: true });
  for (const [k, v] of Object.entries(Styles.mapColours(startStyle))) if (v) T[k] = v;
}
document.documentElement.style.setProperty('--area', T.core);
document.documentElement.style.setProperty('--hatch', T.fringe);
Styles.reveal();
const $ = (id) => document.getElementById(id);

// Data, parsing and the type card are shared with the print page: js/core.js.
const core = createCore(CONFIG, V);
const {
  state, esc, nameDot, nameIndexFor, displayName, expandIso, regionsOf, countriesOf, regionCountry, regionFeatures,
  boxesFor, boundsFor, visibleTypes, rawDots, dotPositions, isStandout, latLon, gapsFor, loadData,
} = core;

function showMessage(text, persist = false) {
  const m = $('message');
  m.textContent = text;
  m.hidden = !text;
  if (text && !persist) setTimeout(() => { if (m.textContent === text) m.hidden = true; }, 4000);
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

// Any CSS colour (#hex, rgb(), a name…) as [red, green, blue], read back from a 1-pixel canvas.
function rgbOf(color) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = '#000'; c.fillStyle = color;
  c.fillRect(0, 0, 1, 1);
  return [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

// Diagonal hatching drawn pixel by pixel (no anti-aliased edges), so tiles join without seams.
// Drawn at 2× and registered with pixelRatio 2 so the lines stay crisp.
const HATCH = { spacing: 6, width: 1.5, ratio: 2 };   // in screen pixels
function hatchImage(color, opacity) {
  const step = HATCH.spacing * HATCH.ratio, w = Math.round(HATCH.width * HATCH.ratio);
  const size = step * 4;
  const [r, g, b] = rgbOf(color);
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
}

map.dragRotate.disable();
map.touchZoomRotate.disableRotation();
map.touchPitch.disable();
map.keyboard.disableRotation();

const mapLoaded = new Promise((resolve) => map.once('load', resolve));
document.body.style.background = T.space;

// Map colours from a style version (the style panel calls this while you edit).
function setMapColours(c) {
  for (const [k, v] of Object.entries(c)) if (v) T[k] = v;
  document.body.style.background = T.space;
  document.documentElement.style.setProperty('--area', T.core);
  document.documentElement.style.setProperty('--hatch', T.fringe);
  if (!map.getLayer('land')) return;
  map.setPaintProperty('ocean', 'background-color', T.ocean);
  map.setPaintProperty('ocean-mask', 'fill-color', T.ocean);
  map.setPaintProperty('land', 'fill-color', T.land);
  map.setPaintProperty('borders', 'line-color', T.border);
  for (const id of ['core-line', 'fringe-line']) map.setPaintProperty(id, 'line-color', T.coreLine);
  map.setPaintProperty('graticule', 'line-color', T.graticule);
  map.setPaintProperty('points', 'circle-color', T.point);
  map.setPaintProperty('points', 'circle-stroke-color', T.pointStroke);
  map.setPaintProperty('country-selected', 'line-color', T.countryOutline);
  for (const id of ['core', 'region-core']) map.setPaintProperty(id, 'fill-color', T.core);
  map.updateImage('hatch', hatchImage(T.fringe, T.fringeOpacity));
}

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
  map.addLayer({ id: 'borders', type: 'line', source: 'countries', paint: { 'line-color': T.border, 'line-width': T.borderWidth } });
  // Outlines of the selected type's area, drawn over the borders (otherwise the thin border line shows
  // through the middle of the wider outline), so the area stays readable over a climate underlay.
  map.addLayer({ id: 'core-line', type: 'line', source: 'countries', filter: none, paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline } });
  map.addLayer({ id: 'fringe-line', type: 'line', source: 'countries', filter: none, paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline * 0.6, 'line-dasharray': [2, 1.5] } });
  // Region outlines switched off for now; remove the // to bring them back.
  // map.addLayer({ id: 'region-core-line', type: 'line', source: 'regions', filter: ['==', ['get', 'role'], 'core'], paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline } });
  // map.addLayer({ id: 'region-fringe-line', type: 'line', source: 'regions', filter: ['==', ['get', 'role'], 'fringe'], paint: { 'line-color': T.coreLine, 'line-width': T.areaOutline * 0.6, 'line-dasharray': [2, 1.5] } });
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
      el.setAttribute('aria-label', `${p.point_count} hearths, zoom in`);
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

// Mark which of the selected type's dots is the active one.
// The open type's dots are drawn as HTML elements (like the clusters) so they sit on top of them.
// Styled in CSS: .dot-selected, and .dot-selected.active for the one whose name is shown.
let selectedMarkers = [];
let standoutMarkers = [];   // stand-out types (T000), also drawn above the clusters
function markDots(n) {
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
  markDots(i);
  const scroll = $('panel-body').scrollTop;
  renderType(type, i);
  $('panel-body').scrollTop = scroll;
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
  if (state.selected === id && name !== null && name >= 0 && !$('panel').hidden) { switchName(name, { fly }); return; }
  state.selected = id;
  state.nameIndex = name ?? (type.names.length ? 0 : -1);
  state.country = null;
  map.setFilter('country-selected', ['in', ['get', 'iso'], ['literal', []]]);
  setArea(expandIso(type.core), [...expandIso(type.fringe), ...gapsFor(type)]);
  refreshDots();
  markDots(state.nameIndex);
  state.regionsGeo = { type: 'FeatureCollection', features: [] };
  map.getSource('regions').setData(state.regionsGeo);
  renderType(type, state.nameIndex);
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
    : { top: 60, bottom: 60, left: 280, right: panel.width + 60 };
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
  closeStory();
  history.replaceState(null, '', location.pathname + location.search);
}

function renderType(t, nameIndex = -1, body = $('panel-body')) {
  core.renderType(t, nameIndex, body);
  if (body === $('panel-body')) { $('panel').hidden = false; body.scrollTop = 0; }
}

// items: [type, nameIndex] pairs; the local name is shown, with the type's own name small below.
const typeItems = (items) => `<ul class="type-list">${items.map(([t, i]) => {
  const shown = displayName(t, i);
  return `<li><button type="button" data-type="${esc(t.id)}" data-n="${i}">${esc(shown.name)}<small>${esc(t.id)} · ${esc(t.name)}</small></button></li>`;
}).join('')}</ul>`;

function showList(items) {
  if (state.selected) clearSelection();
  $('panel-body').innerHTML = `<p class="list-title">${items.length} hearths in this spot</p>${typeItems(items)}`;
  $('panel').hidden = false;
}

// Click on a country (or a region inside it): list the hearths found there that the filters let through.
function showCountry(iso, name) {
  clearSelection();
  state.country = iso;
  map.setFilter('country-selected', ['==', ['get', 'iso'], iso]);
  const inCodes = (codes) => expandIso(codes).includes(iso) || regionsOf(codes).some((c) => regionCountry(c) === iso);
  const shown = new Set(visibleTypes());
  const wide = [], less = [];
  let hidden = 0;
  for (const t of state.types) {
    const where = inCodes(t.core) ? wide : inCodes(t.fringe) || gapsFor(t).includes(iso) ? less : null;
    if (!where) continue;
    if (shown.has(t)) where.push([t, nameIndexFor(t, iso)]); else hidden++;
  }
  const section = (title, list) => (list.length ? `<p class="list-title">${title}</p>${typeItems(list)}` : '');
  $('panel-body').innerHTML = `
    <h1 class="story-title">${esc(name)}</h1>
    ${section('Widely used', wide)}
    ${section('Less prevalent / likely', less)}
    ${!wide.length && !less.length && !hidden ? '<p class="meta">No hearths recorded here yet.</p>' : ''}
    ${hidden ? `<p class="meta">${hidden} more hidden by the filters.</p>` : ''}`;
  $('panel').hidden = false;
  $('panel-body').scrollTop = 0;
}

function openStory(cid) {
  const row = state.cases.get(cid);
  if (!row) return;
  const cols = state.caseCols;
  const hidden = new Set(CONFIG.caseHiddenColumns.map((h) => h.toLowerCase()));
  const val = (k) => (cols[k] ? String(row[cols[k]] ?? '').trim() : '');
  const story = val('story');
  const placePeriod = [val('place'), val('period')].filter(Boolean).join(' · ');
  const author = val('author');
  const lat = parseFloat(val('lat')), lon = parseFloat(val('lon'));
  // Other columns not hidden in config (none at the moment) are listed after the author.
  const fields = state.caseHeaders
    .filter((h) => !hidden.has(h.trim().toLowerCase()) && String(row[h] ?? '').trim())
    .map((h) => `<dt>${esc(h)}</dt><dd>${esc(row[h])}</dd>`).join('');
  $('story-body').innerHTML = `
    <h1 class="story-title">${esc(val('title') || cid)}</h1>
    ${placePeriod ? `<dl class="fields story-where"><dt>Place and period</dt><dd>${esc(placePeriod)}</dd></dl>` : ''}
    ${story ? `<div class="story-text">${esc(story)}</div>` : '<p class="meta">No story text yet.</p>'}
    ${author || fields ? `<dl class="fields">${author ? `<dt>Author</dt><dd>${esc(author)}</dd>` : ''}${fields}</dl>` : ''}
    <p class="meta">${esc(cid)}${Number.isFinite(lat) && Number.isFinite(lon) ? ` · ${latLon(lat, lon)}` : ''}</p>`;
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
  $('count').textContent = shown === state.types.length ? `${shown} hearths` : `${shown} of ${state.types.length} hearths`;
}
// Things in the sheet the map could not use (renamed columns, unknown area codes…), under the count.
function showProblems() {
  const box = $('problems');
  const list = state.problems;
  box.hidden = !list.length;
  if (!list.length) return;
  box.innerHTML = `<summary>${list.length} problem${list.length > 1 ? 's' : ''} in the sheet</summary>
    <ul>${list.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
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
// Filters on at the start (CONFIG.view.onlyImages / onlyStories).
state.onlyImages = !!V.onlyImages; $('filter-images').checked = state.onlyImages;
state.onlyStories = !!V.onlyStories; $('filter-stories').checked = state.onlyStories;
$('filter-images').addEventListener('change', (e) => { state.onlyImages = e.target.checked; refilter(); });

// Which types have an image: the image index written by the upload page (data/images.json), which
// also gives each image's size. If it cannot be read, list the repository's images folder instead
// (GitHub API, no login needed, but limited to 60 requests an hour per visitor).
async function loadImageList() {
  try {
    const r = await fetch(`${CONFIG.data.images}?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) {
      state.imageIndex = await r.json();
      state.images = new Set(Object.keys(state.imageIndex));
      updateCount();
      return;
    }
  } catch { /* fall back to listing the folder on GitHub */ }
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
  let countries;
  try {
    await Promise.all([
      loadData().then((c) => { countries = c; }),
      fetch(CONFIG.data.ocean).then((r) => r.json()).then((x) => { state.oceanGeo = x; }).catch(() => {}),
      fetch(`${CONFIG.climate.folder}legend.json`).then((r) => r.json()).then((x) => { climate.legend = x; }).catch(() => {}),
    ]);
  } catch (err) {
    $('count').textContent = 'not loaded';
    showMessage('');
    window.atlasFail(err);
    return;
  }
  showMessage('');
  updateCount();
  showProblems();
  await loadImageList(); // before the first dots, as 'Only types with images' may be on from the start

  await mapLoaded;
  applyProjection();
  {
    addLayers(countries);
    if (CONFIG.stylePanel) Styles.initPanel({ CONFIG, lib: styleLib.lib, sha: styleLib.sha, current: startStyle, setMapColours });
    refreshDots();
    applyClimate();
    map.on('render', () => { if (map.getSource('types') && map.isSourceLoaded('types')) { updateClusters(); nudgeSelected(); } });
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

window.atlas = { map, state, select, selectedCollection, openStory };

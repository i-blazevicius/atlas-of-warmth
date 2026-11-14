// Print page: every type as a card, packed into balanced columns on the smallest paper that fits.
// Settings start from CONFIG.print (js/config.js) and can be changed in the bar at the top of the page.

const search = new URL(import.meta.url).search;
const CONFIG = (await import(`./config.js${search}`)).default;
const { createCore } = await import(`./core.js${search}`);
const Styles = await import(`./styles.js${search}`);

const P = { ...{
  style: null, cardWidth: 85, gap: 5, margin: 12, paper: 'auto', order: 'family',
  onlyImages: false, emptyImages: false, locator: true, title: 'Atlas of Warmth', header: 12,
}, ...(CONFIG.print ?? {}) };
// Address-bar overrides, e.g. print.html?paper=A2&order=random&images=only
{
  const q = new URLSearchParams(location.search);
  if (q.get('paper')) P.paper = q.get('paper');
  if (q.get('order')) P.order = q.get('order');
  if (q.get('width')) P.cardWidth = Number(q.get('width'));
  if (q.get('images') === 'only') P.onlyImages = true;
  if (q.get('style')) P.style = q.get('style');
  if (q.get('seed')) P.seed = Number(q.get('seed'));
}

const V = { ...CONFIG.view };
const T = CONFIG.theme;
const core = createCore(CONFIG, V);
const { state, esc, expandIso, countriesOf, regionsOf, regionFeatures, gapsFor, rawDots, dotPositions } = core;
const $ = (id) => document.getElementById(id);

const MM = 25.4 / 96;                 // one CSS pixel in millimetres
const PAPER = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189] };
const LOCATOR = { w: 4, h: 3, pad: 0.3, minLat: 12, ignoredMinLat: 40 }; // 4:3, 30% margin round the area, in degrees

// ── Style ──────────────────────────────────────────────────
const { lib } = await Styles.loadLibrary({ ...CONFIG, stylePanel: false });
let styleName = [P.style, 'Print, white', lib.default].find((n) => lib.styles.some((s) => s.name === n)) ?? lib.styles[0]?.name;
let colours = {};
function applyStyle(name) {
  styleName = name;
  const style = lib.styles.find((s) => s.name === name);
  if (!style) return;
  Styles.applyCss(style, lib.fonts);
  colours = { ...T, ...Object.fromEntries(Object.entries(Styles.mapColours(style)).filter(([, v]) => v)) };
}
applyStyle(styleName);

// ── Data ───────────────────────────────────────────────────
$('p-info').textContent = 'Loading data…';
const countries = await core.loadData();
try { state.imageIndex = await (await fetch(`${CONFIG.data.images}?t=${Date.now()}`, { cache: 'no-store' })).json(); } catch { state.imageIndex = null; }
state.images = state.imageIndex ? new Set(Object.keys(state.imageIndex)) : null;

// ── Locator map ────────────────────────────────────────────
// A small plain map (simple equirectangular, narrowed by the cosine of the latitude) round the type's
// area, drawn as SVG so it prints as vectors. Same shading as the map: core filled, fringe and
// inferred gaps hatched, regions where only part of a country is listed.
async function locator(t) {
  const core = expandIso(countriesOf(t.core));
  const fringe = [...expandIso(countriesOf(t.fringe)), ...gapsFor(t)];
  const regions = [...await regionFeatures(regionsOf(t.core), 'core'), ...await regionFeatures(regionsOf(t.fringe), 'fringe')];
  const byIso = (list) => countries.features.filter((f) => list.includes(f.properties.iso));
  const ignore = V.fitIgnore ?? [];
  const ignored = expandIso([...t.core, ...t.fringe]).some((iso) => ignore.includes(iso));
  const fitted = [...byIso([...core, ...fringe].filter((iso) => !ignore.includes(iso))), ...regions];
  const [w0, s0, e0, n0] = areaBox(t, fitted);
  // Window: the area plus a margin, at least minLat degrees tall, widened to 4:3.
  let cx = (w0 + e0) / 2, cy = (s0 + n0) / 2;
  let hLat = Math.max((n0 - s0) * (1 + 2 * LOCATOR.pad), ignored ? LOCATOR.ignoredMinLat : LOCATOR.minLat);
  const k = Math.cos((Math.max(-70, Math.min(70, cy)) * Math.PI) / 180);
  let wLon = Math.max((e0 - w0) * (1 + 2 * LOCATOR.pad), (hLat * LOCATOR.w) / LOCATOR.h / k);
  hLat = Math.max(hLat, (wLon * k * LOCATOR.h) / LOCATOR.w);
  wLon = (hLat * LOCATOR.w) / LOCATOR.h / k;
  cy = Math.max(-85 + hLat / 2, Math.min(85 - hLat / 2, cy));
  const W = 160, H = (W * LOCATOR.h) / LOCATOR.w;
  const x0 = cx - wLon / 2, y1 = cy + hLat / 2;
  const px = (lon) => ((lon - x0) / wLon) * W, py = (lat) => ((y1 - lat) / hLat) * H;

  // A ring as an SVG path, moved by whole turns of the globe to sit nearest the window, thinned out.
  const ringPath = (ring) => {
    const mean = ring.reduce((a, c) => a + c[0], 0) / ring.length;
    const shift = Math.round((cx - mean) / 360) * 360;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, last = null, d = '';
    for (const [lon, lat] of ring) {
      const x = px(lon + shift), y = py(lat);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (last && Math.abs(x - last[0]) < 0.4 && Math.abs(y - last[1]) < 0.4) continue;
      d += `${last ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      last = [x, y];
    }
    if (maxX < 0 || minX > W || maxY < 0 || minY > H) return '';
    return `${d}Z`;
  };
  const geomPath = (g) => {
    if (!g) return '';
    const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
    return polys.flatMap((p) => p.map(ringPath)).join('');
  };
  const paths = (features) => features.map((f) => geomPath(f.geometry)).join('');
  const coreGeo = [...byIso(core), ...regions.filter((f) => f.properties.role === 'core')];
  const fringeGeo = [...byIso(fringe), ...regions.filter((f) => f.properties.role === 'fringe')];
  const id = `h-${t.id}`;
  const dots = rawDots(t).map(([n, c]) => {
    const [lon, lat] = dotPositions.get(`${t.id}:${n}`) ?? c;
    const x = px(lon + Math.round((cx - lon) / 360) * 360), y = py(lat);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6"/>`;
  }).join('');
  return `<svg class="pc-locator" viewBox="0 0 ${W} ${H.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">
    <defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="3" height="3" patternTransform="rotate(45)">
      <rect width="1.1" height="3" fill="${colours.fringe}"/></pattern></defs>
    <rect width="${W}" height="${H.toFixed(1)}" fill="${colours.ocean}"/>
    <path d="${paths(countries.features)}" fill="${colours.land}" stroke="none"/>
    <path d="${paths(fringeGeo)}" fill="url(#${id})" stroke="none"/>
    <path d="${paths(coreGeo)}" fill="${colours.core}" stroke="none"/>
    <path d="${paths(countries.features)}" fill="none" stroke="${colours.border}" stroke-width="0.4" stroke-linejoin="round"/>
    <path d="${paths([...coreGeo, ...fringeGeo])}" fill="none" stroke="${colours.coreLine}" stroke-width="0.8" stroke-linejoin="round"/>
    <g class="pc-dots" stroke-width="0.8">${dots}</g>
  </svg>`;
}

// Box [w, s, e, n] round a type's areas, for framing its locator. Far-off pieces of a country
// (overseas islands, Alaska, French Guiana…) are left out: a piece counts if it is at least a quarter
// the size of the country's biggest piece, or lies within 25° of the type's centre.
function areaBox(t, features) {
  const pieces = [];
  for (const f of features) {
    const g = f.geometry;
    const polys = g?.type === 'MultiPolygon' ? g.coordinates : g?.type === 'Polygon' ? [g.coordinates] : [];
    const own = polys.map((p) => {
      const r = p[0];
      let area = 0, w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
      for (let i = 0; i < r.length; i++) {
        const [x, y] = r[i], [x2, y2] = r[(i + 1) % r.length];
        area += (x * y2 - x2 * y) * Math.cos((y * Math.PI) / 180);
        w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
      }
      return { area: Math.abs(area / 2), ring: r, box: [w, s, e, n] };
    });
    const biggest = Math.max(0, ...own.map((x) => x.area));
    for (const x of own) {
      const cx = (x.box[0] + x.box[2]) / 2, cy = (x.box[1] + x.box[3]) / 2;
      const dLon = Math.abs(((cx - t.lon + 540) % 360) - 180) * Math.cos((t.lat * Math.PI) / 180);
      if (x.area >= biggest * 0.25 || Math.hypot(dLon, cy - t.lat) < 25) pieces.push(x.ring);
    }
  }
  // Two ways round the globe (longitudes -180…180 or 0…360); keep the narrower one.
  const a = [t.lon, t.lat, t.lon, t.lat], b = [(t.lon + 360) % 360, t.lat, (t.lon + 360) % 360, t.lat];
  for (const ring of pieces) for (const [x, y] of ring) {
    const xb = x < 0 ? x + 360 : x;
    a[0] = Math.min(a[0], x); a[2] = Math.max(a[2], x); b[0] = Math.min(b[0], xb); b[2] = Math.max(b[2], xb);
    a[1] = b[1] = Math.min(a[1], y); a[3] = b[3] = Math.max(a[3], y);
  }
  return b[2] - b[0] < a[2] - a[0] ? b : a;
}

// ── Cards ──────────────────────────────────────────────────
// The map's card, rearranged: picture, family, name; then the other names on the left with the
// locator map on the right; then form, period, stories and ID as usual.
async function buildCard(t) {
  const el = document.createElement('article');
  el.className = 'pcard';
  el.innerHTML = '<div class="pcard-body"></div>';
  const body = el.firstChild;
  core.renderType(t, -1, body);
  let fig = body.querySelector('.type-image');
  if (!state.images?.has(t.id)) {
    fig?.remove(); fig = null;
    if (P.emptyImages) body.insertAdjacentHTML('afterbegin', `<figure class="type-image empty">no image yet · ${esc(t.id)}</figure>`);
  }
  // Very tall pictures are cropped to a square so one card cannot run the length of a column.
  const info = state.imageIndex?.[t.id];
  if (fig && info && info.h > info.w) fig.classList.add('pc-tall');

  // Name with its native script on the same line (wrapping below when it does not fit).
  const head = document.createElement('div');
  head.className = 'pc-title';
  const translit = body.querySelector('.translit');
  translit.replaceWith(head);
  head.append(translit);
  const native = body.querySelector('.native');
  if (native) head.append(native);
  body.querySelector('.language')?.remove();
  body.querySelector('.also-known')?.remove();
  let after = head;
  const title = t.translit || t.name;
  const others = t.names.filter((n) => n.name !== title);
  if (others.length) {
    const p = document.createElement('p');
    p.className = 'pc-also';
    p.innerHTML = others.map((n) => `<span>${esc(n.name)}${n.native && n.native !== n.name ? ` <i>${esc(n.native)}</i>` : ''} <small>${esc(n.where.join(' '))}</small></span>`).join('');
    head.after(p);
    after = p;
  }
  // Map on the left, the type's description beside it.
  const row = document.createElement('div');
  row.className = 'pc-row';
  const names = document.createElement('div');
  names.className = 'pc-names';
  const typeName = body.querySelector('.type-name');
  if (typeName) names.append(typeName);
  if (P.locator) {
    const left = document.createElement('div');
    left.className = 'pc-map';
    left.innerHTML = (await locator(t)) + widelyUsed(t);
    row.append(left);
  }
  row.append(names);
  after.after(row);
  // Stories as plain text (no buttons on paper).
  body.querySelectorAll('.stories button').forEach((b) => { const s = document.createElement('span'); s.textContent = b.textContent; b.replaceWith(s); });
  return el;
}

// Countries with at least some 'widely used' shading, under the locator: full names, or codes when
// the names would make a long list.
const countryName = new Map(countries.features.map((f) => [f.properties.iso, f.properties.name]));
function widelyUsed(t) {
  const whole = expandIso(countriesOf(t.core));
  const isos = [...new Set([...whole, ...regionsOf(t.core).map(core.regionCountry).filter(Boolean)])];
  if (!isos.length) return '';
  // Countries listed only by some of their regions read "parts of …" (codes stay as they are).
  const names = isos.map((iso) => `${whole.includes(iso) ? '' : 'parts of '}${countryName.get(iso) ?? iso}`);
  const long = isos.length > 4 || names.join(', ').length > 48;
  return `<p class="pc-countries">${esc((long ? isos : names).join(', '))}</p>`;
}

// ── Packing ────────────────────────────────────────────────
// Cards go into columns so that no column is much longer than the others: biggest cards first into
// the shortest column, then cards are swapped or moved between the longest and shortest column while
// that shortens the longest one. Each column is then put in the chosen order, top to bottom.
function pack(items, cols, gap) {
  const columns = Array.from({ length: cols }, () => ({ items: [], h: 0 }));
  const add = (c, it) => { c.items.push(it); c.h += it.h + (c.items.length > 1 ? gap : 0); };
  const height = (list) => list.reduce((a, it) => a + it.h, 0) + Math.max(0, list.length - 1) * gap;
  for (const it of [...items].sort((a, b) => b.h - a.h)) add(columns.reduce((m, c) => (c.h < m.h ? c : m)), it);
  for (let round = 0; round < 500; round++) {
    columns.forEach((c) => { c.h = height(c.items); });
    const long = columns.reduce((m, c) => (c.h > m.h ? c : m));
    const short = columns.reduce((m, c) => (c.h < m.h ? c : m));
    if (long === short) break;
    let best = null, bestMax = long.h;
    for (const a of long.items) {
      // move a
      const m1 = Math.max(height(long.items.filter((x) => x !== a)), height([...short.items, a]));
      if (m1 < bestMax - 0.01) { bestMax = m1; best = [a, null]; }
      for (const b of short.items) {
        if (b.h >= a.h) continue;
        const m2 = Math.max(height([...long.items.filter((x) => x !== a), b]), height([...short.items.filter((x) => x !== b), a]));
        if (m2 < bestMax - 0.01) { bestMax = m2; best = [a, b]; }
      }
    }
    if (!best) break;
    const [a, b] = best;
    long.items = long.items.filter((x) => x !== a);
    short.items.push(a);
    if (b) { short.items = short.items.filter((x) => x !== b); long.items.push(b); }
  }
  columns.forEach((c) => { c.items.sort((x, y) => x.rank - y.rank); c.h = height(c.items); });
  return columns;
}

function sheetSizes() {
  const sizes = P.paper === 'auto' ? Object.keys(PAPER) : [P.paper];
  return sizes.flatMap((name) => {
    const [w, h] = PAPER[name] ?? PAPER.A1;
    return [{ name, orient: 'portrait', w, h }, { name, orient: 'landscape', w: h, h: w }];
  });
}

// Smallest paper (and orientation) where everything fits on one sheet; else several sheets of the
// largest allowed size.
function layout(items) {
  const cw = P.cardWidth, g = P.gap, m = P.margin;
  const tryOn = (sz, list) => {
    const cols = Math.floor((sz.w - 2 * m + g) / (cw + g));
    if (cols < 1) return null;
    const columns = pack(list, cols, g);
    const used = Math.max(...columns.map((c) => c.h));
    return { ...sz, cols, columns, used, avail: sz.h - 2 * m - P.header };
  };
  const fits = sheetSizes().map((sz) => tryOn(sz, items)).filter((r) => r && r.used <= r.avail);
  if (fits.length) {
    // Smallest area first; between orientations, the one that fills its height better.
    fits.sort((a, b) => a.w * a.h - b.w * b.h || b.used / b.avail - a.used / a.avail);
    return [fits[0]];
  }
  const sizes = sheetSizes();
  const big = sizes[sizes.length - 2]; // largest paper, portrait
  const total = items.reduce((a, it) => a + it.h + g, 0);
  const one = tryOn(big, items.slice(0, 1));
  for (let n = Math.max(2, Math.ceil(total / (one.cols * one.avail))); n < 50; n++) {
    // Split the cards (in order) into n groups of about equal height, and check each group fits.
    const ordered = [...items].sort((a, b) => a.rank - b.rank);
    const groups = Array.from({ length: n }, () => []);
    let acc = 0;
    for (const it of ordered) { groups[Math.min(n - 1, Math.floor((acc / total) * n))].push(it); acc += it.h + g; }
    const sheets = groups.map((gr) => tryOn(big, gr));
    if (sheets.every((s) => s.used <= s.avail)) return sheets;
  }
  return [tryOn(big, items)];
}

// ── Building the page ──────────────────────────────────────
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function ordered(types) {
  const by = {
    family: (a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id),
    'west-east': (a, b) => a.lon - b.lon,
    id: (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }),
  };
  if (P.order === 'random') {
    const r = rng(P.seed ?? 1);
    return types.map((t) => [r(), t]).sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  }
  return [...types].sort(by[P.order] ?? by.family);
}

let building = 0, info = '';
async function build() {
  const run = ++building;
  $('p-info').textContent = 'Laying out…';
  const types = ordered(state.types.filter((t) => !P.onlyImages || state.images?.has(t.id)));
  const scale = P.cardWidth / (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-width')) * MM);
  document.documentElement.style.setProperty('--pc-zoom', scale);
  document.documentElement.style.setProperty('--pc-width', `${P.cardWidth}mm`);
  document.documentElement.style.setProperty('--pc-gap', `${P.gap}mm`);

  // Lay the cards out in one column first to measure them.
  const sheets = $('sheets');
  sheets.innerHTML = '<div class="pc-measure"></div>';
  const measure = sheets.firstChild;
  const cards = [];
  for (const t of types) {
    const el = await buildCard(t);
    if (run !== building) return;
    measure.append(el);
    cards.push(el);
  }
  await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (run !== building) return;
  const items = cards.map((el, rank) => ({ el, rank, h: el.getBoundingClientRect().height * MM }));
  const result = layout(items);

  sheets.innerHTML = '';
  const { w, h } = result[0];
  setPageSize(w, h);
  result.forEach((sheet, i) => {
    const s = document.createElement('section');
    s.className = 'sheet';
    s.style.width = `${w}mm`; s.style.height = `${h}mm`; s.style.padding = `${P.margin}mm`;
    const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    s.innerHTML = `<header class="sheet-head" style="height:${P.header}mm"><span class="sheet-title">${esc(P.title)}</span>
      <span>${types.length} types${result.length > 1 ? ` · sheet ${i + 1} of ${result.length}` : ''} · ${esc(date)}</span></header>
      <div class="sheet-cols"></div>`;
    const colsEl = s.querySelector('.sheet-cols');
    for (const c of sheet.columns) {
      const col = document.createElement('div');
      col.className = 'pc-col';
      for (const it of c.items) col.append(it.el);
      colsEl.append(col);
    }
    sheets.append(s);
  });
  info = `${types.length} cards · ${result.length > 1 ? `${result.length} sheets of ` : ''}${result[0].name} ${result[0].orient} · ${result[0].cols} columns`;
  $('p-info').textContent = info;
  fitPreview();
}

function setPageSize(w, h) {
  let st = $('page-size');
  if (!st) { st = document.createElement('style'); st.id = 'page-size'; document.head.append(st); }
  st.textContent = `@page { size: ${w}mm ${h}mm; margin: 0; }`;
}
// On screen, shrink the sheets to the window width.
function fitPreview() {
  const s = document.querySelector('.sheet');
  if (!s) return;
  const z = Math.min(1, (window.innerWidth - 48) / (s.offsetWidth || 1));
  document.documentElement.style.setProperty('--preview', z);
}
window.addEventListener('resize', fitPreview);

// ── Settings bar ───────────────────────────────────────────
$('p-style').innerHTML = lib.styles.map((s) => `<option${s.name === styleName ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
$('p-order').value = P.order;
$('p-paper').value = P.paper;
$('p-width').value = P.cardWidth;
$('p-images').checked = P.onlyImages;
$('p-empty').checked = P.emptyImages;
$('p-style').addEventListener('change', (e) => { applyStyle(e.target.value); build(); });
$('p-order').addEventListener('change', (e) => { P.order = e.target.value; if (P.order === 'random') P.seed = Math.floor(Math.random() * 1e9); build(); });
$('p-paper').addEventListener('change', (e) => { P.paper = e.target.value; build(); });
$('p-width').addEventListener('change', (e) => { P.cardWidth = Number(e.target.value) || 85; build(); });
$('p-images').addEventListener('change', (e) => { P.onlyImages = e.target.checked; build(); });
$('p-empty').addEventListener('change', (e) => { P.emptyImages = e.target.checked; build(); });
$('p-print').addEventListener('click', async () => {
  $('p-info').textContent = 'Waiting for pictures…';
  await Promise.all([...document.images].map((img) => (img.complete ? null
    : new Promise((r) => { img.addEventListener('load', r); img.addEventListener('error', r); }))));
  $('p-info').textContent = info;
  window.print();
});

await build();

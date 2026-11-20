// Shared by the map (js/app.js) and the print page (js/print.js): reading the sheet, placing
// name dots, working out a type's areas, and drawing a type's card.
// createCore(CONFIG, view) returns the shared state and functions.
export function createCore(CONFIG, V) {
  const state = {
    types: [],            // all parsed types
    byId: new Map(),
    cases: new Map(),     // case ID -> row object
    caseHeaders: [],
    countryBoxes: new Map(), // iso -> { a: [w,s,e,n], b: [w,s,e,n] } (b = longitudes 0..360)
    selected: null,
    onlyStories: false,
    onlyImages: false,
    images: null,         // Set of type IDs that have an image (from data/images.json)
    problems: [],         // things in the sheet the map could not use; shown under the hearth count
  };
  const problem = (text) => { if (!state.problems.includes(text)) state.problems.push(text); console.warn(text); };

  // An error with a short code and a plain explanation; the pages show it as "E3 · …".
  function fail(code, text) {
    const err = new Error(text);
    err.code = code;
    return err;
  }

  // ── Helpers ────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const splitList = (s) => String(s ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

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

  // tab: 'Types', 'Cases' or 'Names', only used to word the error.
  async function loadCSV(url, tab = 'sheet') {
    let res;
    try { res = await fetch(url, { cache: 'no-store' }); } catch {
      throw fail('E2', `Could not reach the ${tab} tab of the Google Sheet. Check the internet connection, then the link in js/config.js → data.`);
    }
    if (!res.ok) throw fail('E2', `Google answered ${res.status} for the ${tab} tab. Check its link in js/config.js → data.`);
    const text = await res.text();
    // An unpublished or private sheet answers with a web page (sign-in or error) instead of CSV.
    if (/^\s*<(!doctype|html)/i.test(text)) {
      throw fail('E3', `The ${tab} tab did not come back as data. The sheet is probably no longer published: in Google Sheets use File → Share → Publish to web.`);
    }
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' });
    return { rows: parsed.data, headers: parsed.meta.fields ?? [] };
  }

  // ── Data ───────────────────────────────────────────────────
  function parseTypes({ rows, headers }) {
    const c = resolveColumns(headers, CONFIG.typeColumns);
    if (!c.id) throw fail('E4', `The Types tab has no "${CONFIG.typeColumns.id}" column, so no hearths can be read. Check the header row of the sheet, or typeColumns in js/config.js.`);
    for (const [k, v] of Object.entries(c)) if (!v) problem(`Types tab: column "${CONFIG.typeColumns[k]}" not found (was it renamed?)`);
    const get = (row, key) => (c[key] ? String(row[c[key]] ?? '').trim() : '');

    const types = [];
    for (const row of rows) {
      const id = get(row, 'id');
      if (!id) continue;
      const lat = parseFloat(get(row, 'lat'));
      const lon = parseFloat(get(row, 'lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) { problem(`${id}: left off the map, no usable centre latitude and longitude`); continue; }
      if (types.some((t) => t.id === id)) { problem(`${id}: this ID appears on more than one row; only the first is used`); continue; }
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
    for (const k of ['type', 'name', 'where']) if (!c[k]) problem(`Names tab: column "${CONFIG.nameColumns[k]}" not found (was it renamed?)`);
    const get = (row, key) => (c[key] ? String(row[c[key]] ?? '').trim() : '');
    for (const row of rows) {
      const t = state.byId.get(get(row, 'type'));
      const name = get(row, 'name');
      if (!t && name && get(row, 'type')) problem(`Names tab: "${name}" is given to ${get(row, 'type')}, which is not in the Types tab`);
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
  // Where a name's dot goes: first the name's own coordinates; then the type's centre if it lies in one
  // of the name's countries (country codes only); otherwise one dot in the middle of all its areas (if that middle falls inside
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

  // "55.5° N, 23.3° E"
  function latLon(lat, lon) {
    return `${Math.abs(lat)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon)}° ${lon < 0 ? 'W' : 'E'}`;
  }

  function parseCases({ rows, headers }) {
    const c = resolveColumns(headers, CONFIG.caseColumns);
    if (headers.length) for (const k of ['id', 'title', 'story']) if (!c[k]) problem(`Cases tab: column "${CONFIG.caseColumns[k]}" not found (was it renamed?)`);
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
      // dirs: 36 yes/no slots, one per 10° of direction from the country's centre, true where a listed
      // border lies. (The file packs them into one number of up to 36 binary digits; they are unpacked by
      // division because JavaScript's bit operators only keep 32 digits.)
      let total = 0, shared = 0;
      const dirs = new Array(36).fill(false);
      for (const [n, [len, bits]] of Object.entries(neighbours)) {
        total += len;
        if (!set.has(n)) continue;
        shared += len;
        for (let i = 0; i < 36; i++) if (Math.floor(bits / 2 ** i) % 2) dirs[i] = true;
      }
      if (!total || shared / total < CONFIG.inferGaps.share) continue;
      let run = 0, widest = 0;
      for (let i = 0; i < 72; i++) { if (dirs[i % 36]) run = 0; else widest = Math.max(widest, ++run); }
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

  const isStandout = (id) => CONFIG.standout?.ids?.includes(id);

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

  function renderType(t, nameIndex, body) {
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
    const old = body.querySelector('.type-image');
    const keep = old?.dataset.id === t.id ? old : null; // same type: keep its image, no reload
    body.innerHTML = `
      <figure class="type-image" data-id="${esc(t.id)}"></figure>
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
      <p class="meta">${esc(t.id)} · ${latLon(t.lat, t.lon)}</p>`;
    if (keep) body.querySelector('.type-image').replaceWith(keep);
    else loadImage(t.id, body.querySelector('.type-image'));
  }

  function addCredit(id, figure) {
    const c = state.credits?.[id];
    if (!c) return;
    const cap = document.createElement('figcaption');
    const label = c.text ?? [c.author, c.licence].filter(Boolean).join(' · ');
    cap.innerHTML = c.source ? `<a href="${esc(c.source)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label);
    figure.append(cap);
  }
  function emptySlot(id, figure) {
    if (CONFIG.images.showEmptySlot) { figure.classList.add('empty'); figure.textContent = `no image yet · ${id}`; }
    else figure.remove();
  }
  // With the image index (data/images.json) the frame gets the image's exact proportions straight away,
  // so the text below never jumps; the image fades in when it arrives.
  function loadImage(id, figure) {
    if (state.imageIndex) {
      const info = state.imageIndex[id];
      if (!info) { emptySlot(id, figure); return; }
      const img = new Image();
      img.alt = '';
      img.width = info.w; img.height = info.h;
      img.className = 'loading';
      img.onload = () => img.classList.remove('loading');
      img.onerror = () => { if (figure.isConnected) { figure.replaceChildren(); emptySlot(id, figure); } };
      img.src = `${CONFIG.images.folder}${info.file}`;
      figure.replaceChildren(img);
      addCredit(id, figure);
      return;
    }
    // No index: try images/T014.jpg, .jpeg, .png, .webp in turn.
    const exts = [...CONFIG.images.extensions];
    const tryNext = () => {
      if (!figure.isConnected) return;
      const ext = exts.shift();
      if (!ext) {
        emptySlot(id, figure);
        return;
      }
      const img = new Image();
      img.alt = '';
      img.onload = () => {
        if (!figure.isConnected) return;
        figure.replaceChildren(img);
        addCredit(id, figure);
      };
      img.onerror = tryNext;
      img.src = `${CONFIG.images.folder}${id}.${ext}`;
    };
    tryNext();
  }

  // Area codes the map cannot draw, and stories that are linked but missing.
  function checkCodes() {
    // A code mapped to nothing in isoAliases (e.g. a tiny island) counts as known: it is skipped on purpose.
    const known = (code) => (isRegion(code)
      ? !state.regionIndex || code in state.regionIndex.names
      : expandIso([code]).every((iso) => state.countryShapes.has(iso)));
    for (const t of state.types) {
      const bad = [...new Set([...t.core, ...t.fringe, ...t.names.flatMap((n) => n.where)])].filter((c) => !known(c));
      if (bad.length) problem(`${t.id}: area code${bad.length > 1 ? 's' : ''} not recognised, so not shaded: ${bad.join(', ')}`);
      const lost = t.cases.filter((cid) => !state.cases.has(cid));
      if (lost.length && state.caseHeaders.length) problem(`${t.id}: linked stor${lost.length > 1 ? 'ies' : 'y'} not found in the Cases tab: ${lost.join(', ')}`);
    }
  }

  // Load the sheet (types, names, stories) and the shapes needed to place and shade types.
  // Returns the country shapes.
  async function loadData() {
    const [typesCSV, casesCSV, countries, namesCSV] = await Promise.all([
      loadCSV(CONFIG.data.types, 'Types'),
      loadCSV(CONFIG.data.cases, 'Cases').catch((err) => { problem(`Stories not loaded. ${err.code ?? ''} ${err.message}`); return { rows: [], headers: [] }; }),
      fetch(CONFIG.data.countries).then((r) => r.json()).catch(() => { throw fail('E5', `Could not load the country shapes (${CONFIG.data.countries}). The file is missing from the site or the connection dropped.`); }),
      (CONFIG.data.names ? loadCSV(CONFIG.data.names, 'Names') : Promise.resolve(null)).catch((err) => { problem(`Local names not loaded. ${err.code ?? ''} ${err.message}`); return null; }),
      fetch(CONFIG.data.labels).then((r) => r.json()).then((x) => { state.labels = x; }).catch(() => {}),
      fetch(CONFIG.data.credits, { cache: 'no-store' }).then((r) => r.json()).then((c) => { state.credits = c; }).catch(() => {}),
      fetch(CONFIG.data.borders).then((r) => r.json()).then((b) => { state.borders = b; }).catch(() => {}),
      fetch(`${CONFIG.data.regions}index.json`).then((r) => r.json()).then((x) => { state.regionIndex = x; }).catch(() => {}),
    ]);
    state.types = parseTypes(typesCSV);
    if (!state.types.length) throw fail('E4', 'The Types tab was read, but no row has both a Type ID and centre coordinates, so there is nothing to show.');
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
    checkCodes();
    return countries;
  }

  return {
    state, esc, splitList, resolveColumns, loadCSV, parseTypes, parseNames, pointInRing, pointInCountry, nameDot, nameIn, nameIndexFor, displayName, parseCases, computeCountryBoxes, union, inferredGaps, isRegion, countriesOf, regionsOf, expandIso, regionCountry, loadRegionFile, regionFeatures, featureBox, fitCountries, boxesFor, boundsFor, visibleTypes, rawDots, DOT_GAP, dotPositions, computeDotPositions, isStandout, latLon, gapsFor, renderType, addCredit, emptySlot, loadImage, loadData, fail,
  };
}

// Style versions: fonts and colours of the page and map, kept in data/styles.json.
// Visitors get the default version. With stylePanel on in js/config.js, a panel under the map
// controls lets you switch versions, change fonts and colours, and save new versions.

const LOCAL_KEY = 'atlas-of-warmth-styles';   // this browser: draft, version being viewed, unsynced versions
const TOKEN_KEY = 'atlas-of-warmth-token';    // the same GitHub token as the upload page
const PANEL_ALPHA = 0.92;                     // panels stay slightly see-through

const clone = (x) => JSON.parse(JSON.stringify(x));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const readLocal = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) ?? {}; } catch { return {}; } };
const writeLocal = (x) => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(x)); } catch {} };
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };

// ── Library ────────────────────────────────────────────────
// With the panel on and a token saved, read the file straight from GitHub (the site lags a minute behind).
export async function loadLibrary(CONFIG) {
  const path = CONFIG.data.styles;
  let lib = null, sha = null;
  const token = CONFIG.stylePanel ? getToken() : null;
  if (token) {
    try {
      const { owner, repo, branch } = CONFIG.github;
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}&t=${Date.now()}`,
        { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` } });
      if (r.ok) { const f = await r.json(); sha = f.sha; lib = JSON.parse(base64ToText(f.content)); }
    } catch { /* fall back to the site copy */ }
  }
  if (!lib) {
    try { lib = await (await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' })).json(); } catch { lib = null; }
  }
  lib ??= { default: null, fonts: [], styles: [] };
  lib.fonts ??= []; lib.styles ??= [];
  if (CONFIG.stylePanel) {
    // Versions and fonts saved in this browser only (no token at the time) are added to the list.
    const local = readLocal();
    for (const s of local.styles ?? []) if (!lib.styles.some((x) => x.name === s.name)) lib.styles.push({ ...s, local: true });
    for (const f of local.fonts ?? []) if (!lib.fonts.some((x) => x.family === f.family)) lib.fonts.push({ ...f, local: true });
  }
  return { lib, sha };
}

// The version to show at start: the default, or (with the panel on) whatever you were last looking at.
export function startingStyle(lib, CONFIG) {
  const byName = (n) => lib.styles.find((s) => s.name === n);
  if (CONFIG.stylePanel) {
    const local = readLocal();
    if (local.viewing === '__draft' && local.draft) return local.draft.style;
    if (byName(local.viewing)) return byName(local.viewing);
  }
  return byName(lib.default) ?? lib.styles[0] ?? null;
}

// ── Applying a version ─────────────────────────────────────
const loadedFonts = new Set();
const primaryFamily = (stack) => (String(stack).match(/^\s*['"]?([^'",]+)['"]?/) ?? [])[1]?.trim() ?? '';

export function loadFont(font) {
  if (!font || loadedFonts.has(font.family)) return;
  loadedFonts.add(font.family);
  if (font.google) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`;
    document.head.append(link);
  } else if (font.file) {
    const st = document.createElement('style');
    st.textContent = `@font-face { font-family: '${font.family}'; src: url('${font.file}'); font-weight: 100 900; font-display: swap; }`;
    document.head.append(st);
  }
}

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function applyCss(style, fonts = []) {
  if (!style) return;
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(style.css ?? {})) {
    root.setProperty(k, k === '--panel-bg' ? hexToRgba(v, PANEL_ALPHA) : v);
    if (k.startsWith('--font-')) {
      // Load the first-choice font (and, for native names, every font in the list that we know).
      const names = k === '--font-native' ? v.split(',').map((x) => x.trim().replace(/['"]/g, '')) : [primaryFamily(v)];
      for (const n of names) loadFont(fonts.find((f) => f.family === n));
    }
  }
}

// ── The panel ──────────────────────────────────────────────
// Font roles shown in the panel: CSS variable for the font, plus optional weight and size variables.
const ROLES = [
  { label: 'Title', font: '--font-title', weight: '--weight-title', size: '--title-size' },
  { label: 'Type names', font: '--font-display', weight: '--weight-display', size: '--name-size' },
  { label: 'Text', font: '--font-body', weight: '--weight-body', size: '--body-size' },
  { label: 'Labels', font: '--font-label', weight: '--label-weight', size: '--label-size', caps: true },
  { label: 'Buttons', font: '--font-ui' },
  { label: 'Native names', font: '--font-native' },
];
const COLOURS = [
  { label: 'Text', key: '--ink' },
  { label: 'Text, dim', key: '--ink-dim' },
  { label: 'Text, faint', key: '--ink-faint' },
  { label: 'Panels', key: '--panel-bg' },
  { label: 'Panel lines', key: '--panel-line' },
  { label: 'Background', key: '--space' },
  { label: 'Sea', key: 'ocean', map: true },
  { label: 'Land', key: 'land', map: true },
  { label: 'Borders', key: 'border', map: true },
  { label: 'Widely used', key: 'core', map: true },
  { label: 'Less prevalent', key: 'fringe', map: true },
];
const NATIVE_TAIL = {
  serif: "'Noto Serif SC', 'Noto Serif JP', 'Noto Serif KR', 'Noto Serif Armenian', 'Noto Serif Georgian', 'Noto Serif Gurmukhi', 'Noto Serif Devanagari', 'Noto Naskh Arabic', 'Noto Sans Canadian Aboriginal', serif",
  other: "'Noto Sans SC', 'Noto Sans JP', 'Noto Sans KR', 'Noto Sans Armenian', 'Noto Sans Georgian', 'Noto Sans Gurmukhi', 'Noto Sans Devanagari', 'Noto Sans Arabic', 'Noto Sans Canadian Aboriginal', sans-serif",
};

export function initPanel({ CONFIG, lib, sha, current, setMapColours }) {
  const P = {
    lib, sha, token: getToken(),
    viewing: null,            // name of the saved version on screen, or '__draft'
    draft: null,              // { base, style } — changes not saved yet
    saving: false,
  };
  const local = readLocal();
  if (local.draft) P.draft = local.draft;
  P.viewing = local.viewing === '__draft' && P.draft ? '__draft' : current?.name ?? null;
  const shown = () => (P.viewing === '__draft' ? P.draft?.style : P.lib.styles.find((s) => s.name === P.viewing)) ?? P.lib.styles[0];

  // Build the panel under the map controls.
  const panel = document.createElement('section');
  panel.className = 'controls style-panel';
  panel.id = 'style-panel';
  document.body.append(panel);
  const controls = document.getElementById('controls');
  const place = () => {
    const r = controls.getBoundingClientRect();
    panel.style.top = `${r.bottom + 10}px`;
    panel.style.maxHeight = `${window.innerHeight - r.bottom - 26}px`;
  };
  new ResizeObserver(place).observe(controls);
  window.addEventListener('resize', place);

  const remember = () => writeLocal({
    ...readLocal(),
    viewing: P.viewing, draft: P.draft,
    styles: P.lib.styles.filter((s) => s.local).map(({ local: _, ...s }) => s),
    fonts: P.lib.fonts.filter((f) => f.local).map(({ local: _, ...f }) => f),
  });

  function show(style) {
    applyCss(style, P.lib.fonts);
    setMapColours({ ...(style.map ?? {}), space: style.css?.['--space'] });
  }

  // ── Rendering ──
  function render() {
    const open = readLocal().panelOpen !== false;
    const s = shown();
    const fontOptions = (value) => {
      const cur = primaryFamily(value);
      const list = P.lib.fonts.map((f) => f.family);
      if (cur && !list.includes(cur)) list.unshift(cur);
      return list.map((f) => `<option${f === cur ? ' selected' : ''}>${esc(f)}</option>`).join('');
    };
    panel.innerHTML = `
      <button type="button" class="sp-head" data-sp-toggle>Style <span>${open ? '−' : '+'}</span></button>
      <div class="sp-body" ${open ? '' : 'hidden'}>
        <span class="control-label">Versions</span>
        <div id="sp-versions-area">${versionsHtml()}</div>
        <p class="sp-note" id="sp-note">${P.token ? '' : 'No GitHub token in this browser: versions are saved here only. Add the token on the upload page to save them to the site.'}</p>
        ${editorHtml(s, fontOptions)}
      </div>`;
    place();
  }
  function renderVersions() { panel.querySelector('#sp-versions-area').innerHTML = versionsHtml(); place(); }
  function versionsHtml() {
    const versions = [
      ...(P.draft ? [`<li class="${P.viewing === '__draft' ? 'on' : ''} draft">
        <button type="button" data-sp-view="__draft">Unsaved changes <small>from ${esc(P.draft.base ?? 'scratch')}</small></button>
      </li>`] : []),
      ...P.lib.styles.map((v) => `<li class="${P.viewing === v.name ? 'on' : ''}">
        <button type="button" data-sp-view="${esc(v.name)}">${esc(v.name)}${v.name === P.lib.default ? ' <small>default</small>' : ''}${v.local ? ' <small>this browser</small>' : ''}</button>
        ${v.name !== P.lib.default ? `<button type="button" class="sp-x" data-sp-delete="${esc(v.name)}" title="Delete this version">×</button>` : ''}
      </li>`),
    ].join('');
    return `<ul class="sp-versions">${versions}</ul>
        ${P.draft ? `<div class="sp-save">
          <input type="text" id="sp-name" placeholder="Name for this version" value="">
          <div class="sp-row"><button type="button" class="sp-btn on" data-sp-save>Save</button><button type="button" class="sp-btn" data-sp-discard>Discard</button></div>
        </div>` : `<div class="sp-row">
          ${P.viewing !== P.lib.default ? '<button type="button" class="sp-btn" data-sp-default>Make default</button>' : ''}
        </div>`}`;
  }
  function editorHtml(s, fontOptions) {
    const accent = s.css?.['--accent'] ?? '#f52261';
    return `
        <label class="sp-colour sp-accent"><span class="control-label">Accent</span><input type="color" data-sp-colour="--accent" value="${esc(accent)}"><code>${esc(accent)}</code></label>
        <details class="sp-more"><summary class="control-label">More colours</summary>
          ${COLOURS.map((c) => {
            const v = (c.map ? s.map?.[c.key] : s.css?.[c.key]) ?? '#000000';
            return `<label class="sp-colour"><span>${c.label}</span><input type="color" data-sp-colour="${c.key}" ${c.map ? 'data-sp-map' : ''} value="${esc(v)}"></label>`;
          }).join('')}
        </details>

        <span class="control-label sp-gap">Fonts</span>
        ${ROLES.map((r) => `<div class="sp-role">
          <span>${r.label}</span>
          <select data-sp-font="${r.font}">${fontOptions(s.css?.[r.font])}</select>
          ${r.weight ? `<input type="number" min="100" max="900" step="100" title="Weight" data-sp-num="${r.weight}" value="${parseInt(s.css?.[r.weight] ?? 400)}">` : ''}
          ${r.size ? `<input type="number" min="6" max="80" step="0.5" title="Size (px)" data-sp-num="${r.size}" data-unit="px" value="${parseFloat(s.css?.[r.size] ?? 14)}">` : ''}
          ${r.caps ? `<label class="sp-caps check"><input type="checkbox" data-sp-caps ${s.css?.['--label-case'] === 'uppercase' ? 'checked' : ''}> Capitals</label>
            <label class="sp-caps">Spacing <input type="number" min="0" max="0.5" step="0.01" data-sp-num="--label-tracking" data-unit="em" value="${parseFloat(s.css?.['--label-tracking'] ?? 0)}"></label>` : ''}
        </div>`).join('')}
        <details class="sp-more"><summary class="control-label">Add a font</summary>
          <p class="sp-note">Google font: paste its name or its page link (fonts.google.com/specimen/…).</p>
          <div class="sp-row"><input type="text" id="sp-google" placeholder="e.g. Inter Tight"><button type="button" class="sp-btn" data-sp-add-google>Add</button></div>
          <p class="sp-note">Font file: put it in the fonts/ folder of the repository, then type its file name.</p>
          <div class="sp-row"><input type="text" id="sp-file" placeholder="e.g. MyFont-Regular.woff2"><button type="button" class="sp-btn" data-sp-add-file>Add</button></div>
        </details>`;
  }

  // ── Editing ──
  // Any change goes into the draft; the saved versions stay as they are.
  function edit(fn) {
    if (P.draft && P.viewing !== '__draft') {
      if (!confirm(`You have unsaved changes (from "${P.draft.base}"). Replace them with changes to "${P.viewing}"?`)) { render(); return; }
      P.draft = null;
    }
    if (!P.draft) {
      const base = shown();
      const { local: _, ...copy } = clone(base);
      P.draft = { base: base.name, style: { ...copy, name: 'Unsaved changes' } };
      P.viewing = '__draft';
      fn(P.draft.style);
      show(P.draft.style); remember(); renderVersions(); // keep the inputs (an open colour picker) as they are
      return;
    }
    fn(P.draft.style);
    show(P.draft.style); remember();
  }

  panel.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.spColour) {
      const v = t.value;
      edit((s) => { if (t.hasAttribute('data-sp-map')) (s.map ??= {})[t.dataset.spColour] = v; else (s.css ??= {})[t.dataset.spColour] = v; });
      const code = t.parentElement.querySelector('code'); if (code) code.textContent = v;
    } else if (t.dataset.spNum) {
      if (t.value === '') return;
      edit((s) => { s.css[t.dataset.spNum] = `${t.value}${t.dataset.unit ?? ''}`; });
    }
  });
  panel.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.spFont) {
      const font = P.lib.fonts.find((f) => f.family === t.value);
      const fallback = font?.fallback ?? 'sans-serif';
      const stack = t.dataset.spFont === '--font-native'
        ? `'${t.value}', ${fallback === 'serif' ? NATIVE_TAIL.serif : NATIVE_TAIL.other}`
        : `'${t.value}', ${fallback}`;
      edit((s) => { s.css[t.dataset.spFont] = stack; });
    } else if (t.hasAttribute('data-sp-caps')) {
      edit((s) => { s.css['--label-case'] = t.checked ? 'uppercase' : 'none'; });
    }
  });

  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'sp-name') save();
    if (e.target.id === 'sp-google') addGoogle();
    if (e.target.id === 'sp-file') addFile();
  });
  panel.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    e.stopPropagation();
    if (t.hasAttribute('data-sp-toggle')) {
      const body = panel.querySelector('.sp-body');
      body.hidden = !body.hidden;
      t.querySelector('span').textContent = body.hidden ? '+' : '−';
      writeLocal({ ...readLocal(), panelOpen: !body.hidden });
      place();
    }
    if (t.dataset.spView) { P.viewing = t.dataset.spView; show(shown()); remember(); render(); }
    if (t.hasAttribute('data-sp-discard')) {
      const base = P.draft?.base;
      P.draft = null;
      if (P.viewing === '__draft') P.viewing = P.lib.styles.some((s) => s.name === base) ? base : P.lib.default;
      show(shown()); remember(); render();
    }
    if (t.hasAttribute('data-sp-save')) save();
    if (t.hasAttribute('data-sp-default')) {
      P.lib.default = P.viewing;
      await persist(`Default style: ${P.viewing}`); render();
    }
    if (t.dataset.spDelete) {
      const name = t.dataset.spDelete;
      if (!confirm(`Delete the version "${name}"?`)) return;
      P.lib.styles = P.lib.styles.filter((s) => s.name !== name);
      if (P.viewing === name) { P.viewing = P.lib.default; show(shown()); }
      remember();
      await persist(`Delete style ${name}`); render();
    }
    if (t.hasAttribute('data-sp-add-google')) addGoogle();
    if (t.hasAttribute('data-sp-add-file')) addFile();
  });

  async function save() {
    const input = panel.querySelector('#sp-name');
    const name = input?.value.trim();
    if (!name) { input?.focus(); note('Type a name first.'); return; }
    if (name === 'Unsaved changes' || name.startsWith('__')) { note('Pick another name.'); return; }
    const existing = P.lib.styles.findIndex((s) => s.name === name);
    if (existing >= 0 && !confirm(`Replace the version "${name}"?`)) return;
    const style = { ...clone(P.draft.style), name, ...(P.token ? {} : { local: true }) };
    if (existing >= 0) P.lib.styles[existing] = style; else P.lib.styles.push(style);
    P.draft = null; P.viewing = name;
    remember(); render();
    await persist(`Save style ${name}`);
    render();
  }

  // ── Fonts ──
  // Google's font address needs the exact weights a font has, so try the usual ranges until one works.
  async function addGoogle() {
    const input = panel.querySelector('#sp-google');
    const raw = input.value.trim();
    if (!raw) return;
    let families = [];
    const fam = /[?&]family=([^&]+)/g;
    if (/fonts\.googleapis\.com/.test(raw)) {
      for (const m of raw.matchAll(fam)) families.push({ family: decodeURIComponent(m[1].split(':')[0].replace(/\+/g, ' ')), google: m[1] });
    } else {
      const m = /specimen\/([^/?#]+)/.exec(raw);
      const family = decodeURIComponent((m ? m[1] : raw).replace(/\+/g, ' ')).trim();
      note(`Looking up ${family}…`);
      const enc = family.replace(/ /g, '+');
      const tries = ['ital,wght@0,100..900;1,100..900', 'wght@100..900', 'ital,wght@0,200..800;1,200..800', 'wght@200..800',
        'ital,wght@0,300..700;1,300..700', 'wght@300..700', 'ital,wght@0,400;0,700;1,400;1,700', 'wght@400;700', ''];
      let found = null;
      for (const t of tries) {
        const spec = t ? `${enc}:${t}` : enc;
        try {
          const r = await fetch(`https://fonts.googleapis.com/css2?family=${spec}&display=swap`);
          if (r.ok) { found = spec; break; }
        } catch { /* try the next */ }
      }
      if (!found) { note(`Google Fonts has no font called "${family}". Check the spelling (capitals count).`); return; }
      families = [{ family, google: found }];
    }
    for (const f of families) {
      const fallback = /serif/i.test(f.family) && !/sans/i.test(f.family) ? 'serif' : /mono/i.test(f.family) ? 'monospace' : 'sans-serif';
      addFont({ ...f, fallback });
    }
    input.value = '';
  }
  function addFile() {
    const input = panel.querySelector('#sp-file');
    const file = input.value.trim().replace(/^\/?fonts\//, '');
    if (!file) return;
    const family = file.replace(/\.(woff2?|ttf|otf)$/i, '').replace(/[-_](regular|variable|vf)$/i, '').replace(/[-_]/g, ' ');
    addFont({ family, file: `fonts/${file}`, fallback: 'sans-serif' });
    input.value = '';
  }
  async function addFont(font) {
    if (P.lib.fonts.some((f) => f.family === font.family)) { note(`${font.family} is already in the list.`); return; }
    P.lib.fonts.push(P.token ? font : { ...font, local: true });
    loadFont(font);
    remember(); render();
    note(`${font.family} added: pick it from a font list.`);
    await persist(`Add font ${font.family}`);
  }

  // ── Saving to the site ──
  function note(text) { const n = panel.querySelector('#sp-note'); if (n) n.textContent = text; }
  async function persist(message) {
    if (!P.token) { note('Saved in this browser only (no GitHub token here).'); return; }
    note('Saving to the site…');
    const { owner, repo, branch } = CONFIG.github;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${CONFIG.data.styles}`;
    const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${P.token}` };
    const strip = (arr) => arr.map(({ local: _, ...x }) => x);
    const body = { default: P.lib.default, fonts: strip(P.lib.fonts), styles: strip(P.lib.styles) };
    try {
      // Always write over the latest copy (its sha), so a stale page cannot fail to save.
      const cur = await fetch(`${url}?ref=${branch}&t=${Date.now()}`, { headers });
      if (cur.ok) P.sha = (await cur.json()).sha;
      const r = await fetch(url, {
        method: 'PUT', headers,
        body: JSON.stringify({ message, branch, content: textToBase64(JSON.stringify(body, null, 2) + '\n'), ...(P.sha ? { sha: P.sha } : {}) }),
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.json().catch(() => ({}))).message ?? ''}`);
      P.sha = (await r.json()).content.sha;
      for (const x of [...P.lib.styles, ...P.lib.fonts]) delete x.local;
      remember();
      note('Saved to the site (live in about a minute).');
    } catch (err) {
      console.error(err);
      note(`Could not save to the site (${err.message}). It is kept in this browser.`);
      for (const x of [...P.lib.styles, ...P.lib.fonts]) x.local = true;
      remember();
    }
  }

  render();
}

function base64ToText(b64) { return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0))); }
function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Upload page: drop an image on a type → shrunk to JPG, renamed to the type ID,
// committed to the repository's images/ folder (or downloaded if no token is set).
// config.js is loaded with the same cache-busting query as this file.
const CONFIG = (await import(`./config.js${new URL(import.meta.url).search}`)).default;
// Same fonts and colours as the map: the default style version.
{
  const S = await import(`./styles.js${new URL(import.meta.url).search}`);
  const { lib } = await S.loadLibrary({ ...CONFIG, stylePanel: false });
  S.applyCss(S.startingStyle(lib, { stylePanel: false }), lib.fonts);
  S.reveal();
}

// Reading the sheet (with the same error codes as the map) is shared with the map: js/core.js.
const { createCore } = await import(`./core.js${new URL(import.meta.url).search}`);
const core = createCore(CONFIG, {});

const $ = (id) => document.getElementById(id);
const GH = CONFIG.github;
const UP = CONFIG.imageUpload;
const TOKEN_KEY = 'atlas-of-warmth-token';
const EXTS = CONFIG.images.extensions;
const folder = CONFIG.images.folder.replace(/\/$/, '');

const state = { types: [], existing: new Map(), credits: {}, token: null, queue: Promise.resolve(), pending: 0, failed: [] };
const CREDITS_PATH = CONFIG.data.credits;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

// Everything is saved to GitHub as soon as it happens, one change at a time. This queue runs the
// changes and keeps the line at the top up to date: saving / all saved / failed (with Retry).
// A job returns false when it failed; retry() runs it again.
function enqueue(job, retry, label) {
  state.pending++; showSaved();
  state.queue = state.queue.then(async () => {
    let ok = false;
    try { ok = (await job()) !== false; } catch (err) { console.error(err); }
    state.pending--;
    if (!ok && retry) state.failed.push({ retry, label });
    showSaved();
  });
}
function showSaved() {
  const el = $('saved');
  if (!el) return;
  if (state.pending) { el.innerHTML = `saving… ${state.pending > 1 ? `(${state.pending} left)` : ''}`; el.className = 'up-saved busy'; return; }
  if (state.failed.length) {
    el.innerHTML = `${state.failed.length} not saved (${esc(state.failed.map((f) => f.label).join(', '))}) <button type="button" id="retry">Retry</button>`;
    el.className = 'up-saved err';
    return;
  }
  el.innerHTML = state.token ? 'all changes saved · <button type="button" class="link" data-disconnect>disconnect</button>' : '';
  el.className = 'up-saved ok';
}
document.addEventListener('click', (e) => {
  if (e.target.id !== 'retry') return;
  const jobs = state.failed.splice(0);
  jobs.forEach((f) => f.retry());
  showSaved();
});
// Leaving while something is still saving (or a credit is being edited) asks first.
window.addEventListener('beforeunload', (e) => {
  if (state.pending || document.querySelector('.up-credit-edit:not([hidden])')) { e.preventDefault(); e.returnValue = ''; }
});

// persist: stays until replaced (for problems the user has to act on).
function message(text, persist = false) {
  const m = $('message'); m.textContent = text; m.hidden = !text;
  if (text && !persist) setTimeout(() => { if (m.textContent === text) m.hidden = true; }, 5000);
}

// ── GitHub ─────────────────────────────────────────────────
async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
  if (res.status === 401 && state.token) tokenRejected();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`${res.status} ${body.message ?? res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

async function loadExisting() {
  state.existing.clear();
  try {
    const files = await gh(`/contents/${folder}?ref=${GH.branch}&t=${Date.now()}`);
    for (const f of files) {
      const m = f.name.match(/^(.+)\.([a-z0-9]+)$/i);
      if (!m || !EXTS.includes(m[2].toLowerCase())) continue;
      if (!state.existing.has(m[1])) state.existing.set(m[1], []);
      state.existing.get(m[1]).push({ name: f.name, sha: f.sha });
    }
  } catch (err) {
    console.warn('Could not list images:', err);
  }
}

// GitHub refused the token (expired, revoked or mistyped): forget it and say so until a new one is added.
function tokenRejected() {
  state.token = null;
  setToken(null);
  showConnected(false);
  message('The saved GitHub token no longer works: it has probably expired or been revoked. ' +
    'Make a new one (see "How to make a token" above) and paste it in; until then nothing can be saved to the site.', true);
}
// Check a saved token when the page opens, before anything relies on it.
async function checkToken() {
  try {
    const repo = await gh('');
    if (!repo.permissions?.push) message('The saved GitHub token can read the repository but not write to it: images cannot be saved. Make a token with "Contents: Read and write".', true);
  } catch (err) {
    if (state.token) message(`Could not check the GitHub token (${err.message}). Saving may not work.`, true); // 401 is handled in gh()
  }
}

async function connect(token) {
  state.token = token;
  try {
    const repo = await gh('');
    if (!repo.permissions?.push) throw new Error('this token cannot write to the repository');
    setToken(token);
    showConnected(true);
    message('Connected.');
  } catch (err) {
    state.token = null;
    message(`Could not connect: ${err.message}`);
  }
}
function showConnected(on) {
  setTimeout(showSaved);
  $('connect-off').hidden = on;
  $('connect-on').hidden = !on;
  $('repo-name').textContent = `${GH.owner}/${GH.repo}/${folder}`;
}

// ── Credits (data/credits.json) ────────────────────────────
function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function base64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
async function loadCredits() {
  try {
    if (state.token) {
      const f = await gh(`/contents/${CREDITS_PATH}?ref=${GH.branch}&t=${Date.now()}`);
      state.credits = JSON.parse(base64ToText(f.content));
    } else {
      state.credits = await (await fetch(`${CREDITS_PATH}?t=${Date.now()}`)).json();
    }
  } catch { state.credits = {}; }
}
// ── Saving: one commit per change ──────────────────────────
// Each change (an image with its size and credit, a removal, a credit edit) is saved as a single commit,
// so the image, data/images.json and data/credits.json never get out of step, and the site rebuilds once.
// GitHub's Git data API: new file contents (blobs) → a new file tree on top of the latest commit → a commit
// → move the branch to it. If something else was committed in between, it starts again from the latest.
//   files: { path: Blob or text to write, or null to delete }
//   json:  { path: (latest contents) => new contents } for data files merged with their latest copy;
//          a file whose contents do not change is left out.
// Returns { blobs: { path: sha }, data: { path: new contents } }.
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
async function readJson(path, ref) {
  try { return JSON.parse(base64ToText((await gh(`/contents/${path}?ref=${ref}`)).content)); }
  catch (err) { if (/^404/.test(err.message)) return {}; throw err; }
}
async function commit(message, { files = {}, json = {} } = {}) {
  const blobs = {};
  for (const [path, value] of Object.entries(files)) {
    if (value === null) continue;
    const content = value instanceof Blob ? await toBase64(value) : textToBase64(value);
    blobs[path] = (await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content, encoding: 'base64' }) })).sha;
  }
  for (let attempt = 1; ; attempt++) {
    const base = (await gh(`/git/ref/heads/${GH.branch}`)).object.sha;
    const baseTree = (await gh(`/git/commits/${base}`)).tree.sha;
    const tree = Object.entries(files).map(([path, value]) => ({ path, mode: '100644', type: 'blob', sha: value === null ? null : blobs[path] }));
    const data = {};
    for (const [path, change] of Object.entries(json)) {
      const current = await readJson(path, base);
      data[path] = sortKeys(change({ ...current }));
      if (JSON.stringify(data[path]) !== JSON.stringify(sortKeys(current))) {
        tree.push({ path, mode: '100644', type: 'blob', content: JSON.stringify(data[path], null, 2) + '\n' });
      }
    }
    if (!tree.length) return { blobs, data };
    const newTree = (await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) })).sha;
    const created = (await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree, parents: [base] }) })).sha;
    try {
      await gh(`/git/refs/heads/${GH.branch}`, { method: 'PATCH', body: JSON.stringify({ sha: created, force: false }) });
      return { blobs, data };
    } catch (err) {
      if (!/^422/.test(err.message) || attempt >= 3) throw err; // 422: the branch moved on meanwhile; try again
    }
  }
}
const withCredit = (id, credit) => (d) => { if (credit) d[id] = credit; else delete d[id]; return d; };

const creditText = (c) => (!c ? '' : c.text ?? [c.author, c.licence].filter(Boolean).join(' · '));

// ── Wikimedia Commons ──────────────────────────────────────
// Commons credits are HTML; some templates repeat their text in hidden parts ("Unknown authorUnknown author").
function stripHtml(html) {
  const body = new DOMParser().parseFromString(String(html ?? ''), 'text/html').body;
  body.querySelectorAll('[style*="display:none"], [style*="display: none"], .fn-hidden, .mw-hidden').forEach((x) => x.remove());
  const text = body.textContent.trim().replace(/\s+/g, ' ');
  const half = text.length / 2;
  return Number.isInteger(half) && text.slice(0, half) === text.slice(half) ? text.slice(0, half) : text;
}
async function commonsQuery(params) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  Object.entries({ action: 'query', format: 'json', origin: '*', prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime', iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|ObjectName', ...params })
    .forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Commons ${res.status}`);
  const pages = Object.values((await res.json()).query?.pages ?? {});
  return pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((p) => {
    const ii = p.imageinfo?.[0] ?? {};
    const m = ii.extmetadata ?? {};
    return {
      title: p.title,
      thumb: ii.thumburl ?? ii.url,
      url: ii.url,
      page: ii.descriptionurl,
      mime: ii.mime,
      author: stripHtml(m.Artist?.value) || 'Unknown author',
      licence: stripHtml(m.LicenseShortName?.value),
      licenceUrl: m.LicenseUrl?.value ?? '',
      name: stripHtml(m.ObjectName?.value) || p.title.replace(/^File:/, ''),
    };
  }).filter((r) => /^image\/(jpeg|png|webp|tiff|gif)/.test(r.mime ?? ''));
}
// Commons search only matches files whose own page has every word, so a lot is missed. Good pictures
// are often filed in categories instead ("Category:Russian stoves"), so categories matching the words
// are searched too and their files added. A search with no hits is tried again with any of the words.
const commonsFiles = (q, limit) => commonsQuery({
  generator: 'search', gsrsearch: `${q} filetype:bitmap`, gsrnamespace: 6, gsrlimit: limit, iiurlwidth: 360,
});
const commonsCategoryFiles = (cat, limit) => commonsQuery({
  generator: 'categorymembers', gcmtitle: cat, gcmtype: 'file', gcmlimit: limit, iiurlwidth: 360,
});
async function commonsCategories(q, limit = 4) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  Object.entries({ action: 'query', format: 'json', origin: '*', list: 'search', srsearch: q, srnamespace: 14, srlimit: limit })
    .forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) return [];
  return ((await res.json()).query?.search ?? []).map((r) => r.title);
}
async function commonsSearch(q, limit, picker) {
  const [files, cats] = await Promise.all([commonsFiles(q, limit).catch(() => []), commonsCategories(q).catch(() => [])]);
  if (picker && cats.length) addCategoryChips(picker, cats);
  const fromCats = cats.length ? await commonsCategoryFiles(cats[0], limit).catch(() => []) : [];
  let list = interleave([files, fromCats]);
  if (!list.length && /\s/.test(q)) list = await commonsFiles(q.split(/\s+/).join(' OR '), limit).catch(() => []);
  return list;
}
function interleave(lists) {
  const out = [], seen = new Set();
  for (let i = 0; lists.some((l) => l[i]); i++) for (const l of lists) if (l[i] && !seen.has(l[i].title)) { seen.add(l[i].title); out.push(l[i]); }
  return out;
}
function addCategoryChips(picker, cats) {
  const box = picker.querySelector('.pk-cats');
  if (!box) return;
  const have = new Set([...box.querySelectorAll('[data-cat]')].map((b) => b.dataset.cat));
  const add = cats.filter((c) => !have.has(c));
  if (!add.length) return;
  box.hidden = false;
  box.insertAdjacentHTML('beforeend', add.map((c) => `<button type="button" class="pk-chip pk-cat" data-cat="${esc(c)}">${esc(c.replace(/^Category:/, ''))}</button>`).join(''));
}

// Searching elsewhere: Google has no free image search for programs any more (its search API is
// closed to new users and ends in January 2027), so these open Google in a new tab with the words filled in.
const googleImages = (q, commonsOnly = false) =>
  `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(commonsOnly ? `${q} site:commons.wikimedia.org` : q)}`;

// A pasted link: a Commons file page (or its image address) brings its own picture and credit.
function commonsTitleFrom(link) {
  try {
    const u = new URL(link);
    if (/commons\.wikimedia\.org$/.test(u.hostname)) {
      const m = decodeURIComponent(u.pathname).match(/\/wiki\/(File:.+)$/) ?? [null, u.searchParams.get('title')];
      if (m[1]?.startsWith('File:')) return m[1].replace(/_/g, ' ');
      const hash = decodeURIComponent(u.hash).match(/#\/media\/(File:.+)$/);
      if (hash) return hash[1].replace(/_/g, ' ');
    }
    if (/upload\.wikimedia\.org$/.test(u.hostname)) {
      const parts = decodeURIComponent(u.pathname).split('/');
      const thumb = parts.indexOf('thumb');
      return `File:${(thumb >= 0 ? parts[thumb + 3] : parts[parts.length - 1]).replace(/_/g, ' ')}`;
    }
    if (/wikipedia\.org$/.test(u.hostname)) {
      const hash = decodeURIComponent(u.hash).match(/#\/media\/(?:File|[^:]+):(.+)$/);
      if (hash) return `File:${hash[1].replace(/_/g, ' ')}`;
      const m = decodeURIComponent(u.pathname).match(/\/wiki\/(?:File|[^:/]+):(.+\.(?:jpe?g|png|tiff?|webp|gif))$/i);
      if (m) return `File:${m[1].replace(/_/g, ' ')}`;
    }
  } catch { /* not a link */ }
  return null;
}
async function useLink(item, link) {
  const id = item.dataset.id;
  const status = item.querySelector('.up-status');
  const title = commonsTitleFrom(link);
  if (title) {
    status.textContent = 'reading Commons…'; status.className = 'up-status';
    const r = (await commonsQuery({ titles: title, iiurlwidth: 360 }).catch(() => []))[0];
    if (r) { pickResult(item, r); return; }
    status.textContent = 'Commons file not found'; status.className = 'up-status err';
    return;
  }
  // Any other image address: most sites do not let other pages download their pictures, so this
  // often fails; copying the picture itself (right-click → Copy image) and pasting it always works.
  status.textContent = 'fetching…'; status.className = 'up-status';
  try {
    const res = await fetch(link);
    const blob = await res.blob();
    if (!res.ok || !blob.type.startsWith('image/')) throw new Error();
    handleFile(id, new File([blob], `${id}.jpg`, { type: blob.type }));
  } catch {
    status.textContent = 'that site does not allow it: copy the image itself and paste it here'; status.className = 'up-status err';
  }
}
const commonsLarge = async (title) => (await commonsQuery({ titles: title, iiurlwidth: UP.maxSize }))[0];

const cleanQuery = (q) => String(q ?? '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

// ── Image processing ───────────────────────────────────────
async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, UP.maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // transparent PNGs get a white background
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', UP.quality));
  return { blob, w, h };
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function handleFile(id, file, credit = null) {
  if (!file?.type?.startsWith('image/')) { message(`${file?.name ?? 'That'} is not an image.`); return; }
  // A manual image takes the credit typed in its row (if any); a Commons image brings its own.
  if (!credit) {
    const row = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
    const typed = row?.querySelector('.credit-input')?.value.trim();
    const source = row?.querySelector('.source-input')?.value.trim();
    credit = typed ? { text: typed, ...(source ? { source } : {}) } : null;
  }
  const row = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const status = row?.querySelector('.up-status');
  const setStatus = (text, cls = '') => { if (status) { status.textContent = text; status.className = `up-status ${cls}`; } };
  setStatus('queued…');
  // One at a time: GitHub rejects simultaneous commits to the same branch.
  enqueue(async () => {
    try {
      setStatus('shrinking…');
      const { blob, w, h } = await shrink(file);
      const kb = Math.round(blob.size / 1024);
      const thumb = row?.querySelector('.up-thumb');
      if (thumb) thumb.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="">`;
      if (state.token) {
        setStatus('saving…');
        // The image, its entry in data/images.json and its credit (a new image without a credit drops the
        // old image's credit), plus the removal of any older version (e.g. T014.png), in one commit.
        const name = `${id}.jpg`;
        const old = state.existing.get(id) ?? [];
        const files = { [`${folder}/${name}`]: blob };
        for (const f of old) if (f.name !== name) files[`${folder}/${f.name}`] = null;
        const json = {
          [CONFIG.data.images]: (d) => ({ ...d, [id]: { file: name, w, h } }),
          ...(credit || state.credits[id] ? { [CREDITS_PATH]: withCredit(id, credit) } : {}),
        };
        const { blobs, data } = await commit(`${old.some((f) => f.name === name) ? 'Replace' : 'Add'} image ${name}`, { files, json });
        state.existing.set(id, [{ name, sha: blobs[`${folder}/${name}`] }]);
        if (data[CREDITS_PATH]) state.credits = data[CREDITS_PATH];
        setStatus(`saved · ${w}×${h} · ${kb} KB${credit ? '' : ' · no credit'}`, credit ? 'ok' : '');
        const cl = row?.querySelector('.up-credit');
        if (cl) cl.textContent = creditText(credit);
        const actions = row?.querySelector('.up-actions');
        if (actions && !actions.querySelector('.up-remove')) actions.insertAdjacentHTML('beforeend', imageButtons());
      } else {
        download(blob, `${id}.jpg`);
        setStatus(`downloaded · ${kb} KB${credit ? ' · credit: ' + creditText(credit) : ''}`, 'ok');
      }
      updateSummary();
    } catch (err) {
      console.error(err);
      setStatus(`failed: ${err.message}`, 'err');
      return false;
    }
  }, () => handleFile(id, file, credit), id);
}

// ── List ───────────────────────────────────────────────────
function findCol(headers, label) {
  const l = label.toLowerCase();
  return headers.find((h) => h.trim().toLowerCase() === l) ?? headers.find((h) => h.trim().toLowerCase().startsWith(l));
}

async function loadTypes() {
  const { rows: data, headers } = await core.loadCSV(CONFIG.data.types, 'Types');
  const c = Object.fromEntries(['id', 'family', 'name', 'translit', 'native', 'search', 'cases'].map((k) => [k, findCol(headers, CONFIG.typeColumns[k])]));
  if (!c.id) { const e = new Error(`The Types tab has no "${CONFIG.typeColumns.id}" column. Check the header row of the sheet, or typeColumns in js/config.js.`); e.code = 'E4'; throw e; }
  const v = (r, k) => (c[k] ? String(r[c[k]] ?? '').trim() : '');
  state.types = data
    .map((r) => ({ id: v(r, 'id'), family: v(r, 'family'), name: v(r, 'name'), translit: v(r, 'translit'), native: v(r, 'native'), search: v(r, 'search'),
      stories: (v(r, 'cases').match(new RegExp(CONFIG.caseIdPattern, 'g')) ?? []).length }))
    .filter((t) => t.id);
  // Local names from the Names tab: extra search words (another language may find what one does not).
  if (!CONFIG.data.names) return;
  try {
    const names = await core.loadCSV(CONFIG.data.names, 'Names');
    const n = Object.fromEntries(['type', 'name', 'native', 'language'].map((k) => [k, findCol(names.headers, CONFIG.nameColumns[k])]));
    const g = (r, k) => (n[k] ? String(r[n[k]] ?? '').trim() : '');
    const byId = new Map(state.types.map((t) => [t.id, t]));
    for (const r of names.rows) {
      const t = byId.get(g(r, 'type'));
      if (t && g(r, 'name')) (t.names ??= []).push({ name: g(r, 'name'), native: g(r, 'native'), language: g(r, 'language') });
    }
  } catch (err) { console.warn('Names not loaded:', err); }
}

// The list is built once; searching and the "without an image" box only hide rows, so open searches,
// typed credits and saving progress in other rows are kept.
function applyFilter() {
  const q = $('search').value.trim().toLowerCase();
  const missingOnly = $('missing-only').checked;
  for (const li of $('list').children) {
    const t = state.types.find((x) => x.id === li.dataset.id);
    li.hidden = !t || !((!q || `${t.id} ${t.name} ${t.translit} ${t.family}`.toLowerCase().includes(q)) &&
      (!missingOnly || !state.existing.has(t.id)));
  }
}
function render() {
  $('list').innerHTML = state.types.map((t) => {
    const file = state.existing.get(t.id)?.[0];
    return `<li class="up-item" data-id="${esc(t.id)}">
      <div class="up-main">
        <div class="up-thumb" title="Click to choose a file">${file ? `<img src="${folder}/${esc(file.name)}?v=${esc(file.sha.slice(0, 7))}" alt="" loading="lazy">` : 'drop image'}</div>
        <div><div class="up-name">${esc(t.translit || t.name)}</div><div class="up-sub">${esc(t.id)} · ${esc(t.family)}</div>
          <div class="up-credit">${esc(creditText(state.credits[t.id]))}</div></div>
        <div class="up-status">${file ? esc(file.name) : ''}</div>
        <div class="up-actions">
          <button type="button" class="up-find">find on Commons</button>
          ${file ? imageButtons() : ''}
        </div>
      </div>
      <div class="up-credit-edit" hidden>
        <input type="text" class="up-credit-input" placeholder="e.g. Photo: J. Smith, Lithuanian Open-Air Museum, CC BY-SA 4.0">
        <button type="button" class="up-credit-save">save credit</button>
        <button type="button" class="up-credit-cancel">cancel</button>
      </div>
      <div class="up-picker" hidden></div>
      <input type="file" accept="image/*">
    </li>`;
  }).join('');
  applyFilter();
}

const imageButtons = () => '<button type="button" class="up-edit-credit">edit credit</button><button type="button" class="up-remove">remove</button>';

// Credit editor under a row: plain text; a Commons credit keeps its link to the source page.
function openCreditEditor(item) {
  const box = item.querySelector('.up-credit-edit');
  if (!box.hidden) { box.hidden = true; return; }
  const input = box.querySelector('input');
  input.value = creditText(state.credits[item.dataset.id]);
  box.hidden = false;
  input.focus();
}
function saveCredit(item, text, source) {
  const id = item.dataset.id;
  if (!state.token) { message('Connect a GitHub token first.'); return; }
  const prev = state.credits[id];
  const link = source ?? prev?.source ?? '';
  if (text === creditText(prev) && link === (prev?.source ?? '')) return;
  const credit = text ? { text, ...(link ? { source: link } : {}) } : null;
  enqueue(async () => {
    try {
      const { data } = await commit(`${credit ? 'Credit' : 'Remove credit'} for ${id}`, { json: { [CREDITS_PATH]: withCredit(id, credit) } });
      state.credits = data[CREDITS_PATH];
      item.querySelector('.up-credit').textContent = creditText(credit);
      const typed = item.querySelector('.credit-input'); if (typed) typed.value = credit?.text ?? '';
      message(text ? `Credit saved for ${id}.` : `Credit removed for ${id}.`);
    } catch (err) { message(`Could not save credit: ${err.message}`); return false; }
  }, () => saveCredit(item, text, source), `credit ${id}`);
}

function updateSummary() {
  const withImg = state.types.filter((t) => state.existing.has(t.id)).length;
  const withStories = state.types.filter((t) => t.stories).length;
  $('summary').textContent = `${state.types.length} types · ${withImg} with an image · ${withStories} with stories`;
}

// ── Events ─────────────────────────────────────────────────
async function removeImage(id, button) {
  if (!state.token) { message('Connect a GitHub token first to remove images.'); return; }
  if (button.dataset.armed !== '1') {
    // First click arms the button; a second click within 4 s deletes.
    button.dataset.armed = '1';
    button.textContent = 'click again to delete';
    button.classList.add('armed');
    setTimeout(() => { if (button.isConnected) { button.dataset.armed = ''; button.textContent = 'remove'; button.classList.remove('armed'); } }, 4000);
    return;
  }
  button.disabled = true;
  removeNow(id, button);
}
// The image, its index entry and its credit go in one commit.
function removeNow(id, button) {
  const row = button.closest('.up-item');
  const status = row.querySelector('.up-status');
  enqueue(async () => {
    try {
      status.textContent = 'removing…'; status.className = 'up-status';
      const files = Object.fromEntries((state.existing.get(id) ?? []).map((f) => [`${folder}/${f.name}`, null]));
      const { data } = await commit(`Remove image ${id}`, {
        files,
        json: { [CONFIG.data.images]: withCredit(id, null), ...(state.credits[id] ? { [CREDITS_PATH]: withCredit(id, null) } : {}) },
      });
      state.existing.delete(id);
      if (data[CREDITS_PATH]) state.credits = data[CREDITS_PATH];
      row.querySelector('.up-thumb').textContent = 'drop image';
      const cl = row.querySelector('.up-credit'); if (cl) cl.textContent = '';
      status.textContent = 'removed'; status.className = 'up-status ok';
      row.querySelectorAll('.up-remove, .up-edit-credit').forEach((b) => b.remove());
      row.querySelector('.up-credit-edit')?.setAttribute('hidden', '');
      updateSummary();
    } catch (err) {
      status.textContent = `failed: ${err.message}`; status.className = 'up-status err';
      button.disabled = false;
      return false;
    }
  }, () => removeNow(id, button), `removing ${id}`);
}

// ── Picker ─────────────────────────────────────────────────
// Fold every open search except the one in this row, to keep the list short.
function foldOthers(item) {
  document.querySelectorAll('.up-picker:not([hidden])').forEach((p) => { if (p.closest('.up-item') !== item) p.hidden = true; });
}
function openPicker(item) {
  const picker = item.querySelector('.up-picker');
  if (!picker.hidden) { picker.hidden = true; return; }
  foldOthers(item);
  const t = state.types.find((x) => x.id === item.dataset.id);
  const local = (t.names ?? []).flatMap((n) => [n.name, n.native]);
  const queries = [...new Set([cleanQuery(t.search), t.translit, t.native, cleanQuery(t.name)].filter(Boolean))];
  const extra = [...new Set(local.filter((q) => q && !queries.includes(q)))];
  picker.innerHTML = `
    <div class="pk-search">
      <input type="search" class="pk-q" value="${esc(queries[0] ?? '')}">
      <button type="button" class="pk-go">search</button>
      ${queries.slice(1).map((q) => `<button type="button" class="pk-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}
    </div>
    ${extra.length ? `<div class="pk-search pk-local"><span class="pk-note">Other names:</span>
      ${extra.map((q) => `<button type="button" class="pk-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
    <div class="pk-search pk-local pk-cats" hidden><span class="pk-note">Commons categories:</span></div>
    <div class="pk-results"></div>
    <div class="pk-elsewhere">
      <span class="pk-note">Not here? Look on Google:</span>
      <button type="button" class="pk-google">Google Images ↗</button>
      <button type="button" class="pk-google" data-commons="1">Google, Commons only ↗</button>
    </div>
    <div class="pk-manual pk-paste">
      <label>Paste a Commons link (picture and credit come with it), or a copied image (right-click → Copy image)
        <input type="text" class="pk-link" placeholder="Paste here: link or image">
      </label>
    </div>
    <div class="pk-manual">
      <label>Credit for an image you add by hand (paste, drop on this row or click the thumbnail)
        <input type="text" class="credit-input" placeholder="e.g. Photo: J. Smith, Lithuanian Open-Air Museum, CC BY-SA 4.0" value="${esc(state.credits[t.id]?.text ?? '')}">
      </label>
      <label>Where it is from (page link, optional)
        <input type="url" class="source-input" placeholder="https://…" value="${esc(state.credits[t.id]?.source ?? '')}">
      </label>
      <button type="button" class="pk-save-credit">save credit</button>
    </div>`;
  picker.hidden = false;
  runSearch(picker, queries.slice(0, 3));
}

async function runSearch(picker, queries) {
  const box = picker.querySelector('.pk-results');
  box.innerHTML = '<p class="pk-note">searching Wikimedia Commons…</p>';
  try {
    const per = Math.ceil(UP.commonsResults / queries.length) + 2;
    const lists = await Promise.all(queries.map((q) => commonsSearch(q, per, picker).catch(() => [])));
    const seen = new Set(), results = [];
    for (let i = 0; results.length < UP.commonsResults && lists.some((l) => l[i]); i++) {
      for (const l of lists) if (l[i] && !seen.has(l[i].title)) { seen.add(l[i].title); results.push(l[i]); }
    }
    picker._results = results;
    box.innerHTML = results.length
      ? resultsHtml(results)
      : '<p class="pk-note">Nothing found on Commons. Try another word or a category, or look on Google below.</p>';
  } catch (err) {
    box.innerHTML = `<p class="pk-note">Search failed: ${esc(err.message)}</p>`;
  }
}

const resultsHtml = (results) => results.map((r, i) => `<button type="button" class="pk-result" data-i="${i}" title="${esc(r.name)}">
  <img src="${esc(r.thumb)}" alt="" loading="lazy">
  <span>${esc(r.author)}${r.licence ? ` · ${esc(r.licence)}` : ''}</span></button>`).join('');

async function pickResult(item, r) {
  const id = item.dataset.id;
  const status = item.querySelector('.up-status');
  status.textContent = 'fetching from Commons…'; status.className = 'up-status';
  try {
    const big = (await commonsLarge(r.title)) ?? r;
    const blob = await (await fetch(big.thumb || big.url)).blob();
    const file = new File([blob], `${id}.jpg`, { type: blob.type || 'image/jpeg' });
    item.querySelector('.up-picker').hidden = true;
    handleFile(id, file, { author: r.author, licence: r.licence, licenceUrl: r.licenceUrl, source: r.page, title: r.name });
  } catch (err) {
    status.textContent = `failed: ${err.message}`; status.className = 'up-status err';
  }
}

const list = $('list');
list.addEventListener('click', (e) => {
  const item = e.target.closest('.up-item');
  if (!item) return;
  const id = item.dataset.id;
  const btn = e.target.closest('button');
  if (!e.target.closest('.up-picker')) foldOthers(item); // working on another row folds the open searches
  if (btn?.classList.contains('up-remove')) { removeImage(id, btn); return; }
  if (btn?.classList.contains('up-find')) { openPicker(item); return; }
  if (btn?.classList.contains('pk-go')) { runSearch(item.querySelector('.up-picker'), [item.querySelector('.pk-q').value.trim()]); return; }
  if (btn?.classList.contains('pk-chip') && !btn.dataset.cat) { item.querySelector('.pk-q').value = btn.dataset.q; runSearch(item.querySelector('.up-picker'), [btn.dataset.q]); return; }
  if (btn?.classList.contains('pk-result')) { pickResult(item, item.querySelector('.up-picker')._results[btn.dataset.i]); return; }
  if (btn?.classList.contains('pk-cat')) {
    const picker = item.querySelector('.up-picker');
    const box = picker.querySelector('.pk-results');
    box.innerHTML = '<p class="pk-note">opening the category…</p>';
    commonsCategoryFiles(btn.dataset.cat, 40).then((r) => {
      picker._results = r;
      box.innerHTML = r.length ? resultsHtml(r) : '<p class="pk-note">No pictures directly in this category (it may only have sub-categories).</p>';
    });
    return;
  }
  if (btn?.classList.contains('pk-google')) {
    const q = item.querySelector('.pk-q').value.trim();
    window.open(googleImages(q, !!btn.dataset.commons), '_blank', 'noopener');
    item.querySelector('.pk-link')?.focus();
    return;
  }
  if (btn?.classList.contains('pk-save-credit')) { saveCredit(item, item.querySelector('.credit-input').value.trim(), item.querySelector('.source-input')?.value.trim()); return; }
  if (btn?.classList.contains('up-edit-credit')) { openCreditEditor(item); return; }
  if (btn?.classList.contains('up-credit-cancel')) { item.querySelector('.up-credit-edit').hidden = true; return; }
  if (btn?.classList.contains('up-credit-save')) {
    saveCredit(item, item.querySelector('.up-credit-input').value.trim());
    item.querySelector('.up-credit-edit').hidden = true;
    return;
  }
  if (e.target.closest('.up-thumb')) item.querySelector('input[type="file"]').click();
});
list.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('up-credit-input')) { e.target.closest('.up-item').querySelector('.up-credit-save').click(); return; }
  if (e.key === 'Escape' && e.target.classList.contains('up-credit-input')) { e.target.closest('.up-item').querySelector('.up-credit-cancel').click(); return; }
  if (e.key === 'Enter' && e.target.classList.contains('pk-q')) {
    e.target.closest('.up-item').querySelector('.pk-go').click();
  }
});
list.addEventListener('change', (e) => {
  const item = e.target.closest('.up-item');
  if (item && e.target.files[0]) handleFile(item.dataset.id, e.target.files[0]);
  e.target.value = '';
});
for (const [el, over] of [[list, (e) => e.target.closest('.up-item')], [$('bulk'), () => $('bulk')]]) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.querySelectorAll('.over').forEach((n) => n.classList.remove('over'));
    over(e)?.classList.add('over');
  });
  el.addEventListener('dragleave', (e) => over(e)?.classList.remove('over'));
}
list.addEventListener('drop', (e) => {
  e.preventDefault();
  const item = e.target.closest('.up-item');
  item?.classList.remove('over');
  if (!item) return;
  if (e.dataTransfer.files[0]) { handleFile(item.dataset.id, e.dataTransfer.files[0]); return; }
  // An image dragged from another tab arrives as its address.
  const link = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split('\n')[0].trim();
  if (/^https?:\/\//.test(link)) useLink(item, link);
});
$('bulk').addEventListener('drop', (e) => {
  e.preventDefault();
  $('bulk').classList.remove('over');
  const ids = new Set(state.types.map((t) => t.id));
  const unmatched = [];
  for (const file of e.dataTransfer.files) {
    const id = file.name.match(/^[A-Za-z]+\d+/)?.[0]?.toUpperCase();
    if (id && ids.has(id)) handleFile(id, file); else unmatched.push(file.name);
  }
  if (unmatched.length) message(`No type ID found for: ${unmatched.join(', ')}`);
});
// Pasting: into a row's paste box, or anywhere while one row's search is open.
// A copied image is uploaded; a pasted link is read (see useLink).
document.addEventListener('paste', (e) => {
  const inBox = e.target.closest?.('.pk-link');
  const typing = !inBox && e.target.closest?.('input, textarea');
  if (typing) return; // normal pasting into the other fields
  const item = inBox?.closest('.up-item') ?? document.querySelector('.up-picker:not([hidden])')?.closest('.up-item');
  if (!item) return;
  const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); handleFile(item.dataset.id, file); if (inBox) inBox.value = ''; return; }
  const text = e.clipboardData?.getData('text')?.trim();
  if (text && /^https?:\/\//.test(text)) {
    e.preventDefault();
    if (inBox) inBox.value = text;
    useLink(item, text);
  }
});
list.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('pk-link') && e.target.value.trim()) useLink(e.target.closest('.up-item'), e.target.value.trim());
});

// Dropping outside a target should not open the image in the tab.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('search').addEventListener('input', applyFilter);
$('missing-only').addEventListener('change', applyFilter);
$('connect-btn').addEventListener('click', () => { const t = $('token').value.trim(); if (t) connect(t); });
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('connect-btn').click(); });
// Disconnect: forget the token in this browser (the style panel uses the same one). Paste it again to save.
function disconnect() {
  if (state.pending && !confirm('Changes are still being saved. Disconnect anyway? They will not be saved.')) return;
  setToken(null); state.token = null; showConnected(false);
  message('Disconnected: the token is no longer stored in this browser. Paste it again to save.');
}
document.addEventListener('click', (e) => { if (e.target.closest('#disconnect, [data-disconnect]')) disconnect(); });

(async () => {
  const saved = getToken();
  if (saved) { state.token = saved; showConnected(true); await checkToken(); }
  try { await loadTypes(); } catch (err) { $('summary').textContent = 'not loaded'; window.atlasFail(err); return; }
  await Promise.all([loadExisting(), loadCredits()]);
  updateSummary();
  render();
})();

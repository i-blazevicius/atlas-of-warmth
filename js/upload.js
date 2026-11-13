// Upload page: drop an image on a type → shrunk to JPG, renamed to the type ID,
// committed to the repository's images/ folder (or downloaded if no token is set).
import CONFIG from './config.js';

const $ = (id) => document.getElementById(id);
const GH = CONFIG.github;
const UP = CONFIG.imageUpload;
const TOKEN_KEY = 'atlas-of-warmth-token';
const EXTS = CONFIG.images.extensions;
const folder = CONFIG.images.folder.replace(/\/$/, '');

const state = { types: [], existing: new Map(), credits: {}, token: null, queue: Promise.resolve() };
const CREDITS_PATH = CONFIG.data.credits;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

function message(text) {
  const m = $('message'); m.textContent = text; m.hidden = !text;
  if (text) setTimeout(() => { if (m.textContent === text) m.hidden = true; }, 5000);
}

// ── GitHub ─────────────────────────────────────────────────
async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
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
// Read the latest file, change it, write it back (one commit).
async function updateCredits(id, credit) {
  let sha, data = {};
  try {
    const f = await gh(`/contents/${CREDITS_PATH}?ref=${GH.branch}&t=${Date.now()}`);
    sha = f.sha; data = JSON.parse(base64ToText(f.content));
  } catch { /* file does not exist yet */ }
  if (credit) data[id] = credit; else delete data[id];
  const sorted = Object.fromEntries(Object.keys(data).sort().map((k) => [k, data[k]]));
  await gh(`/contents/${CREDITS_PATH}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `${credit ? 'Credit' : 'Remove credit'} for ${id}`,
      content: textToBase64(JSON.stringify(sorted, null, 2) + '\n'),
      branch: GH.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  state.credits = sorted;
}
const creditText = (c) => (!c ? '' : c.text ?? [c.author, c.licence].filter(Boolean).join(' · '));

// ── Wikimedia Commons ──────────────────────────────────────
const stripHtml = (html) => new DOMParser().parseFromString(String(html ?? ''), 'text/html').body.textContent.trim().replace(/\s+/g, ' ');
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
const commonsSearch = (q, limit) => commonsQuery({
  generator: 'search', gsrsearch: `${q} filetype:bitmap`, gsrnamespace: 6, gsrlimit: limit, iiurlwidth: 360,
});
const commonsLarge = async (title) => (await commonsQuery({ titles: title, iiurlwidth: UP.maxSize }))[0];

const cleanQuery = (q) => String(q ?? '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

async function commitImage(id, blob) {
  const name = `${id}.jpg`;
  const old = state.existing.get(id) ?? [];
  const same = old.find((f) => f.name === name);
  const res = await gh(`/contents/${folder}/${name}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `${same ? 'Replace' : 'Add'} image ${name}`,
      content: await toBase64(blob),
      branch: GH.branch,
      ...(same ? { sha: same.sha } : {}),
    }),
  });
  // Remove other versions (e.g. T014.png) so the new JPG is the one shown.
  for (const f of old.filter((f) => f.name !== name)) {
    await gh(`/contents/${folder}/${f.name}`, {
      method: 'DELETE',
      body: JSON.stringify({ message: `Remove old image ${f.name}`, sha: f.sha, branch: GH.branch }),
    });
  }
  state.existing.set(id, [{ name, sha: res.content.sha }]);
}

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
    const typed = document.querySelector(`[data-id="${CSS.escape(id)}"] .credit-input`)?.value.trim();
    credit = typed ? { text: typed } : null;
  }
  const row = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const status = row?.querySelector('.up-status');
  const setStatus = (text, cls = '') => { if (status) { status.textContent = text; status.className = `up-status ${cls}`; } };
  setStatus('queued…');
  // One at a time: GitHub rejects simultaneous commits to the same branch.
  state.queue = state.queue.then(async () => {
    try {
      setStatus('shrinking…');
      const { blob, w, h } = await shrink(file);
      const kb = Math.round(blob.size / 1024);
      const thumb = row?.querySelector('.up-thumb');
      if (thumb) thumb.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="">`;
      if (state.token) {
        setStatus('saving…');
        await commitImage(id, blob);
        setStatus('saving credit…');
        await updateCredits(id, credit);
        setStatus(`saved · ${w}×${h} · ${kb} KB${credit ? '' : ' · no credit'}`, credit ? 'ok' : '');
        const cl = row?.querySelector('.up-credit');
        if (cl) cl.textContent = creditText(credit);
        const actions = row?.querySelector('.up-actions');
        if (actions && !actions.querySelector('.up-remove')) actions.innerHTML = '<button type="button" class="up-remove">remove</button>';
      } else {
        download(blob, `${id}.jpg`);
        setStatus(`downloaded · ${kb} KB${credit ? ' · credit: ' + creditText(credit) : ''}`, 'ok');
      }
      updateSummary();
    } catch (err) {
      console.error(err);
      setStatus(`failed: ${err.message}`, 'err');
    }
  });
}

// ── List ───────────────────────────────────────────────────
function findCol(headers, label) {
  const l = label.toLowerCase();
  return headers.find((h) => h.trim().toLowerCase() === l) ?? headers.find((h) => h.trim().toLowerCase().startsWith(l));
}

async function loadTypes() {
  const text = await (await fetch(CONFIG.data.types, { cache: 'no-store' })).text();
  const { data, meta } = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' });
  const c = Object.fromEntries(['id', 'family', 'name', 'translit', 'native', 'search'].map((k) => [k, findCol(meta.fields, CONFIG.typeColumns[k])]));
  const v = (r, k) => (c[k] ? String(r[c[k]] ?? '').trim() : '');
  state.types = data
    .map((r) => ({ id: v(r, 'id'), family: v(r, 'family'), name: v(r, 'name'), translit: v(r, 'translit'), native: v(r, 'native'), search: v(r, 'search') }))
    .filter((t) => t.id);
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const missingOnly = $('missing-only').checked;
  const items = state.types.filter((t) =>
    (!q || `${t.id} ${t.name} ${t.translit} ${t.family}`.toLowerCase().includes(q)) &&
    (!missingOnly || !state.existing.has(t.id)));
  $('list').innerHTML = items.map((t) => {
    const file = state.existing.get(t.id)?.[0];
    return `<li class="up-item" data-id="${esc(t.id)}">
      <div class="up-main">
        <div class="up-thumb" title="Click to choose a file">${file ? `<img src="${folder}/${esc(file.name)}?v=${esc(file.sha.slice(0, 7))}" alt="" loading="lazy">` : 'drop image'}</div>
        <div><div class="up-name">${esc(t.translit || t.name)}</div><div class="up-sub">${esc(t.id)} · ${esc(t.family)}</div>
          <div class="up-credit">${esc(creditText(state.credits[t.id]))}</div></div>
        <div class="up-status">${file ? esc(file.name) : ''}</div>
        <div class="up-actions">
          <button type="button" class="up-find">find on Commons</button>
          ${file ? '<button type="button" class="up-remove">remove</button>' : ''}
        </div>
      </div>
      <div class="up-picker" hidden></div>
      <input type="file" accept="image/*">
    </li>`;
  }).join('');
}

function updateSummary() {
  const withImg = state.types.filter((t) => state.existing.has(t.id)).length;
  $('summary').textContent = `${withImg} of ${state.types.length} types have an image`;
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
  const row = button.closest('.up-item');
  const status = row.querySelector('.up-status');
  button.disabled = true;
  state.queue = state.queue.then(async () => {
    try {
      status.textContent = 'removing…'; status.className = 'up-status';
      for (const f of state.existing.get(id) ?? []) {
        await gh(`/contents/${folder}/${f.name}`, {
          method: 'DELETE',
          body: JSON.stringify({ message: `Remove image ${f.name}`, sha: f.sha, branch: GH.branch }),
        });
      }
      state.existing.delete(id);
      if (state.credits[id]) await updateCredits(id, null);
      row.querySelector('.up-thumb').textContent = 'drop image';
      const cl = row.querySelector('.up-credit'); if (cl) cl.textContent = '';
      status.textContent = 'removed'; status.className = 'up-status ok';
      button.remove();
      updateSummary();
    } catch (err) {
      status.textContent = `failed: ${err.message}`; status.className = 'up-status err';
      button.disabled = false;
    }
  });
}

// ── Picker ─────────────────────────────────────────────────
function openPicker(item) {
  const picker = item.querySelector('.up-picker');
  if (!picker.hidden) { picker.hidden = true; return; }
  const t = state.types.find((x) => x.id === item.dataset.id);
  const queries = [...new Set([cleanQuery(t.search), t.translit, t.native, cleanQuery(t.name)].filter(Boolean))];
  picker.innerHTML = `
    <div class="pk-search">
      <input type="search" class="pk-q" value="${esc(queries[0] ?? '')}">
      <button type="button" class="pk-go">search</button>
      ${queries.slice(1).map((q) => `<button type="button" class="pk-chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}
    </div>
    <div class="pk-results"></div>
    <div class="pk-manual">
      <label>Credit for an image you add by hand (drop it on this row or click the thumbnail)
        <input type="text" class="credit-input" placeholder="e.g. Photo: J. Smith, Lithuanian Open-Air Museum, CC BY-SA 4.0" value="${esc(state.credits[t.id]?.text ?? '')}">
      </label>
      ${state.existing.has(t.id) ? '<button type="button" class="pk-save-credit">save credit only</button>' : ''}
    </div>`;
  picker.hidden = false;
  runSearch(picker, queries.slice(0, 3));
}

async function runSearch(picker, queries) {
  const box = picker.querySelector('.pk-results');
  box.innerHTML = '<p class="pk-note">searching Wikimedia Commons…</p>';
  try {
    const per = Math.ceil(UP.commonsResults / queries.length) + 2;
    const lists = await Promise.all(queries.map((q) => commonsSearch(q, per).catch(() => [])));
    const seen = new Set(), results = [];
    for (let i = 0; results.length < UP.commonsResults && lists.some((l) => l[i]); i++) {
      for (const l of lists) if (l[i] && !seen.has(l[i].title)) { seen.add(l[i].title); results.push(l[i]); }
    }
    picker._results = results;
    box.innerHTML = results.length
      ? results.map((r, i) => `<button type="button" class="pk-result" data-i="${i}" title="${esc(r.name)}">
          <img src="${esc(r.thumb)}" alt="" loading="lazy">
          <span>${esc(r.author)}${r.licence ? ` · ${esc(r.licence)}` : ''}</span></button>`).join('')
      : '<p class="pk-note">Nothing found. Try another word, or add an image by hand below.</p>';
  } catch (err) {
    box.innerHTML = `<p class="pk-note">Search failed: ${esc(err.message)}</p>`;
  }
}

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
  if (btn?.classList.contains('up-remove')) { removeImage(id, btn); return; }
  if (btn?.classList.contains('up-find')) { openPicker(item); return; }
  if (btn?.classList.contains('pk-go')) { runSearch(item.querySelector('.up-picker'), [item.querySelector('.pk-q').value.trim()]); return; }
  if (btn?.classList.contains('pk-chip')) { item.querySelector('.pk-q').value = btn.dataset.q; runSearch(item.querySelector('.up-picker'), [btn.dataset.q]); return; }
  if (btn?.classList.contains('pk-result')) { pickResult(item, item.querySelector('.up-picker')._results[btn.dataset.i]); return; }
  if (btn?.classList.contains('pk-save-credit')) {
    if (!state.token) { message('Connect a GitHub token first.'); return; }
    const text = item.querySelector('.credit-input').value.trim();
    state.queue = state.queue.then(async () => {
      try {
        await updateCredits(id, text ? { text } : null);
        item.querySelector('.up-credit').textContent = text;
        message(text ? `Credit saved for ${id}.` : `Credit removed for ${id}.`);
      } catch (err) { message(`Could not save credit: ${err.message}`); }
    });
    return;
  }
  if (e.target.closest('.up-thumb')) item.querySelector('input[type="file"]').click();
});
list.addEventListener('keydown', (e) => {
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
  if (item && e.dataTransfer.files[0]) handleFile(item.dataset.id, e.dataTransfer.files[0]);
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
// Dropping outside a target should not open the image in the tab.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('search').addEventListener('input', render);
$('missing-only').addEventListener('change', render);
$('connect-btn').addEventListener('click', () => { const t = $('token').value.trim(); if (t) connect(t); });
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('connect-btn').click(); });
$('disconnect').addEventListener('click', () => { setToken(null); state.token = null; showConnected(false); });

(async () => {
  const saved = getToken();
  if (saved) { state.token = saved; showConnected(true); }
  try { await loadTypes(); } catch (err) { $('summary').textContent = 'Could not load the Types sheet.'; console.error(err); return; }
  await Promise.all([loadExisting(), loadCredits()]);
  updateSummary();
  render();
})();

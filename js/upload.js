// Upload page: drop an image on a type → shrunk to JPG, renamed to the type ID,
// committed to the repository's images/ folder (or downloaded if no token is set).
import CONFIG from './config.js';

const $ = (id) => document.getElementById(id);
const GH = CONFIG.github;
const UP = CONFIG.imageUpload;
const TOKEN_KEY = 'atlas-of-warmth-token';
const EXTS = CONFIG.images.extensions;
const folder = CONFIG.images.folder.replace(/\/$/, '');

const state = { types: [], existing: new Map(), token: null, queue: Promise.resolve() };
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

function handleFile(id, file) {
  if (!file?.type.startsWith('image/')) { message(`${file?.name ?? 'That'} is not an image.`); return; }
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
        setStatus(`saved · ${w}×${h} · ${kb} KB`, 'ok');
      } else {
        download(blob, `${id}.jpg`);
        setStatus(`downloaded · ${kb} KB`, 'ok');
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
  const c = Object.fromEntries(['id', 'family', 'name', 'translit'].map((k) => [k, findCol(meta.fields, CONFIG.typeColumns[k])]));
  state.types = data
    .map((r) => ({ id: String(r[c.id] ?? '').trim(), family: r[c.family] ?? '', name: r[c.name] ?? '', translit: r[c.translit] ?? '' }))
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
      <div class="up-thumb">${file ? `<img src="${folder}/${esc(file.name)}?v=${esc(file.sha.slice(0, 7))}" alt="" loading="lazy">` : 'drop image'}</div>
      <div><div class="up-name">${esc(t.translit || t.name)}</div><div class="up-sub">${esc(t.id)} · ${esc(t.family)}</div></div>
      <div class="up-status">${file ? esc(file.name) : ''}</div>
      <input type="file" accept="image/*">
    </li>`;
  }).join('');
}

function updateSummary() {
  const withImg = state.types.filter((t) => state.existing.has(t.id)).length;
  $('summary').textContent = `${withImg} of ${state.types.length} types have an image`;
}

// ── Events ─────────────────────────────────────────────────
const list = $('list');
list.addEventListener('click', (e) => {
  const item = e.target.closest('.up-item');
  if (item && e.target.tagName !== 'INPUT') item.querySelector('input[type="file"]').click();
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
  await loadExisting();
  updateSummary();
  render();
})();

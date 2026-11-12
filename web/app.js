'use strict';

/* ---------- helpers ---------- */

const $ = (id) => document.getElementById(id);
// Two players take turns: the next song starts on the idle one just before the current one
// ends, so the audio never stops. When it stops, even briefly, iOS mutes a backgrounded
// web app until it's reopened.
const players = [$('audio'), $('audio2')];
let audio = players[0];
const spareOf = () => (audio === players[0] ? players[1] : players[0]);
const HANDOFF_SECONDS = 0.5;

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 6l8.5 6L6 18zM16 6h2v12h-2z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M18 6l-8.5 6 8.5 6zM6 6h2v12H6z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M10.6 9.2 5.4 4 4 5.4l5.2 5.2zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4zm.3 9.4-1.4 1.4 3.1 3.1-2 2H20v-5.5l-2 2z"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
  repeatOne: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/><path d="M11.2 10.5h1.6v5h-1.4v-3.4l-.9.3v-1.1z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  local: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.5 14.5-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4z"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M19.4 10A7.5 7.5 0 0 0 5.4 8 6 6 0 0 0 6 20h13a5 5 0 0 0 .4-10z"/></svg>',
  saving: '<svg viewBox="0 0 24 24"><path d="M11 3h2v10.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4 3.6 3.6zM5 19h14v2H5z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M18.3 7.1 16.9 5.7 12 10.6 7.1 5.7 5.7 7.1l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z"/></svg>',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtBytes(n) {
  if (!n) return '0 MB';
  return n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`;
}

const extractUrl = (text) => (String(text || '').match(/https?:\/\/[^\s<>"']+/) || [null])[0];

const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('bt:' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('bt:' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

/* ---------- playback log (Settings → Playback log) ---------- */

// A short on-device history of playback events, for diagnosing background audio on the phone.
const playLog = prefs.get('playlog', []);
function logPlay(msg) {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  playLog.push(`${t} ${document.hidden ? 'bg' : 'fg'}  ${msg}`);
  if (playLog.length > 120) playLog.splice(0, playLog.length - 120);
  prefs.set('playlog', playLog);
}

/* ---------- IndexedDB: saved songs live here ---------- */

const db = (() => {
  let opening;
  const open = () => opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('berrytunes', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('tracks', { keyPath: 'id' }); // metadata of songs saved on this device
      req.result.createObjectStore('files');                     // "<id>:audio" / "<id>:cover" -> Blob
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function run(store, mode, fn) {
    const conn = await open();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  return {
    all: (store) => run(store, 'readonly', (s) => s.getAll()),
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    put: (store, value, key) => run(store, 'readwrite', (s) => s.put(value, key)),
    del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  };
})();

/* ---------- state ---------- */

const state = {
  online: null,
  ytdlp: null,
  server: new Map(),   // id -> track on the PC
  local: new Map(),    // id -> track saved on this device
  saving: new Set(),
  jobs: [],
  baseQueue: [],
  queue: [],
  qi: -1,
  current: null,
  filter: '',
  playlists: prefs.get('playlists', []), // cached so they still show with the PC off
  view: prefs.get('view', 'all'),        // 'all' or a playlist id
  section: prefs.get('section', 'music'), // music | podcasts
  shuffle: prefs.get('shuffle', false),
  repeat: prefs.get('repeat', 'off'), // off | all | one
  autosave: prefs.get('autosave', true),
  // Links added while the PC was off: { url, section }. (Older versions stored bare URLs.)
  pendingAdds: prefs.get('pendingAdds', []).map((p) => (typeof p === 'string' ? { url: p, section: null } : p)),
  pendingDeletes: prefs.get('pendingDeletes', []),
  dismissed: new Set(prefs.get('dismissedJobs', [])),
};

const coverUrls = new Map(); // id -> blob: URL for locally saved covers
let audioUrl = null;

const trackById = (id) => state.server.get(id) || state.local.get(id);

const SECTION_NAMES = { music: 'Music', podcasts: 'Podcasts' };
const sectionOf = (item) => item?.section || 'music';

// Songs in the section being viewed (Music or Podcasts), newest first.
function allTracks() {
  const merged = new Map(state.local);
  for (const [id, t] of state.server) merged.set(id, t);
  return [...merged.values()].filter((t) => sectionOf(t) === state.section).sort((a, b) => b.added_at - a.added_at);
}

const sectionPlaylists = () => state.playlists.filter((pl) => sectionOf(pl) === state.section);
const currentPlaylist = () => sectionPlaylists().find((pl) => pl.id === state.view) || null;

function visibleTracks() {
  const q = state.filter.trim().toLowerCase();
  const pl = currentPlaylist();
  const list = pl ? pl.track_ids.map(trackById).filter(Boolean) : allTracks();
  return q ? list.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q)) : list;
}

const isPlayable = (id) => state.local.has(id) || (state.online && state.server.has(id));

function coverUrl(t) {
  if (coverUrls.has(t.id)) return coverUrls.get(t.id);
  if (state.online && t.has_cover && state.server.has(t.id)) return `/api/tracks/${t.id}/cover`;
  return '';
}

/* ---------- server API ---------- */

class ApiError extends Error {}

async function api(path, opts = {}, timeout = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch('/api' + path, { ...opts, signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).detail || msg; } catch { /* not JSON */ }
      throw new ApiError(msg);
    }
    return res;
  } catch (e) {
    if (!(e instanceof ApiError)) setOnline(false);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function setOnline(online) {
  if (state.online === online) return;
  state.online = online;
  const el = $('status');
  el.classList.toggle('online', online);
  el.classList.toggle('offline', !online);
  $('status-text').textContent = online ? 'PC online' : 'PC offline';
  renderTracks();
}

async function checkHealth() {
  try {
    const info = await (await api('/health', {}, 4000)).json();
    state.ytdlp = info.yt_dlp;
    state.jsRuntime = info.js_runtime;
    setOnline(true);
    return true;
  } catch {
    return false;
  }
}

async function refreshTracks() {
  const tracks = await (await api('/tracks')).json();
  state.server = new Map(tracks.map((t) => [t.id, t]));
  for (const t of tracks) {
    const saved = state.local.get(t.id);
    if (saved && sectionOf(saved) !== sectionOf(t)) {
      const meta = { ...saved, section: t.section };
      state.local.set(t.id, meta);
      db.put('tracks', meta).catch(() => {});
    }
  }
  renderTracks();
}

async function refreshPlaylists() {
  setPlaylists(await (await api('/playlists')).json());
}

function setPlaylists(list) {
  state.playlists = list;
  prefs.set('playlists', list);
  if (state.view !== 'all' && !currentPlaylist()) setView('all');
  renderViews();
  renderTracks();
}

/* ---------- adding songs ---------- */

// Links added in the app go to the section being viewed.
async function addUrl(raw, section = state.section) {
  const url = extractUrl(raw);
  if (!url) { toast("That doesn't look like a link."); return; }
  try {
    await api('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, section }) });
    pollJobs();
  } catch (e) {
    if (e instanceof ApiError) { toast(e.message); return; }
    state.pendingAdds.push({ url, section });
    prefs.set('pendingAdds', state.pendingAdds);
    toast('PC is offline. The link will be sent when it’s back.');
  }
  renderJobs();
}

async function flushPending() {
  while (state.pendingDeletes.length) {
    await api(`/tracks/${state.pendingDeletes[0]}`, { method: 'DELETE' });
    state.pendingDeletes.shift();
    prefs.set('pendingDeletes', state.pendingDeletes);
  }
  while (state.pendingAdds.length) {
    await api('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.pendingAdds[0]) });
    state.pendingAdds.shift();
    prefs.set('pendingAdds', state.pendingAdds);
  }
}

let pollTimer = null;
async function pollJobs() {
  clearTimeout(pollTimer);
  try {
    state.jobs = await (await api('/jobs')).json();
  } catch {
    return;
  }
  if (state.jobs.some((j) => j.status === 'done' && j.track_id && !state.server.has(j.track_id))) {
    await refreshTracks().catch(() => {});
    if (state.autosave) saveMissing();
  }
  renderJobs();
  if (state.jobs.some((j) => ['queued', 'downloading', 'processing'].includes(j.status))) {
    pollTimer = setTimeout(pollJobs, 1500);
  }
}

function dismissJob(id) {
  state.dismissed.add(id);
  prefs.set('dismissedJobs', [...state.dismissed].slice(-100));
  renderJobs();
}

function renderJobs() {
  const now = Date.now() / 1000;
  // Playlist summaries stay up a little longer so there's time to read them.
  const showDone = (j) => j.finished_at >= now - (j.kind === 'playlist' ? 20 : 8);
  const items = state.pendingAdds.map(({ url }) => `
    <li class="job"><div class="label"><strong>${esc(url)}</strong><small>Waiting for your PC to come online</small></div></li>`);
  const dismiss = (j) => `<button type="button" data-dismiss="${j.id}" aria-label="Dismiss">${ICONS.close}</button>`;
  const row = (j, label, extra = '') => `<li class="job${j.status === 'error' ? ' error' : ''}">
    <div class="label"><strong>${esc(j.title || j.url)}</strong><small>${esc(label)}</small></div>${extra}</li>`;

  // Oldest first, so the song downloading now sits above the ones waiting behind it.
  const jobs = state.jobs.filter((j) => !state.dismissed.has(j.id)).reverse();
  for (const j of jobs) {
    if (j.status === 'downloading' || j.status === 'processing') {
      const label = j.kind === 'playlist' ? 'Reading playlist…'
        : j.status === 'processing' ? 'Converting…' : `Downloading… ${Math.round(j.progress * 100)}%`;
      items.push(row(j, label, `<span class="bar" style="width:${Math.round(j.progress * 100)}%"></span>`));
    }
  }
  const queued = jobs.filter((j) => j.status === 'queued');
  if (queued.length === 1) {
    items.push(row(queued[0], queued[0].attempt > 1 ? queued[0].error : 'Queued'));
  } else if (queued.length > 1) {
    items.push(`<li class="job"><div class="label"><strong>${queued.length} songs waiting</strong>
      <small>Next: ${esc(queued[0].title || queued[0].url)}</small></div>
      <button type="button" class="text-btn" data-cancel-queued>Cancel</button></li>`);
  }
  const failed = jobs.filter((j) => j.status === 'error');
  if (failed.length > 1) {
    const more = failed.length > 3 ? ` (showing 3)` : '';
    items.push(`<li class="job error"><div class="label"><strong>${failed.length} downloads failed${more}</strong>
      <small>Often temporary. Retrying later usually works.</small></div>
      <button type="button" class="text-btn" data-retry-all>Retry all</button>
      <button type="button" data-dismiss-all aria-label="Dismiss all">${ICONS.close}</button></li>`);
  }
  let shownFailed = 0;
  for (const j of jobs) {
    if (j.status === 'error' && ++shownFailed > 3) continue;
    if (j.status === 'error') {
      const retry = j.kind === 'video' ? `<button type="button" class="text-btn" data-retry="${j.id}">Retry</button>` : '';
      items.push(row(j, j.error, retry + dismiss(j)));
    } else if (j.status === 'done' && showDone(j)) {
      const where = SECTION_NAMES[sectionOf(j)];
      let label = j.duplicate ? `Already in ${where}` : `Added to ${where}`;
      if (j.playlist) {
        const { added, already } = j.playlist;
        label = `Playlist: ${added} song${added === 1 ? '' : 's'} queued` + (already ? ` · ${already} already in your library` : '');
      }
      items.push(row(j, label, dismiss(j)));
    }
  }
  $('jobs').innerHTML = items.join('');
  clearTimeout(renderJobs.timer);
  if (state.jobs.some((j) => j.status === 'done' && showDone(j))) renderJobs.timer = setTimeout(renderJobs, 2000);
}

async function retryJobs(ids) {
  try {
    await api('/jobs/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
  } catch {
    toast('Couldn’t reach your PC.');
    return;
  }
  pollJobs();
}

async function cancelQueued() {
  const count = state.jobs.filter((j) => j.status === 'queued').length;
  if (!confirm(`Cancel ${count} waiting songs? The one downloading now will finish.`)) return;
  try {
    await api('/jobs/queued', { method: 'DELETE' });
  } catch {
    toast('Couldn’t reach your PC.');
  }
  pollJobs();
}

/* ---------- saving songs to this device ---------- */

async function loadLocal() {
  for (const t of await db.all('tracks')) {
    state.local.set(t.id, t);
    if (t.has_cover) {
      const blob = await db.get('files', `${t.id}:cover`);
      if (blob) coverUrls.set(t.id, URL.createObjectURL(blob));
    }
  }
}

async function saveTrack(id) {
  const t = state.server.get(id);
  if (!t || state.local.has(id) || state.saving.has(id)) return;
  state.saving.add(id);
  renderTracks();
  try {
    const audioBlob = await (await api(`/tracks/${id}/audio`, {}, 10 * 60 * 1000)).blob();
    let coverBlob = null;
    if (t.has_cover) coverBlob = await (await api(`/tracks/${id}/cover`)).blob().catch(() => null);
    await db.put('files', audioBlob, `${id}:audio`);
    if (coverBlob) {
      await db.put('files', coverBlob, `${id}:cover`);
      coverUrls.set(id, URL.createObjectURL(coverBlob));
    }
    const meta = { ...t, has_cover: !!coverBlob };
    await db.put('tracks', meta);
    state.local.set(id, meta);
    navigator.storage?.persist?.().catch(() => {});
  } catch (e) {
    if (e?.name === 'QuotaExceededError') toast('This device is out of space for more songs.');
  } finally {
    state.saving.delete(id);
    renderTracks();
  }
}

let savingAll = false;
async function saveMissing() {
  if (savingAll) return;
  savingAll = true;
  try {
    for (const id of state.server.keys()) {
      if (!state.online) break;
      await saveTrack(id);
    }
  } finally {
    savingAll = false;
  }
}

async function removeLocal(id) {
  await db.del('tracks', id);
  await db.del('files', `${id}:audio`);
  await db.del('files', `${id}:cover`);
  state.local.delete(id);
  if (coverUrls.has(id)) {
    URL.revokeObjectURL(coverUrls.get(id));
    coverUrls.delete(id);
  }
}

async function deleteTrack(id) {
  const t = trackById(id);
  if (!t || !confirm(`Delete “${t.title}” from your library?`)) return;
  if (state.current === id) {
    audio.pause();
    audio.removeAttribute('src');
    state.current = null;
    renderNowPlaying();
  }
  if (state.server.has(id)) {
    try {
      await api(`/tracks/${id}`, { method: 'DELETE' });
    } catch {
      state.pendingDeletes.push(id);
      prefs.set('pendingDeletes', state.pendingDeletes);
    }
    state.server.delete(id);
  }
  await removeLocal(id);
  renderTracks();
}

/* ---------- Music / Podcasts ---------- */

const otherSection = (section) => (section === 'music' ? 'podcasts' : 'music');

function renderSection() {
  for (const btn of document.querySelectorAll('[data-section]')) {
    const on = btn.dataset.section === state.section;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', on);
  }
  const music = state.section === 'music';
  $('add-url').placeholder = music ? 'Paste a video link' : 'Paste a podcast or video link';
  $('search').placeholder = music ? 'Search your music' : 'Search your podcasts';
}

$('sections').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-section]');
  if (!btn || btn.dataset.section === state.section) return;
  state.section = btn.dataset.section;
  prefs.set('section', state.section);
  setView('all');
  renderSection();
  renderViews();
  renderTracks();
  window.scrollTo({ top: 0 });
});

/* ---------- playlists ---------- */

function setView(view) {
  state.view = view;
  prefs.set('view', view);
}

function renderViews() {
  const count = (pl) => pl.track_ids.filter((id) => trackById(id)).length;
  const chip = (view, label, extra = '') =>
    `<button type="button" class="chip${state.view === view ? ' on' : ''}" data-view="${view}">${label}${extra}</button>`;
  $('views').innerHTML = chip('all', `All ${SECTION_NAMES[state.section].toLowerCase()}`)
    + sectionPlaylists().map((pl) => chip(pl.id, esc(pl.name), state.view === pl.id
      ? ` <span class="chip-more" aria-label="Playlist options">${ICONS.more}</span>` : ` <small>${count(pl)}</small>`)).join('')
    + `<button type="button" class="chip new" data-new-playlist>+ New</button>`;
}

async function playlistCall(path, method, body) {
  if (!state.online) { toast('Connect to your PC to change playlists.'); return null; }
  try {
    const res = await api(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await res.json();
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Couldn’t reach your PC.');
    return null;
  }
}

async function newPlaylist() {
  const name = prompt('Playlist name', '')?.trim();
  if (!name) return null;
  const pl = await playlistCall('/playlists', 'POST', { name, section: state.section });
  if (pl) await refreshPlaylists().catch(() => {});
  return pl;
}

$('views').addEventListener('click', async (e) => {
  if (e.target.closest('[data-new-playlist]')) {
    const pl = await newPlaylist();
    if (pl) { setView(pl.id); renderViews(); renderTracks(); }
    return;
  }
  const btn = e.target.closest('[data-view]');
  if (!btn) return;
  if (btn.dataset.view === state.view && state.view !== 'all') { openPlaylistSheet(); return; }
  setView(btn.dataset.view);
  renderViews();
  renderTracks();
  btn.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
});

function openPlaylistSheet() {
  const pl = currentPlaylist();
  if (!pl) return;
  $('pl-sheet-title').textContent = pl.name;
  $('pl-sheet-sub').textContent = `${pl.track_ids.length} song${pl.track_ids.length === 1 ? '' : 's'}`;
  openSheet($('playlist-sheet'));
}

$('pl-rename').addEventListener('click', async () => {
  const pl = currentPlaylist();
  closeSheets();
  const name = prompt('Rename playlist', pl.name)?.trim();
  if (!name || name === pl.name) return;
  if (await playlistCall(`/playlists/${pl.id}`, 'PATCH', { name })) await refreshPlaylists().catch(() => {});
});

$('pl-delete').addEventListener('click', async () => {
  const pl = currentPlaylist();
  closeSheets();
  if (!confirm(`Delete the playlist “${pl.name}”? The songs stay in your library.`)) return;
  if (await playlistCall(`/playlists/${pl.id}`, 'DELETE')) await refreshPlaylists().catch(() => {});
});

// "Add to playlist" picker: tap a playlist to add or remove the song.
function openPickSheet(trackId) {
  sheetTrack = trackId;
  $('pick-title').textContent = `Add “${trackById(trackId)?.title}” to…`;
  renderPickList();
  openSheet($('pick-sheet'));
}

function renderPickList() {
  const section = sectionOf(trackById(sheetTrack));
  $('pick-list').innerHTML = state.playlists.filter((pl) => sectionOf(pl) === section).map((pl) => {
    const on = pl.track_ids.includes(sheetTrack);
    return `<button type="button" class="pick${on ? ' on' : ''}" data-pick="${pl.id}">
      <span>${esc(pl.name)}</span><span class="check">${on ? ICONS.local : ''}</span></button>`;
  }).join('') || '<p class="empty-note">No playlists yet.</p>';
}

$('pick-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-pick]');
  if (!btn) return;
  const pl = state.playlists.find((p) => p.id === btn.dataset.pick);
  const on = pl.track_ids.includes(sheetTrack);
  const updated = on
    ? await playlistCall(`/playlists/${pl.id}/tracks/${sheetTrack}`, 'DELETE')
    : await playlistCall(`/playlists/${pl.id}/tracks`, 'POST', { track_id: sheetTrack });
  if (!updated) return;
  setPlaylists(state.playlists.map((p) => (p.id === updated.id ? updated : p)));
  renderPickList();
});

$('pick-new').addEventListener('click', async () => {
  const pl = await newPlaylist();
  if (!pl) return;
  const updated = await playlistCall(`/playlists/${pl.id}/tracks`, 'POST', { track_id: sheetTrack });
  if (updated) setPlaylists(state.playlists.map((p) => (p.id === updated.id ? updated : p)));
  renderPickList();
});

/* ---------- track list ---------- */

function renderTracks() {
  const list = visibleTracks();
  const pl = currentPlaylist();
  $('empty').hidden = pl ? list.length > 0 : allTracks().length > 0;
  $('empty').textContent = pl ? `This playlist is empty. Use ${state.section === 'music' ? 'a song’s' : 'an episode’s'} ⋯ menu to add it here.`
    : state.section === 'music' ? 'No music yet. Paste a link above to add some.'
    : 'No podcasts yet. Paste a link above while on this tab, or move something here from Music with its ⋯ menu.';
  $('list-actions').hidden = list.length === 0;
  $('tracks').innerHTML = list.map((t) => {
    const cover = coverUrl(t);
    const [cls, icon, label] = state.local.has(t.id) ? ['local', ICONS.local, 'Saved on this device']
      : state.saving.has(t.id) ? ['saving', ICONS.saving, 'Saving to this device']
      : ['', ICONS.cloud, 'On your PC only'];
    const info = progressInfo(t);
    const sub = [t.artist, info ? info.text : fmtTime(t.duration)].filter(Boolean).join(' · ');
    const bar = info?.frac != null && !info.played ? `<span class="resume-bar"><span style="width:${Math.round(info.frac * 100)}%"></span></span>` : '';
    return `<li class="track${t.id === state.current ? ' playing' : ''}${isPlayable(t.id) ? '' : ' unavailable'}" data-id="${t.id}">
      <button class="main" type="button">
        <span class="cover"><img alt="" ${cover ? `src="${esc(cover)}"` : ''} onerror="this.removeAttribute('src')"></span>
        <span class="meta${info?.played ? ' played' : ''}"><strong>${esc(t.title)}</strong><small>${esc(sub)}</small>${bar}</span>
      </button>
      <span class="state ${cls}" title="${label}" aria-label="${label}">${icon}</span>
      <button class="icon-btn more" type="button" aria-label="More">${ICONS.more}</button>
    </li>`;
  }).join('');
}

$('tracks').addEventListener('click', (e) => {
  const li = e.target.closest('.track');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('.more')) { openTrackSheet(id); return; }
  if (!isPlayable(id)) { toast('This song isn’t saved here and your PC is offline.'); return; }
  playFromList(id);
});

$('jobs').addEventListener('click', (e) => {
  if (e.target.closest('[data-cancel-queued]')) { cancelQueued(); return; }
  const retry = e.target.closest('[data-retry]');
  if (retry) { retryJobs([retry.dataset.retry]); return; }
  const failedIds = () => state.jobs.filter((j) => j.status === 'error' && !state.dismissed.has(j.id)).map((j) => j.id);
  if (e.target.closest('[data-retry-all]')) { retryJobs(failedIds()); return; }
  if (e.target.closest('[data-dismiss-all]')) { failedIds().forEach(dismissJob); return; }
  const btn = e.target.closest('[data-dismiss]');
  if (btn) dismissJob(btn.dataset.dismiss);
});

$('search').addEventListener('input', (e) => { state.filter = e.target.value; renderTracks(); });

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('add-url');
  const btn = e.submitter || e.target.querySelector('button');
  btn.disabled = true;
  await addUrl(input.value);
  btn.disabled = false;
  input.value = '';
  input.blur();
});

/* ---------- resume where you left off (podcasts and long items) ---------- */

const RESUME_MIN_SECONDS = 20 * 60; // music this long (e.g. a mix) resumes too
// Stopping in the last 30 s (or last 10% of a short item) counts as played.
const finishedWithin = (duration) => Math.min(30, duration * 0.1);
const REWIND_ON_RESUME = 5;         // pick up a few seconds early for context

const progress = prefs.get('progress', {}); // track id -> { pos, played, at }
const isResumable = (t, duration) => !!t
  && (sectionOf(t) === 'podcasts' || (t.duration || duration || 0) >= RESUME_MIN_SECONDS);

let lastPush = 0;
function persistProgress(urgent) {
  prefs.set('progress', progress);
  if (urgent || Date.now() - lastPush > 15000) pushProgress();
}

// Send this device's positions to the PC and take any newer ones from other devices.
async function pushProgress() {
  if (!state.online) return;
  lastPush = Date.now();
  try {
    const res = await api('/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: progress }),
    });
    let changed = false;
    for (const [id, entry] of Object.entries(await res.json())) {
      if (!progress[id] || entry.at > progress[id].at) { progress[id] = entry; changed = true; }
    }
    if (changed) { prefs.set('progress', progress); renderTracks(); }
  } catch { /* offline; the next sync sends it */ }
}

// Save where a player is in a resumable item. Only once the saved spot has been applied to
// that player, so the 0:00 it sits at while loading never overwrites real progress.
function recordProgress(id, el, urgent = false) {
  const t = trackById(id);
  if (!id || el.dataset.resumeFor !== id || !isResumable(t, el.duration)) return;
  if (!Number.isFinite(el.duration) || !el.duration) return;
  const played = el.ended || el.duration - el.currentTime < finishedWithin(el.duration);
  const before = progressInfo(t)?.text;
  progress[id] = { pos: played ? 0 : Math.floor(el.currentTime), played, at: Date.now() };
  persistProgress(urgent);
  if (urgent || progressInfo(t)?.text !== before) renderTracks();
}

// Once a player has loaded an item, jump to where it was left off (if it's resumable and unfinished).
function applyResume(el, id) {
  delete el.dataset.resumeFor;
  const url = el.src;
  const go = () => {
    if (el.src !== url) return; // the player moved on to something else meanwhile
    const p = progress[id];
    const d = el.duration;
    if (p && !p.played && p.pos > 10 && isResumable(trackById(id), d) && p.pos < d - finishedWithin(d)) {
      el.currentTime = Math.max(0, p.pos - REWIND_ON_RESUME);
      logPlay(`resume ${trackById(id)?.title} at ${fmtTime(el.currentTime)}`);
    }
    el.dataset.resumeFor = id;
  };
  if (el.readyState >= 1) go(); else el.addEventListener('loadedmetadata', go, { once: true });
}

function progressInfo(t) {
  const p = progress[t.id];
  if (!p || !isResumable(t)) return null;
  if (p.played) return { text: 'Played', frac: 1, played: true };
  if (p.pos <= 10) return null;
  if (!t.duration) return { text: `Stopped at ${fmtTime(p.pos)}`, frac: null };
  return { text: `${Math.max(1, Math.round((t.duration - p.pos) / 60))} min left`, frac: p.pos / t.duration };
}

let lastRecord = 0;
function recordWhilePlaying() {
  if (Date.now() - lastRecord < 5000) return;
  lastRecord = Date.now();
  recordProgress(state.current, audio);
}

/* ---------- playback ---------- */

function shuffled(ids, firstId) {
  const rest = ids.filter((id) => id !== firstId);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return firstId ? [firstId, ...rest] : rest;
}

function playFromList(id) {
  state.baseQueue = visibleTracks().map((t) => t.id);
  state.queue = state.shuffle ? shuffled(state.baseQueue, id) : state.baseQueue.slice();
  state.qi = state.queue.indexOf(id);
  playCurrent();
}

// Where the queue goes next from state.qi, or -1 at the end. Skips songs that can't play right now.
function nextIndex(dir, auto) {
  const n = state.queue.length;
  let i = state.qi;
  for (let tries = 0; tries < n; tries++) {
    i += dir;
    if (i >= n) {
      if (auto && state.repeat === 'off') return -1;
      i = 0;
    }
    if (i < 0) i = n - 1;
    if (isPlayable(state.queue[i])) return i;
  }
  return -1;
}

// Resolve a playable URL for a song: the saved copy on this device, else the PC.
async function resolveSrc(id) {
  if (state.local.has(id)) {
    const blob = await db.get('files', `${id}:audio`);
    if (blob) return URL.createObjectURL(blob);
    await removeLocal(id); // iOS evicted it; fall back to the PC copy
  }
  return state.online && state.server.has(id) ? `/api/tracks/${id}/audio` : null;
}

const releaseSrc = (url) => { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); };

// The next song, preloaded on the spare player.
let prepared = null; // { qi, id, url, el }
let finishing = null; // the previous player, still playing its last half-second

function discardPrepared() {
  if (!prepared) return;
  if (prepared.el !== audio) prepared.el.removeAttribute('src');
  releaseSrc(prepared.url);
  prepared = null;
}

async function prepareNext() {
  if (finishing) return; // the spare is still finishing the last song; retried once it's done
  const i = nextIndex(1, true);
  const id = i >= 0 ? state.queue[i] : null;
  if (prepared?.id === id && prepared?.qi === i) return;
  discardPrepared();
  if (!id || state.repeat === 'one') return;
  const url = await resolveSrc(id);
  // The queue may have changed, or a handoff happened, while we were loading.
  if (!url || prepared || finishing || state.queue[i] !== id || nextIndex(1, true) !== i) { releaseSrc(url); return; }
  const el = spareOf();
  el.loop = false;
  el.src = url;
  el.load();
  applyResume(el, id);
  prepared = { qi: i, id, url, el };
}

let resumeWhenVisible = false;

function watchPlay(el, label) {
  el.play().then(() => {
    resumeWhenVisible = false;
    logPlay(`${label}: playing`);
  }).catch((e) => {
    if (e.name === 'AbortError') return;
    logPlay(`${label}: play() refused (${e.name})`);
    resumeWhenVisible = document.hidden; // iOS blocked it in the background
    renderPlayState();
  });
}

function afterTrackChange() {
  audio.loop = state.repeat === 'one';
  updatePositionState(); // a preloaded song already knows its length; otherwise this clears the old one
  renderProgress();
  renderNowPlaying();
  renderTracks();
  updateMediaSession(trackById(state.current));
  prepareNext();
}

// Start a song on the active player (user picked it, or nothing was preloaded).
function startTrack(id, url) {
  recordProgress(state.current, audio, true);
  discardPrepared();
  releaseSrc(audioUrl);
  audioUrl = url;
  audio.src = url;
  applyResume(audio, id);
  state.current = id;
  watchPlay(audio, `start ${trackById(id)?.title}`);
  afterTrackChange();
}

// Switch to the preloaded song on the spare player. With overlap, the old player is left to
// finish its last half-second so the audio never goes silent.
function handoff(overlap) {
  const p = prepared;
  prepared = null;
  const old = audio;
  recordProgress(state.current, old, true);
  const oldUrl = audioUrl;
  audio = p.el;
  audioUrl = p.url;
  state.qi = p.qi;
  state.current = p.id;
  watchPlay(audio, `handoff${overlap ? '' : ' (no overlap)'} → ${trackById(p.id)?.title}`);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    old.pause();
    old.removeAttribute('src');
    releaseSrc(oldUrl);
    if (finishing === old) finishing = null;
    prepareNext();
  };
  if (overlap && !old.paused && !old.ended) {
    finishing = old;
    old.addEventListener('ended', cleanup, { once: true });
    setTimeout(cleanup, (HANDOFF_SECONDS + 1.5) * 1000); // in case 'ended' never comes
  } else {
    cleanup();
  }
  afterTrackChange();
}

const canHandoff = () => prepared && state.repeat !== 'one'
  && prepared.qi === nextIndex(1, true) && state.queue[prepared.qi] === prepared.id;

async function playCurrent() {
  const id = state.queue[state.qi];
  if (!trackById(id)) return;
  if (prepared?.id === id && prepared.qi === state.qi) { handoff(false); return; }
  const url = await resolveSrc(id);
  if (!url) { toast('That song isn’t available offline.'); return; }
  startTrack(id, url);
}

function step(dir, auto = false) {
  if (!state.queue.length) return;
  if (dir < 0 && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const i = nextIndex(dir, auto);
  if (i < 0) { renderPlayState(); return; }
  state.qi = i;
  playCurrent();
}

// Normal path: start the next song a moment before this one ends.
function onTimeUpdate() {
  renderProgress();
  if (Date.now() - lastPositionReport > 10000) updatePositionState(); // correct any drift
  recordWhilePlaying();
  const left = audio.duration - audio.currentTime;
  if (!audio.paused && left < HANDOFF_SECONDS && canHandoff()) handoff(true);
}

// Fallback if the early handoff was missed (timeupdate can be sparse in the background).
function onEnded() {
  recordProgress(state.current, audio, true);
  logPlay(`ended: ${trackById(state.current)?.title}`);
  if (canHandoff()) { handoff(false); return; }
  step(1, true);
}

function togglePlay() {
  if (!state.current) {
    const first = visibleTracks().find((t) => isPlayable(t.id));
    if (first) playFromList(first.id);
    return;
  }
  audio.paused ? audio.play() : audio.pause();
}

function renderPlayState() {
  const icon = audio.paused ? ICONS.play : ICONS.pause;
  $('mini-play').innerHTML = icon;
  $('play').innerHTML = icon;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}

function renderModes() {
  $('shuffle').classList.toggle('on', state.shuffle);
  $('repeat').classList.toggle('on', state.repeat !== 'off');
  $('repeat').innerHTML = state.repeat === 'one' ? ICONS.repeatOne : ICONS.repeat;
}

function renderNowPlaying() {
  const t = state.current && trackById(state.current);
  $('mini').hidden = !t;
  if (!t) { $('player').hidden = true; return; }
  const cover = coverUrl(t);
  for (const img of [$('mini-cover'), $('player-cover')]) {
    if (cover) img.src = cover; else img.removeAttribute('src');
  }
  $('mini-title').textContent = $('player-title').textContent = t.title;
  $('mini-artist').textContent = $('player-artist').textContent = t.artist || '';
  renderPlayState();
}

let seeking = false;
function renderProgress() {
  const d = audio.duration, c = audio.currentTime;
  const frac = d ? c / d : 0;
  $('mini-bar').style.width = `${frac * 100}%`;
  if (!seeking) {
    $('seek').value = Math.round(frac * 1000);
    $('t-cur').textContent = fmtTime(c) || '0:00';
  }
  $('t-dur').textContent = fmtTime(d) || '0:00';
}

async function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  const artwork = [];
  if (t.has_cover) {
    // Lock screen can't read blob: URLs reliably, so hand it a data: URL.
    const blob = state.local.has(t.id)
      ? await db.get('files', `${t.id}:cover`)
      : await api(`/tracks/${t.id}/cover`).then((r) => r.blob()).catch(() => null);
    if (blob) {
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
      if (dataUrl) artwork.push({ src: dataUrl, sizes: '512x512', type: blob.type || 'image/jpeg' });
    }
  }
  if (state.current !== t.id) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: 'BerryGoodTunes', artwork });
}

// Tells iOS where playback is, for the lock screen, Control Center and car displays. iOS keeps
// counting from the last report on its own, so this must be re-sent whenever the song changes,
// or it carries on with the previous song's clock.
let lastPositionReport = 0;
function updatePositionState() {
  if (!navigator.mediaSession?.setPositionState) return;
  lastPositionReport = Date.now();
  try {
    if (!Number.isFinite(audio.duration) || !audio.duration) {
      navigator.mediaSession.setPositionState(); // length not known yet: clear the old song's clock
      return;
    }
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime, audio.duration),
      playbackRate: audio.playbackRate || 1,
    });
  } catch { /* ignore invalid states mid-load */ }
}

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => audio.play(),
    pause: () => audio.pause(),
    previoustrack: () => step(-1),
    nexttrack: () => step(1),
    seekto: (d) => { audio.currentTime = d.seekTime; updatePositionState(); },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

// Both players share the handlers; events from the one that isn't active are ignored
// (except errors on a preloaded song, which just drop the preload).
const onActive = (fn) => (e) => { if (e.target === audio && e.target.src !== SILENT) fn(e); };
for (const el of players) {
  el.addEventListener('play', onActive(renderPlayState));
  el.addEventListener('playing', onActive(updatePositionState));
  el.addEventListener('durationchange', onActive(updatePositionState));
  el.addEventListener('pause', onActive(() => { renderPlayState(); updatePositionState(); recordProgress(state.current, audio, true); }));
  el.addEventListener('timeupdate', onActive(onTimeUpdate));
  el.addEventListener('loadedmetadata', onActive(() => { renderProgress(); updatePositionState(); }));
  el.addEventListener('seeked', onActive(() => { updatePositionState(); recordProgress(state.current, audio, true); }));
  el.addEventListener('ended', onActive(onEnded));
  for (const type of ['stalled', 'waiting']) el.addEventListener(type, onActive(() => logPlay(type)));
  el.addEventListener('error', (e) => {
    if (!el.getAttribute('src') || el.src === SILENT) return;
    if (e.target !== audio) { logPlay('preload failed'); discardPrepared(); return; }
    logPlay(`error ${el.error?.code}`);
    toast('Couldn’t play that song.');
    renderPlayState();
  });
}

// iOS only lets a player start without a tap once it has been played from a tap. Play a
// moment of silence on both on the first touch so either can take over in the background.
const SILENT = 'data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const unlocked = new WeakSet();
document.addEventListener('click', () => {
  for (const el of players) {
    if (unlocked.has(el)) continue;
    unlocked.add(el);
    if (el.getAttribute('src')) continue;
    el.src = SILENT;
    el.play().then(() => { if (el.src === SILENT) { el.pause(); el.removeAttribute('src'); } }).catch(() => {});
  }
}, { capture: true });

$('mini-play').addEventListener('click', togglePlay);
$('play').addEventListener('click', togglePlay);
$('mini-next').addEventListener('click', () => step(1));
$('next').addEventListener('click', () => step(1));
$('prev').addEventListener('click', () => step(-1));
$('mini-open').addEventListener('click', () => { $('player').hidden = false; });
$('player-close').addEventListener('click', () => { $('player').hidden = true; });

$('shuffle').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  prefs.set('shuffle', state.shuffle);
  if (state.queue.length) {
    state.queue = state.shuffle ? shuffled(state.baseQueue, state.current) : state.baseQueue.slice();
    state.qi = Math.max(0, state.queue.indexOf(state.current));
  }
  renderModes();
  prepareNext();
});

$('repeat').addEventListener('click', () => {
  state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
  prefs.set('repeat', state.repeat);
  audio.loop = state.repeat === 'one';
  renderModes();
  prepareNext();
});

// "Play" / "Shuffle" above the list: play everything currently shown (respects the search box).
function playAll(shuffle) {
  state.shuffle = shuffle;
  prefs.set('shuffle', shuffle);
  renderModes();
  const playable = visibleTracks().filter((t) => isPlayable(t.id));
  if (!playable.length) { toast('No songs available to play right now.'); return; }
  const first = shuffle ? playable[Math.floor(Math.random() * playable.length)] : playable[0];
  playFromList(first.id);
}
$('play-all').addEventListener('click', () => playAll(false));
$('shuffle-all').addEventListener('click', () => playAll(true));

$('seek').addEventListener('input', (e) => {
  seeking = true;
  $('t-cur').textContent = fmtTime((e.target.value / 1000) * (audio.duration || 0)) || '0:00';
});
$('seek').addEventListener('change', (e) => {
  if (Number.isFinite(audio.duration)) audio.currentTime = (e.target.value / 1000) * audio.duration;
  seeking = false;
});

/* ---------- sheets ---------- */

let sheetTrack = null;

function openSheet(el) {
  $('sheet-backdrop').hidden = false;
  el.hidden = false;
}

function closeSheets() {
  $('sheet-backdrop').hidden = true;
  $('track-sheet').hidden = true;
  $('settings-sheet').hidden = true;
  $('log-sheet').hidden = true;
  $('playlist-sheet').hidden = true;
  $('pick-sheet').hidden = true;
}

function openTrackSheet(id) {
  const t = trackById(id);
  if (!t) return;
  sheetTrack = id;
  $('sheet-title').textContent = t.title;
  const where = state.local.has(id) ? 'Saved on this device' : 'On your PC only';
  $('sheet-sub').textContent = [t.artist, where, t.size && fmtBytes(t.size)].filter(Boolean).join(' · ');
  $('sheet-save').hidden = state.local.has(id) || !state.online || !state.server.has(id);
  $('sheet-source').hidden = !t.source_url;
  $('sheet-add-pl').hidden = !state.server.has(id);
  const pl = currentPlaylist();
  $('sheet-remove-pl').hidden = !pl;
  if (pl) $('sheet-remove-pl').textContent = `Remove from “${pl.name}”`;
  $('sheet-move').hidden = !state.server.has(id);
  $('sheet-played').hidden = !isResumable(t);
  $('sheet-played').textContent = progress[id]?.played || progress[id]?.pos > 10 ? 'Mark as unplayed' : 'Mark as played';
  $('sheet-move').textContent = `Move to ${SECTION_NAMES[otherSection(sectionOf(t))]}`;
  openSheet($('track-sheet'));
}

$('sheet-save').addEventListener('click', () => { closeSheets(); saveTrack(sheetTrack); });
$('sheet-source').addEventListener('click', () => {
  const t = trackById(sheetTrack);
  closeSheets();
  if (t?.source_url) window.open(t.source_url, '_blank', 'noopener');
});
$('sheet-delete').addEventListener('click', () => { closeSheets(); deleteTrack(sheetTrack); });
$('sheet-add-pl').addEventListener('click', () => { closeSheets(); openPickSheet(sheetTrack); });
$('sheet-played').addEventListener('click', () => {
  closeSheets();
  const p = progress[sheetTrack];
  const played = !(p?.played || p?.pos > 10); // "unplayed" also clears a half-way position
  progress[sheetTrack] = { pos: 0, played, at: Date.now() };
  persistProgress(true);
  renderTracks();
});
$('sheet-move').addEventListener('click', async () => {
  closeSheets();
  const id = sheetTrack;
  const section = otherSection(sectionOf(trackById(id)));
  if (!state.online) { toast('Connect to your PC to move songs.'); return; }
  try {
    const updated = await (await api(`/tracks/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section }),
    })).json();
    state.server.set(id, updated);
    await refreshTracks();      // also updates this device's saved copy
    await refreshPlaylists();   // it left the old section's playlists
    toast(`Moved to ${SECTION_NAMES[section]}.`);
  } catch {
    toast('Couldn’t reach your PC.');
  }
});
$('sheet-remove-pl').addEventListener('click', async () => {
  closeSheets();
  const pl = currentPlaylist();
  const updated = pl && await playlistCall(`/playlists/${pl.id}/tracks/${sheetTrack}`, 'DELETE');
  if (updated) setPlaylists(state.playlists.map((p) => (p.id === updated.id ? updated : p)));
});

async function openSettings() {
  $('autosave').checked = state.autosave;
  $('ytdlp').textContent = state.ytdlp || '–';
  $('jsruntime').textContent = !state.online ? '–' : state.jsRuntime ? `${state.jsRuntime} ✓` : 'Missing!';
  $('jsruntime-row').classList.toggle('warn', state.online && !state.jsRuntime);
  $('storage').textContent = '…';
  openSheet($('settings-sheet'));
  let used = 0;
  for (const t of state.local.values()) used += t.size || 0;
  $('storage').textContent = `${fmtBytes(used)} · ${state.local.size} songs`;
}

$('open-settings').addEventListener('click', openSettings);
$('autosave').addEventListener('change', (e) => {
  state.autosave = e.target.checked;
  prefs.set('autosave', state.autosave);
  if (state.autosave && state.online) saveMissing();
});
$('save-all').addEventListener('click', () => {
  closeSheets();
  if (!state.online) { toast('Your PC is offline.'); return; }
  saveMissing();
});
$('open-log').addEventListener('click', () => {
  closeSheets();
  $('log-text').textContent = playLog.length ? playLog.slice().reverse().join('\n') : 'Nothing logged yet.';
  openSheet($('log-sheet'));
});
$('log-clear').addEventListener('click', () => {
  playLog.length = 0;
  prefs.set('playlog', playLog);
  $('log-text').textContent = 'Nothing logged yet.';
});
$('sheet-backdrop').addEventListener('click', closeSheets);
document.querySelectorAll('.sheet-cancel').forEach((b) => b.addEventListener('click', closeSheets));
$('status').addEventListener('click', () => {
  toast(state.online ? 'Connected to your PC.' : 'Can’t reach your PC. Check it’s on and Tailscale is connected.');
  sync();
});

/* ---------- sync loop ---------- */

let syncing = false;
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    if (!(await checkHealth())) return;
    await flushPending();
    await refreshTracks();
    await refreshPlaylists();
    await pushProgress();
    await pollJobs();
    if (state.autosave) saveMissing();
  } catch {
    /* went offline mid-sync; next tick retries */
  } finally {
    syncing = false;
    renderJobs();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { logPlay('app hidden'); recordProgress(state.current, audio, true); return; }
  logPlay(`app opened (player ${audio.paused ? 'paused' : 'playing'})`);
  if (resumeWhenVisible && state.current && audio.paused) {
    resumeWhenVisible = false;
    logPlay('resuming after background block');
    audio.play().catch(() => {});
  }
  sync();
});
window.addEventListener('online', sync);
setInterval(() => { if (!document.hidden) sync(); }, 30000);

/* ---------- boot ---------- */

async function boot() {
  $('prev').innerHTML = ICONS.prev;
  $('next').innerHTML = ICONS.next;
  $('mini-next').innerHTML = ICONS.next;
  $('shuffle').innerHTML = ICONS.shuffle;
  $('play-all').insertAdjacentHTML('afterbegin', ICONS.play);
  $('shuffle-all').insertAdjacentHTML('afterbegin', ICONS.shuffle);
  renderModes();
  renderPlayState();

  try { await loadLocal(); } catch { toast('Couldn’t open saved songs on this device.'); }
  renderSection();
  renderViews();
  renderTracks();
  renderJobs();

  // Links arriving from the iOS Shortcut: /?add=<url>
  const params = new URLSearchParams(location.search);
  const shared = params.get('add') || params.get('url') || params.get('text');
  if (shared) {
    history.replaceState(null, '', location.pathname);
    await sync();
    await addUrl(shared);
  } else {
    sync();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();

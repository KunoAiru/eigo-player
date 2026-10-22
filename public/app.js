import { parseID3, id3TagSize } from './id3.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];
const REPEAT = { all: '連続', one: '1曲↻', off: '1曲停止' };
const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;

const state = {
  books: [],          // {id, title, source: 'server' | 'local', tracks}
  serverUrls: [],
  bookId: store.get('book', null),
  query: '',
  chip: 'all',
  playing: null,      // {book, index}
  repeat: store.get('repeat', 'all'),
  rate: store.get('rate', 1),
  dragging: false,
};

/* ---------------- search ---------------- */

const norm = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function indexTrack(t) {
  const base = norm(`${t.title} ${t.file} ${t.discLabel} cd${t.disc}`);
  const aliases = [];
  base.replace(/rank ?(\d+)/g, (_, n) => aliases.push(`r${n}`, `rank${n}`));
  base.replace(/(\d+)週目?(\d+)日/g, (_, w, d) => aliases.push(`${w}-${d}`, `w${w}d${d}`, `${w}週${d}日`));
  t.search = `${base} ${aliases.join(' ')}`;
  t.ranges = [...t.title.normalize('NFKC').matchAll(/(\d{2,})\s*[-~〜–]\s*(\d{2,})/g)].map((m) => [+m[1], +m[2]]);
  const sec = t.title.normalize('NFKC').match(/^(rank|unit|chapter|part|lesson|day|section)\s*(\d+)/i);
  t.section = sec ? `${sec[1].toUpperCase()}${sec[2]}` : '';
  t.discKey = t.discLabel || `CD${t.disc}`;
  return t;
}

function matches(t, tokens) {
  return tokens.every((tok) => {
    if (t.search.includes(tok)) return true;
    if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      return t.ranges.some(([a, b]) => n >= a && n <= b);
    }
    return false;
  });
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function highlight(text, tokens) {
  const words = tokens.filter((t) => !/^\d$/.test(t))
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return escapeHtml(text);
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part))).join('');
}

/* ---------------- library ---------------- */

async function loadLibrary() {
  const books = [];
  const local = await db.getAllTracks().catch(() => []);
  const byBook = new Map();
  for (const rec of local) {
    if (!byBook.has(rec.bookId)) byBook.set(rec.bookId, { id: rec.bookId, title: rec.bookTitle, source: 'local', tracks: [] });
    const { blob, ...meta } = rec;
    byBook.get(rec.bookId).tracks.push({ ...meta, local: true });
  }
  const collator = new Intl.Collator('ja', { numeric: true });
  for (const book of byBook.values()) {
    book.tracks.sort((a, b) => a.disc - b.disc || (a.track ?? 1e9) - (b.track ?? 1e9) || collator.compare(a.id, b.id));
    books.push(book);
  }

  try {
    const res = await fetch('api/library', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      state.serverUrls = data.urls || [];
      for (const b of data.books) {
        // A copy saved on the phone wins: it keeps working when the PC is off.
        if (books.some((x) => x.title === b.title)) continue;
        books.push({ ...b, id: `server:${b.id}`, source: 'server' });
      }
    }
  } catch { /* no PC server: offline / hosted mode */ }

  books.forEach((b) => b.tracks.forEach(indexTrack));
  state.books = books;
  if (!books.some((b) => b.id === state.bookId)) state.bookId = books[0]?.id ?? null;
}

const currentBook = () => state.books.find((b) => b.id === state.bookId);

/* ---------------- rendering ---------------- */

function renderBooks() {
  const sel = $('bookSelect');
  sel.innerHTML = state.books.length
    ? state.books.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.title)}${b.source === 'local' ? '（端末）' : ''}</option>`).join('')
    : '<option>音声がありません</option>';
  sel.value = state.bookId ?? '';
  sel.disabled = state.books.length < 2;
}

function renderChips() {
  const book = currentBook();
  const el = $('chips');
  if (!book) { el.innerHTML = ''; return; }
  const uniq = (key) => [...new Set(book.tracks.map((t) => t[key]).filter(Boolean))];
  const sections = uniq('section');
  const discs = uniq('discKey');
  const chip = (value, label) => `<button class="chip" role="tab" data-chip="${escapeHtml(value)}" aria-selected="${state.chip === value}">${escapeHtml(label)}</button>`;
  const parts = [chip('all', 'すべて')];
  if (sections.length > 1) parts.push(...sections.map((s) => chip(`sec:${s}`, s)));
  if (discs.length > 1) {
    if (sections.length > 1) parts.push('<span class="chip-sep"></span>');
    parts.push(...discs.map((d) => chip(`disc:${d}`, d)));
  }
  el.innerHTML = parts.length > 1 ? parts.join('') : '';
}

function visibleTracks(book) {
  const tokens = norm(state.query).split(' ').filter(Boolean);
  const [kind, val] = state.chip.split(/:(.*)/);
  return book.tracks
    .map((t, index) => ({ t, index }))
    .filter(({ t }) => (kind === 'sec' ? t.section === val : kind === 'disc' ? t.discKey === val : true))
    .filter(({ t }) => matches(t, tokens));
}

function renderList() {
  const book = currentBook();
  const list = $('list');
  const status = $('status');
  if (!book) {
    list.innerHTML = '';
    status.textContent = '';
    list.innerHTML = `<li class="empty">音声がまだありません。<br>右上のメニューから「スマホに音声を取り込む」を選んでください。</li>`;
    return;
  }
  const tokens = norm(state.query).split(' ').filter(Boolean);
  const rows = visibleTracks(book);
  const filtered = tokens.length || state.chip !== 'all';
  status.textContent = filtered ? `${rows.length} 件 / 全 ${book.tracks.length} 件` : `全 ${book.tracks.length} 件`;
  if (!rows.length) {
    list.innerHTML = '<li class="empty">見つかりませんでした</li>';
    return;
  }
  const playingHere = state.playing?.book === book ? state.playing.index : -1;
  list.innerHTML = rows.map(({ t, index }) => {
    const cur = index === playingHere;
    const num = cur ? '<span class="eq"><i></i><i></i><i></i></span>' : (t.track ?? index + 1);
    const sub = [t.discKey, t.file !== t.title ? t.file : ''].filter(Boolean).join(' · ');
    return `<li class="item${cur ? ' current' : ''}" data-index="${index}">
      <span class="num">${num}</span>
      <span class="txt"><div class="title">${highlight(t.title, tokens)}</div><div class="sub">${escapeHtml(sub)}</div></span>
    </li>`;
  }).join('');
  updateJumpButton();
}

const render = () => { renderBooks(); renderChips(); renderList(); };

const fmt = (sec) => {
  if (!Number.isFinite(sec)) return '0:00';
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

function renderNowPlaying() {
  const p = state.playing;
  const t = p?.book.tracks[p.index];
  $('npTitle').textContent = t ? t.title : '音声を選んでください';
  $('npSub').textContent = t ? `${p.book.title} · ${t.discKey}${t.track ? ` · Track ${t.track}` : ''}` : '';
  $('prevBtn').disabled = !t;
  $('nextBtn').disabled = !t || p.index >= p.book.tracks.length - 1;
  $('rateBtn').textContent = `${state.rate}×`;
  $('rateBtn').classList.toggle('on', state.rate !== 1);
  $('repeatBtn').textContent = REPEAT[state.repeat];
  $('repeatBtn').classList.toggle('on', state.repeat !== 'all');
}

function renderTime() {
  const dur = audio.duration || 0;
  const cur = state.dragging ? Number($('seek').value) : audio.currentTime;
  const seek = $('seek');
  seek.max = dur || 0;
  if (!state.dragging) seek.value = cur;
  seek.style.setProperty('--p', dur ? `${(cur / dur) * 100}%` : '0%');
  $('cur').textContent = fmt(cur);
  $('dur').textContent = fmt(dur);
}

function updateJumpButton() {
  const el = document.querySelector('.item.current');
  let show = false;
  if (state.playing && state.playing.book !== currentBook()) show = true;
  else if (el) {
    const r = el.getBoundingClientRect();
    const bottom = $('player').getBoundingClientRect().top;
    const top = document.querySelector('.top').getBoundingClientRect().bottom;
    show = r.bottom < top || r.top > bottom;
  }
  $('jumpNow').hidden = !show;
}

function jumpToCurrent() {
  if (!state.playing) return;
  if (state.playing.book !== currentBook()) {
    state.bookId = state.playing.book.id;
    store.set('book', state.bookId);
  }
  state.chip = 'all';
  state.query = '';
  $('search').value = '';
  $('clearSearch').hidden = true;
  render();
  document.querySelector('.item.current')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------------- playback ---------------- */

let objectUrl = null;
let pendingSeek = 0;

async function loadTrack(book, index, { autoplay = true, startAt = 0 } = {}) {
  const t = book.tracks[index];
  if (!t) return;
  state.playing = { book, index };
  let src = t.url;
  if (t.local) {
    const rec = await db.getTrack(t.id);
    if (!rec) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(rec.blob);
    src = objectUrl;
  }
  pendingSeek = startAt;
  audio.src = src;
  audio.defaultPlaybackRate = state.rate;
  audio.playbackRate = state.rate;
  if (autoplay) audio.play().catch(() => {});
  renderNowPlaying();
  renderTime();
  renderList();
  saveResume(true);
  updateMediaSession();
}

function togglePlay() {
  if (!state.playing) {
    const book = currentBook();
    const first = book && visibleTracks(book)[0];
    if (first) loadTrack(book, first.index);
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function step(delta) {
  const p = state.playing;
  if (!p) return;
  if (delta < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  const next = p.index + delta;
  if (next >= 0 && next < p.book.tracks.length) loadTrack(p.book, next, { autoplay: true });
}

function skip(sec) {
  if (!state.playing || !Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.min(Math.max(audio.currentTime + sec, 0), audio.duration - 0.05);
  renderTime();
}

let lastSave = 0;
function saveResume(force) {
  const p = state.playing;
  if (!p) return;
  const now = Date.now();
  if (!force && now - lastSave < 3000) return;
  lastSave = now;
  store.set('resume', { bookId: p.book.id, trackId: p.book.tracks[p.index].id, time: audio.currentTime || pendingSeek || 0 });
}

function restoreResume() {
  const r = store.get('resume', null);
  if (!r) return;
  const book = state.books.find((b) => b.id === r.bookId)
    // Same book saved under another source (PC server vs phone copy).
    ?? state.books.find((b) => b.tracks.some((t) => t.id.endsWith(r.trackId.split('/').slice(1).join('/'))));
  if (!book) return;
  const tail = r.trackId.split('/').slice(1).join('/');
  const index = book.tracks.findIndex((t) => t.id === r.trackId || (tail && t.id.endsWith(tail)));
  if (index >= 0) loadTrack(book, index, { autoplay: false, startAt: r.time });
}

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !state.playing) return;
  const { book, index } = state.playing;
  const t = book.tracks[index];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: book.title,
    album: t.discKey,
    artwork: [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
  });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !Number.isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate });
  } catch { /* unsupported */ }
}

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => audio.play(),
    pause: () => audio.pause(),
    previoustrack: () => step(-1),
    nexttrack: () => step(1),
    seekbackward: (d) => skip(-(d.seekOffset || 10)),
    seekforward: (d) => skip(d.seekOffset || 10),
    seekto: (d) => { audio.currentTime = d.seekTime; renderTime(); },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek && pendingSeek < audio.duration) audio.currentTime = pendingSeek;
  pendingSeek = 0;
  renderTime();
  updatePositionState();
});
audio.addEventListener('timeupdate', () => { renderTime(); saveResume(false); });
audio.addEventListener('durationchange', renderTime);
const syncPlaying = () => {
  const playing = !audio.paused;
  $('player').classList.toggle('is-playing', playing);
  document.body.classList.toggle('playing', playing);
  $('playBtn').setAttribute('aria-label', playing ? '一時停止' : '再生');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  updatePositionState();
};
audio.addEventListener('play', syncPlaying);
audio.addEventListener('pause', () => { syncPlaying(); saveResume(true); });
audio.addEventListener('ratechange', updatePositionState);
audio.addEventListener('seeked', updatePositionState);
audio.addEventListener('ended', () => {
  const p = state.playing;
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (state.repeat === 'all' && p && p.index < p.book.tracks.length - 1) { step(1); return; }
  audio.currentTime = 0;
  saveResume(true);
});

/* ---------------- import to this device ---------------- */

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => AUDIO_RE.test(f.name) || f.type.startsWith('audio/'));
  const status = $('importStatus');
  if (!files.length) { status.textContent = '音声ファイル（mp3 など）が見つかりませんでした。'; return; }
  navigator.storage?.persist?.().catch(() => {});
  const recs = [];
  for (const [i, f] of files.entries()) {
    status.textContent = `読み込み中… ${i + 1} / ${files.length}`;
    let tags = {};
    try {
      const size = id3TagSize(new Uint8Array(await f.slice(0, 10).arrayBuffer()));
      if (size) tags = parseID3(new Uint8Array(await f.slice(0, Math.min(size, 2 * 1024 * 1024)).arrayBuffer()));
    } catch { /* untagged */ }
    const rel = (f.webkitRelativePath || f.name).split('/');
    const folder = rel.length > 1 ? rel[0] : '';
    const sub = rel.slice(1, -1).join('/');
    const base = f.name.replace(/\.[^.]+$/, '');
    const album = tags.album || folder || '取り込んだ音声';
    const bookId = `local:${album}`;
    recs.push({
      id: `${bookId}/${rel.length > 1 ? rel.slice(1).join('/') : f.name}`,
      bookId,
      bookTitle: album,
      title: tags.title || base,
      file: base,
      disc: tags.disc ?? (parseInt(sub.match(/\d+/)?.[0], 10) || 1),
      discLabel: sub || (tags.disc ? `CD${tags.disc}` : ''),
      track: tags.track,
      blob: f,
    });
  }
  try {
    for (let i = 0; i < recs.length; i += 10) {
      status.textContent = `端末に保存中… ${Math.min(i + 10, recs.length)} / ${recs.length}`;
      await db.putTracks(recs.slice(i, i + 10));
    }
  } catch (err) {
    status.textContent = `保存に失敗しました（空き容量を確認してください）: ${err?.message || err}`;
    return;
  }
  const books = [...new Set(recs.map((r) => r.bookTitle))];
  status.textContent = `${recs.length} 件を保存しました: ${books.join('、')}`;
  const keepPlaying = state.playing && { id: state.playing.book.tracks[state.playing.index].id };
  await loadLibrary();
  if (keepPlaying) relinkPlaying(keepPlaying.id);
  state.bookId = `local:${books[0]}`;
  store.set('book', state.bookId);
  state.chip = 'all';
  state.query = '';
  $('search').value = '';
  $('clearSearch').hidden = true;
  render();
  renderMenu();
}

// After the library reloads, point state.playing at the fresh track objects.
function relinkPlaying(trackId) {
  for (const book of state.books) {
    const index = book.tracks.findIndex((t) => t.id === trackId);
    if (index >= 0) { state.playing = { book, index }; return; }
  }
}

async function renderMenu() {
  const local = state.books.filter((b) => b.source === 'local');
  $('localBooks').innerHTML = local.map((b) => `<li><span>${escapeHtml(b.title)}（${b.tracks.length}件）</span><button data-del="${escapeHtml(b.id)}">削除</button></li>`).join('');
  const est = await navigator.storage?.estimate?.().catch(() => null);
  $('storageInfo').textContent = est ? `この端末の使用量: ${(est.usage / 1048576).toFixed(0)} MB` : '';

  const onPc = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const urls = state.serverUrls;
  $('lanSection').hidden = !(onPc && urls.length);
  if (onPc && urls.length) {
    $('lanUrls').innerHTML = urls.map((u) => `<li>${escapeHtml(u)}</li>`).join('');
    showQr(urls[0]);
  }
}

let qrLoading;
function showQr(text) {
  const el = $('qr');
  if (el.dataset.text === text) return;
  qrLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
  qrLoading.then(() => {
    el.innerHTML = '';
    el.dataset.text = text;
    new window.QRCode(el, { text, width: 180, height: 180 });
  }).catch(() => { el.innerHTML = ''; });
}

/* ---------------- events ---------------- */

$('bookSelect').addEventListener('change', (e) => {
  state.bookId = e.target.value;
  state.chip = 'all';
  store.set('book', state.bookId);
  render();
  window.scrollTo(0, 0);
});

$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  $('clearSearch').hidden = !state.query;
  renderList();
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('clearSearch').click(); }
  if (e.key === 'Enter') {
    // Enter plays the top hit.
    const book = currentBook();
    const first = book && visibleTracks(book)[0];
    if (first) { loadTrack(book, first.index); e.target.blur(); }
  }
});
$('clearSearch').addEventListener('click', () => {
  $('search').value = '';
  state.query = '';
  $('clearSearch').hidden = true;
  renderList();
  $('search').focus();
});

$('chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-chip]');
  if (!chip) return;
  state.chip = chip.dataset.chip;
  renderChips();
  renderList();
  chip.scrollIntoView({ inline: 'nearest', block: 'nearest' });
});

$('list').addEventListener('click', (e) => {
  const item = e.target.closest('[data-index]');
  if (!item) return;
  const book = currentBook();
  const index = Number(item.dataset.index);
  if (state.playing?.book === book && state.playing.index === index) togglePlay();
  else loadTrack(book, index);
});

$('playBtn').addEventListener('click', togglePlay);
$('prevBtn').addEventListener('click', () => step(-1));
$('nextBtn').addEventListener('click', () => step(1));
$('backBtn').addEventListener('click', () => skip(-10));
$('fwdBtn').addEventListener('click', () => skip(10));
$('npTitle').addEventListener('click', jumpToCurrent);
$('jumpNow').addEventListener('click', jumpToCurrent);

$('rateBtn').addEventListener('click', () => {
  state.rate = RATES[(RATES.indexOf(state.rate) + 1) % RATES.length] ?? 1;
  audio.defaultPlaybackRate = state.rate;
  audio.playbackRate = state.rate;
  store.set('rate', state.rate);
  renderNowPlaying();
});
$('repeatBtn').addEventListener('click', () => {
  const keys = Object.keys(REPEAT);
  state.repeat = keys[(keys.indexOf(state.repeat) + 1) % keys.length];
  store.set('repeat', state.repeat);
  renderNowPlaying();
});

const seek = $('seek');
seek.addEventListener('input', () => { state.dragging = true; renderTime(); });
seek.addEventListener('change', () => {
  state.dragging = false;
  if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value);
  renderTime();
});

$('menuBtn').addEventListener('click', () => { renderMenu(); $('menu').showModal(); });
$('menu').addEventListener('click', (e) => { if (e.target === $('menu')) $('menu').close(); });
$('pickDir').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
$('pickFiles').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
$('localBooks').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-del]')?.dataset.del;
  if (!id) return;
  const book = state.books.find((b) => b.id === id);
  if (!confirm(`「${book?.title}」をこの端末から削除しますか？`)) return;
  if (state.playing?.book.id === id) {
    audio.pause();
    audio.removeAttribute('src');
    state.playing = null;
    renderNowPlaying();
    renderTime();
  }
  await db.deleteBook(id);
  await loadLibrary();
  render();
  renderMenu();
});

let scrollTick = false;
window.addEventListener('scroll', () => {
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => { scrollTick = false; updateJumpButton(); });
}, { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, dialog[open]')) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') skip(-10);
  else if (e.key === 'ArrowRight') skip(10);
  else if (e.key === '/') { e.preventDefault(); $('search').focus(); }
});
window.addEventListener('pagehide', () => saveResume(true));

/* ---------------- start ---------------- */

(async () => {
  renderNowPlaying();
  $('status').textContent = '読み込み中…';
  await loadLibrary();
  render();
  restoreResume();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

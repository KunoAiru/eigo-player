// TOEFL listening practice: plays only the question part of each YouTube video (intro and answer key cut)
// and marks each answer the moment it is tapped. Data: listening.json (tools/build_listening.mjs).
import { $, store, escapeHtml } from './util.js';

const KINDS = { test: '模試', response: '応答選択', conversation: '会話', announcement: 'アナウンス', talk: '講義' };
const LETTERS = ['A', 'B', 'C', 'D'];
const RATES = [0.75, 0.9, 1, 1.1, 1.25];

let data = null;
let loading = null;
let hooks = {};
const ui = { chip: store.get('listenChip', 'all') };
const quiz = { video: null, player: null, timer: 0, rate: 1, ready: false };

const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const saved = (id) => store.get(`listen:${id}`, { a: {} });
const save = (id, rec) => store.set(`listen:${id}`, rec);
const questionCount = (v) => (v.groups || []).reduce((n, g) => n + g.answers.length, 0);

// In an answer string, "?" = couldn't be read from the video (left out of the score) and a lowercase
// letter = estimated from a partly hidden answer screen (marked as usual, shown as 推定).
const solution = (ans) => ans.toUpperCase();

function score(v, only) {
  const rec = saved(v.id);
  let done = 0;
  let ok = 0;
  let total = 0;
  (v.groups || []).forEach((g, gi) => {
    if (only !== undefined && gi !== only) return;
    [...g.answers].forEach((ans, qi) => {
      if (!LETTERS.includes(solution(ans))) return;
      total++;
      const pick = rec.a[`${gi}-${qi}`];
      if (!pick) return;
      done++;
      if (pick === solution(ans)) ok++;
    });
  });
  return { done, ok, total };
}

async function load() {
  loading ??= fetch('listening.json').then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then((d) => {
    d.playlists.forEach((p) => p.videos.forEach((v) => { v.playlist = p; }));
    data = d;
  });
  return loading;
}

/* ---------------- list ---------------- */

const allVideos = () => data.playlists.flatMap((p) => p.videos);

function visible() {
  const [kind, val] = ui.chip.split(/:(.*)/);
  return allVideos().filter((v) => (kind === 'pl' ? v.playlist.id === val : kind === 'kind' ? v.kind === val : true));
}

function renderChips() {
  const chip = (value, label) => `<button class="chip" role="tab" data-chip="${escapeHtml(value)}" aria-selected="${ui.chip === value}">${escapeHtml(label)}</button>`;
  const kinds = [...new Set(allVideos().map((v) => v.kind).filter(Boolean))];
  $('listenChips').innerHTML = [
    chip('all', 'すべて'),
    ...data.playlists.map((p) => chip(`pl:${p.id}`, p.short)),
    '<span class="chip-sep"></span>',
    ...Object.keys(KINDS).filter((k) => kinds.includes(k)).map((k) => chip(`kind:${k}`, KINDS[k])),
  ].join('');
}

export async function render() {
  const list = $('listenList');
  const status = $('listenStatus');
  if (!data) {
    status.textContent = '読み込み中…';
    try { await load(); } catch {
      status.textContent = '';
      list.innerHTML = '<li class="empty">リスニングのデータを読み込めませんでした。<br>インターネットに接続してから開き直してください。</li>';
      return;
    }
  }
  renderChips();
  const rows = visible();
  status.textContent = `${rows.length} 本 · タップで問題を開く`;
  list.innerHTML = rows.map((v) => {
    const s = score(v);
    const minutes = Math.round((v.end - v.start) / 60);
    const count = questionCount(v);
    const sub = [v.kind ? KINDS[v.kind] : '解答未登録', count ? `${count}問` : '', `${minutes}分`].filter(Boolean).join(' · ');
    const badge = s.done
      ? `<span class="lbadge${s.done === s.total ? ' full' : ''}">${s.ok}/${s.total}</span>`
      : '';
    return `<li class="item lvideo" data-video="${escapeHtml(v.id)}">
      <img class="thumb" src="https://i.ytimg.com/vi/${escapeHtml(v.id)}/mqdefault.jpg" alt="" loading="lazy">
      <span class="txt"><div class="title">${escapeHtml(v.title)}</div><div class="sub">${escapeHtml(sub)}</div></span>
      ${badge}
    </li>`;
  }).join('') || '<li class="empty">動画がありません</li>';
}

/* ---------------- YouTube player ---------------- */

let apiLoading;
function loadApi() {
  apiLoading ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) { resolve(); return; }
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiLoading = null; reject(new Error('YouTube を読み込めませんでした')); };
    document.head.append(s);
  });
  return apiLoading;
}

const playing = () => quiz.player?.getPlayerState?.() === window.YT?.PlayerState.PLAYING;

function tick() {
  const v = quiz.video;
  const p = quiz.player;
  if (!v || !p?.getCurrentTime) return;
  const t = p.getCurrentTime();
  // Keep playback inside the question part: never into the answer key, never back into the intro.
  if (t >= v.end - 0.25) {
    p.pauseVideo();
    p.seekTo(v.end - 0.5, true);
    showNote('問題はここまでです');
  } else if (t < v.start - 1 && playing()) {
    p.seekTo(v.start, true);
  }
  const rec = saved(v.id);
  if (Math.abs((rec.t || 0) - t) > 2) { rec.t = t; save(v.id, rec); }
  $('quizTime').textContent = `${fmt(Math.max(0, t - v.start))} / ${fmt(v.end - v.start)}`;
  const cur = (v.sections || []).filter(([at]) => at <= t + 0.5).pop()?.[0];
  for (const b of document.querySelectorAll('#quizSections [data-at]')) b.setAttribute('aria-selected', Number(b.dataset.at) === cur);
  renderPlayButton();
}

function renderPlayButton() {
  $('quizPlay').classList.toggle('is-playing', playing());
  $('quizPlay').setAttribute('aria-label', playing() ? '一時停止' : '再生');
}

let noteTimer = 0;
function showNote(text) {
  const el = $('quizNote');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

async function mountPlayer(v, at) {
  $('quizVideo').innerHTML = '<div id="ytPlayer"></div>';
  quiz.ready = false;
  try { await loadApi(); } catch (err) {
    $('quizVideo').innerHTML = `<p class="quiz-err">${escapeHtml(err.message)}<br>インターネットに接続してください。</p>`;
    return;
  }
  if (quiz.video !== v) return;  // closed or switched while the API loaded
  quiz.player = new window.YT.Player('ytPlayer', {
    videoId: v.id,
    host: 'https://www.youtube.com',  // not youtube-nocookie: keeps the Premium sign-in (no ads)
    playerVars: { start: Math.floor(at), end: Math.ceil(v.end), playsinline: 1, rel: 0, iv_load_policy: 3, modestbranding: 1 },
    events: {
      onReady: () => {
        quiz.ready = true;
        quiz.player.setPlaybackRate(quiz.rate);
        tick();
      },
      onStateChange: (e) => {
        if (e.data === window.YT.PlayerState.PLAYING) hooks.pauseAudio?.();
        renderPlayButton();
      },
    },
  });
  clearInterval(quiz.timer);
  quiz.timer = setInterval(tick, 300);
}

function seek(t) {
  const v = quiz.video;
  if (!quiz.ready || !v) return;
  quiz.player.seekTo(Math.min(Math.max(t, v.start), v.end - 1), true);
  tick();
}

/* ---------------- quiz sheet ---------------- */

function renderSheet() {
  const v = quiz.video;
  const rec = saved(v.id);
  const s = score(v);
  $('quizScore').textContent = s.total ? `${s.ok} / ${s.total}` : '';
  $('quizScore').hidden = !s.total;
  if (!v.groups) {
    $('quizSheet').innerHTML = '<p class="note">この動画はまだ解答が登録されていません（tools/listening_keys.json に追加すると答え合わせできます）。</p>';
    return;
  }
  let n = 0;
  $('quizSheet').innerHTML = v.groups.map((g, gi) => {
    const gs = score(v, gi);
    const head = `<div class="qgroup-head">
      <h3>${escapeHtml(g.name)}</h3>
      <span class="qgroup-score">${gs.done ? `${gs.ok}/${gs.total}` : ''}</span>
      ${g.at !== undefined ? `<button class="pill" data-seek="${g.at}">▶ ここから</button>` : ''}
    </div>`;
    const rows = [...g.answers].map((raw, qi) => {
      n++;
      const key = `${gi}-${qi}`;
      const pick = rec.a[key];
      const ans = solution(raw);
      const known = LETTERS.includes(ans);
      const guessed = known && raw !== ans;
      const mark = !pick ? '' : !known ? '<span class="qmark unk">?</span>' : pick === ans ? '<span class="qmark ok">○</span>' : '<span class="qmark ng">×</span>';
      const btns = LETTERS.map((L) => {
        let cls = 'qopt';
        if (pick && known && L === ans) cls += ' ok';
        if (pick && L === pick && (!known || pick !== ans)) cls += known ? ' ng' : ' picked';
        return `<button class="${cls}" data-q="${key}" data-l="${L}" ${pick ? 'disabled' : ''} aria-label="${n}番 ${L}">${L}</button>`;
      }).join('');
      const extra = !pick ? ''
        : !known ? '<span class="qunk">答え不明（動画の解答画面で切れています）</span>'
          : guessed ? '<span class="qunk">正解は推定です（動画の解答画面で一部が切れています）</span>' : '';
      return `<li class="qrow${pick ? ' answered' : ''}"><span class="qno">${n}</span>${btns}${mark}${extra}</li>`;
    }).join('');
    return `<section class="qgroup">${head}<ol class="qlist">${rows}</ol></section>`;
  }).join('') + (s.done ? `<div class="quiz-foot">
      <p>${s.done === s.total ? 'おつかれさまでした！' : `${s.done} / ${s.total} 問回答`}　正解 ${s.ok} 問（${Math.round((s.ok / s.done) * 100)}%）</p>
      <button class="btn ghost" id="quizReset">答えを消してやり直す</button>
    </div>` : '');
}

function renderSections() {
  const v = quiz.video;
  $('quizSections').innerHTML = (v.sections || [])
    .map(([at, label]) => `<button class="chip" data-at="${at}" aria-selected="false">${escapeHtml(label.replace(/^Mod\. (\d) - /, 'M$1 '))}</button>`)
    .join('');
  $('quizSections').hidden = !v.sections?.length;
}

function open(id) {
  const v = allVideos().find((x) => x.id === id);
  if (!v) return;
  quiz.video = v;
  $('quizTitle').textContent = v.title;
  $('quizTime').textContent = '';
  $('quizRate').textContent = `${quiz.rate}×`;
  renderSections();
  renderSheet();
  $('quizSheet').scrollTop = 0;
  $('quiz').showModal();
  const resume = saved(v.id).t;
  mountPlayer(v, resume > v.start && resume < v.end - 5 ? resume : v.start);
}

function close() {
  clearInterval(quiz.timer);
  try { quiz.player?.destroy?.(); } catch { /* already gone */ }
  quiz.player = null;
  quiz.video = null;
  $('quizVideo').innerHTML = '';
  if ($('quiz').open) $('quiz').close();
  render();
}

function answer(key, letter) {
  const v = quiz.video;
  const rec = saved(v.id);
  if (rec.a[key]) return;
  rec.a[key] = letter;
  save(v.id, rec);
  renderSheet();
}

/* ---------------- wiring ---------------- */

export function init(h) {
  hooks = h;
  $('listenChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (!chip) return;
    ui.chip = chip.dataset.chip;
    store.set('listenChip', ui.chip);
    render();
    window.scrollTo(0, 0);
  });
  $('listenList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-video]');
    if (row) open(row.dataset.video);
  });
  $('quizClose').addEventListener('click', close);
  $('quiz').addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  $('quizSheet').addEventListener('click', (e) => {
    const opt = e.target.closest('[data-q]');
    if (opt) { answer(opt.dataset.q, opt.dataset.l); return; }
    const s = e.target.closest('[data-seek]');
    if (s) { seek(Number(s.dataset.seek)); quiz.player?.playVideo(); return; }
    if (e.target.closest('#quizReset') && confirm('この動画の答えを消してやり直しますか？')) {
      save(quiz.video.id, { a: {}, t: quiz.video.start });
      renderSheet();
      seek(quiz.video.start);
    }
  });
  $('quizSections').addEventListener('click', (e) => {
    const b = e.target.closest('[data-at]');
    if (b) { seek(Number(b.dataset.at)); quiz.player?.playVideo(); }
  });
  $('quizPlay').addEventListener('click', () => {
    if (!quiz.ready) return;
    if (playing()) quiz.player.pauseVideo(); else quiz.player.playVideo();
  });
  $('quizBack').addEventListener('click', () => quiz.ready && seek(quiz.player.getCurrentTime() - 5));
  $('quizFwd').addEventListener('click', () => quiz.ready && seek(quiz.player.getCurrentTime() + 5));
  $('quizRestart').addEventListener('click', () => { seek(quiz.video.start); quiz.player?.playVideo(); });
  $('quizRate').addEventListener('click', () => {
    quiz.rate = RATES[(RATES.indexOf(quiz.rate) + 1) % RATES.length] ?? 1;
    $('quizRate').textContent = `${quiz.rate}×`;
    $('quizRate').classList.toggle('on', quiz.rate !== 1);
    if (quiz.ready) quiz.player.setPlaybackRate(quiz.rate);
  });
}

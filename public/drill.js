// 瞬間英作文: a short Japanese sentence appears, say it in English before the timer (1–3 s) runs out,
// then check the answer (read aloud) and mark it. Missed sentences come back until said twice in a row.
import { $, store, escapeHtml } from './util.js';
import { speak, stopSpeaking } from './speech.js';
import { loadSentences, LEVELS, tatoebaUrl, record, updateRecord, wordsHtml, openWordPopup } from './sentences.js';

const opts = {
  level: store.get('drillLevel', '1'),   // '1' | '2' | '3' | 'weak'
  sec: store.get('drillSec', 3),
  speak: store.get('drillSpeak', true),
};
let hooks = null;
let items = [];
let cur = null;
let phase = 'idle';   // idle | think | answer
let timer = 0;
const recent = [];
const today = () => new Date().toLocaleDateString('sv');
let stats = store.get('drillStats', { day: '', n: 0, ok: 0 });

const rand = (list) => list[Math.floor(Math.random() * list.length)];
const isWeak = (s) => !!record(s.id)?.weak;

export function init(h) {
  hooks = h;
  $('drillLevel').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    opts.level = b.dataset.v;
    store.set('drillLevel', opts.level);
    renderOpts();
    if (phase !== 'idle') next();
  });
  $('drillSec').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    opts.sec = Number(b.dataset.v);
    store.set('drillSec', opts.sec);
    renderOpts();
  });
  $('drillSpeak').checked = opts.speak;
  $('drillSpeak').addEventListener('change', (e) => { opts.speak = e.target.checked; store.set('drillSpeak', opts.speak); });
  $('drillStart').addEventListener('click', next);
  $('drillReveal').addEventListener('click', () => reveal(false));
  $('drillOk').addEventListener('click', () => grade(true));
  $('drillNg').addEventListener('click', () => grade(false));
  $('drillReplay').addEventListener('click', say);
  $('drillToShadow').addEventListener('click', () => cur && hooks.openShadow(cur));
  $('drillAns').addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (w) openWordPopup(w.dataset.word, cur);
  });
  document.addEventListener('keydown', onKey);
}

export async function show() {
  try {
    items = await loadSentences();
  } catch {
    $('drillJa').textContent = '例文データを読み込めませんでした。インターネットにつながる状態で開き直してください。';
    return;
  }
  renderOpts();
  renderStats();
}

export function hide() {
  clearTimeout(timer);
  stopSpeaking();
  if (phase === 'think') reveal(false, { quiet: true });
}

function renderOpts() {
  const weak = items.filter(isWeak).length;
  const seg = (v, label) => `<button data-v="${v}" aria-pressed="${String(opts.level) === v}">${label}</button>`;
  $('drillLevel').innerHTML = Object.entries(LEVELS).map(([v, l]) => seg(v, l)).join('') + seg('weak', `苦手 ${weak}`);
  $('drillSec').innerHTML = [1, 2, 3].map((s) => `<button data-v="${s}" aria-pressed="${opts.sec === s}">${s}秒</button>`).join('');
}

function pool() {
  return opts.level === 'weak' ? items.filter(isWeak) : items.filter((s) => String(s.level) === opts.level);
}

function pick() {
  const p = pool();
  if (!p.length) return null;
  const fresh = p.filter((s) => !recent.includes(s.id));
  const cand = fresh.length ? fresh : p;
  // Now and then bring back a sentence you missed before.
  const weak = opts.level === 'weak' ? [] : cand.filter(isWeak);
  if (weak.length && Math.random() < 0.25) return rand(weak);
  const unseen = cand.filter((s) => !record(s.id)?.seen);
  return rand(unseen.length ? unseen : cand);
}

function setButtons() {
  $('drillStart').hidden = phase !== 'idle';
  $('drillReveal').hidden = phase !== 'think';
  $('drillOk').hidden = phase !== 'answer';
  $('drillNg').hidden = phase !== 'answer';
  $('drillReplay').hidden = phase !== 'answer';
  $('drillToShadow').hidden = phase !== 'answer';
}

function next() {
  clearTimeout(timer);
  stopSpeaking();
  if (!items.length) return;
  cur = pick();
  if (!cur) {
    phase = 'idle';
    $('drillJa').textContent = opts.level === 'weak' ? '苦手な文はありません。レベルを選んで練習しましょう。' : '例文がありません。';
    $('drillAns').hidden = true;
    $('drillAlts').hidden = true;
    $('drillMeta').textContent = '';
    setButtons();
    return;
  }
  phase = 'think';
  hooks.pauseAudio?.();
  $('drillMeta').textContent = `${LEVELS[cur.level]}${isWeak(cur) ? '・苦手' : ''}`;
  $('drillSrc').href = tatoebaUrl(cur.id);
  $('drillSrc').textContent = `Tatoeba #${cur.id}`;
  $('drillJa').textContent = cur.ja;
  $('drillAns').hidden = true;
  $('drillAlts').hidden = true;
  $('drillCard').classList.remove('timeup');
  const bar = $('drillBar');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  void bar.offsetWidth;  // restart the shrinking bar
  bar.style.transition = `width ${opts.sec}s linear`;
  bar.style.width = '0%';
  timer = setTimeout(() => reveal(true), opts.sec * 1000);
  setButtons();
}

function reveal(timeUp, { quiet = false } = {}) {
  if (phase !== 'think') return;
  clearTimeout(timer);
  phase = 'answer';
  const bar = $('drillBar');
  bar.style.width = timeUp ? '0%' : getComputedStyle(bar).width;
  bar.style.transition = 'none';
  $('drillCard').classList.toggle('timeup', timeUp);
  $('drillAns').innerHTML = wordsHtml(cur.en);
  $('drillAns').hidden = false;
  $('drillAlts').innerHTML = cur.alts.length ? `別の言い方：${cur.alts.map(escapeHtml).join(' / ')}` : '';
  $('drillAlts').hidden = !cur.alts.length;
  setButtons();
  if (opts.speak && !quiet) say();
}

function say() {
  if (!cur) return;
  hooks.pauseAudio?.();
  speak(cur.en);
}

function grade(ok) {
  if (phase !== 'answer' || !cur) return;
  if (stats.day !== today()) stats = { day: today(), n: 0, ok: 0 };
  stats.n++;
  if (ok) stats.ok++;
  store.set('drillStats', stats);
  updateRecord(cur.id, (r) => {
    const streak = ok ? (r.streak || 0) + 1 : 0;
    return { ...r, seen: r.seen + 1, ok: r.ok + (ok ? 1 : 0), streak, weak: ok ? !!r.weak && streak < 2 : true };
  });
  recent.push(cur.id);
  if (recent.length > 40) recent.shift();
  renderOpts();
  renderStats();
  next();
}

function renderStats() {
  const s = stats.day === today() ? stats : { n: 0, ok: 0 };
  $('drillStats').textContent = s.n
    ? `今日 ${s.n} 問・言えた ${s.ok} 問（${Math.round((s.ok / s.n) * 100)}%）`
    : '日本語を見たら、時間内に英語で声に出して言ってみましょう。';
}

function onKey(e) {
  if ($('drillView').hidden || e.repeat || e.target.closest('input, select, textarea, dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'enter') {
    e.preventDefault();
    if (phase === 'idle') next();
    else if (phase === 'think') reveal(false);
    else grade(true);
  } else if (phase === 'answer' && (k === 'x' || k === 'arrowleft')) grade(false);
  else if (phase === 'answer' && k === 'arrowright') grade(true);
  else if (phase === 'answer' && k === 'r') say();
}

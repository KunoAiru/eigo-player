// シャドーイング: one sentence at a time with the browser's free text-to-speech.
// Follows the stepwise method used in shadowing research (Kadota): listen for meaning → mumbling →
// overlapping (parallel reading) → prosody shadowing → content shadowing → check
// (cloze dictation, recording yourself, and a speech-recognition check of what you said).
import { $, store, escapeHtml } from './util.js';
import * as speech from './speech.js';
import {
  loadSentences, LEVELS, tatoebaUrl, record, updateRecord, tokenize, wordsHtml,
  highlightAt, clearHighlight, openWordPopup,
} from './sentences.js';

const STEPS = [
  { label: '① 聞く', text: 'ja', how: '英文を見ずに聞き、日本語訳で意味をつかみます。まだ声は出しません。わからない単語は「英文を表示」してタップで確認。' },
  { label: '② マンブリング', text: 'none', how: '英文を見ずに、音声の少し後ろを小声でブツブツ追いかけます。音の流れとリズムをつかむ段階です。' },
  { label: '③ オーバーラッピング', text: 'en', how: '英文を見ながら音声とぴったり同時に読みます。強弱・区切り・音のつながりを合わせましょう。' },
  { label: '④ プロソディ', text: 'none', how: '英文を見ずに、1〜2語遅れて声に出して追いかけます。イントネーションとリズムをまねることに集中。' },
  { label: '⑤ コンテンツ', text: 'ja', how: '意味を思い浮かべながらシャドーイング。言っている内容が頭に浮かんでいれば合格です。' },
  { label: '⑥ チェック', text: 'cloze', how: '穴埋めで聞き取れているか確認。録音して聞き比べたり、発音チェックで通じるか試しましょう。' },
];
const RATIOS = [[0.25, '少なめ'], [0.45, '多め'], [1, '全部（ディクテーション）']];
const STOP = new Set('a an the to of in on at for and or but is are was were be been am i you he she it we they my your his her its our their me him us them this that do does did not no so as with by from'.split(' '));

const st = {
  level: store.get('shadowLevel', '1'),            // '1' | '2' | '3' | 'weak' | 'custom'
  pos: store.get('shadowPos', {}),                 // level -> index
  step: store.get('shadowStep', 0),
  rate: store.get('shadowRate', 0.9),
  reps: store.get('shadowReps', 3),
  gap: store.get('shadowGap', false),
  auto: store.get('shadowAuto', false),
  ratio: store.get('shadowRatio', 0.25),
  recModel: store.get('shadowRecModel', true),
  custom: store.get('shadowCustom', []),           // [{id: 'c1', en, ja: ''}]
};
let hooks = null;
let items = [];
let list = [];
let cur = null;
let tokens = [];
let blanks = new Set();
let peek = false;
let playing = null;     // {left, timer}
let recorder = null;    // active recording
let myVoice = null;     // object URL of the last recording
let listening = null;   // active speech recognition
const player = new Audio();

export function init(h) {
  hooks = h;
  $('shadowLevel').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    st.level = b.dataset.v;
    store.set('shadowLevel', st.level);
    buildList();
    load();
  });
  $('shPrev').addEventListener('click', () => go(-1));
  $('shNext').addEventListener('click', () => go(1));
  $('shRandom').addEventListener('click', () => { if (list.length) setPos(Math.floor(Math.random() * list.length)); });
  $('shSteps').addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (b) setStep(Number(b.dataset.step));
  });
  $('shPlay').addEventListener('click', () => (playing ? stop() : play()));
  $('shPeek').addEventListener('click', () => { peek = !peek; renderText(); });

  $('shRate').value = st.rate;
  $('shRate').addEventListener('input', (e) => {
    st.rate = Number(e.target.value);
    store.set('shadowRate', st.rate);
    renderRate();
  });
  $('shReps').value = String(st.reps);
  $('shReps').addEventListener('change', (e) => { st.reps = Number(e.target.value); store.set('shadowReps', st.reps); });
  for (const [id, key] of [['shGap', 'gap'], ['shAuto', 'auto'], ['shRecModel', 'recModel']]) {
    $(id).checked = st[key];
    $(id).addEventListener('change', (e) => { st[key] = e.target.checked; store.set(`shadow${key[0].toUpperCase()}${key.slice(1)}`, st[key]); });
  }

  $('shRatio').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    st.ratio = Number(b.dataset.v);
    store.set('shadowRatio', st.ratio);
    makeBlanks();
    renderText();
  });
  $('shGrade').addEventListener('click', gradeCloze);
  $('shRemake').addEventListener('click', () => { makeBlanks(); renderText(); });
  $('shText').addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (w) openWordPopup(w.dataset.word, cur);
  });
  $('shText').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('input.blank')) return;
    e.preventDefault();
    const inputs = [...$('shText').querySelectorAll('input.blank')];
    const i = inputs.indexOf(e.target);
    if (i < inputs.length - 1) inputs[i + 1].focus(); else gradeCloze();
  });

  $('shRec').addEventListener('click', toggleRecord);
  $('shMine').addEventListener('click', () => playMine());
  $('shCompare').addEventListener('click', () => { stop(); speech.speak(cur.en, { rate: st.rate, onEnd: () => setTimeout(playMine, 400) }); });
  $('shSpeak').addEventListener('click', toggleListen);
  $('shRec').hidden = !speech.recordingSupported;
  $('shSpeak').hidden = !speech.recognitionSupported;
  $('shToolsNote').textContent = [
    !speech.ttsSupported ? 'このブラウザは読み上げに対応していません。' : '',
    !speech.recognitionSupported ? '発音チェックは Chrome / Edge / Safari で使えます。' : '',
  ].join('');

  $('customUse').addEventListener('click', useCustom);
  document.addEventListener('keydown', onKey);
}

export async function show() {
  try {
    items = await loadSentences();
  } catch {
    if (!st.custom.length) {
      $('shText').textContent = '例文データを読み込めませんでした。インターネットにつながる状態で開き直すか、英文を貼り付けて練習してください。';
      return;
    }
  }
  buildList();
  load();
}

export function hide() {
  stop();
  cancelListen();
  finishRecord(false);
}

/** Opens a given sentence (from 瞬間英作文) at step ①. */
export async function openSentence(s) {
  items = await loadSentences().catch(() => items);
  st.level = String(s.level);
  store.set('shadowLevel', st.level);
  buildList();
  const i = list.findIndex((x) => x.id === s.id);
  if (i >= 0) st.pos[st.level] = i;
  store.set('shadowPos', st.pos);
  st.step = 0;
  store.set('shadowStep', st.step);
}

/* ---------------- sentence list ---------------- */

function buildList() {
  if (st.level === 'custom') list = st.custom;
  else if (st.level === 'weak') list = items.filter((s) => record(s.id)?.weak);
  else list = items.filter((s) => String(s.level) === st.level);
  const weak = items.filter((s) => record(s.id)?.weak).length;
  const seg = (v, label) => `<button data-v="${v}" aria-pressed="${st.level === v}">${label}</button>`;
  $('shadowLevel').innerHTML = Object.entries(LEVELS).map(([v, l]) => seg(v, l)).join('')
    + seg('weak', `苦手 ${weak}`) + seg('custom', `貼り付け ${st.custom.length}`);
  $('customBox').open = st.level === 'custom' && !st.custom.length;
}

function setPos(i) {
  st.pos[st.level] = i;
  store.set('shadowPos', st.pos);
  load();
}

function go(delta) {
  if (!list.length) return;
  setPos(((st.pos[st.level] || 0) + delta + list.length) % list.length);
}

function load() {
  stop();
  cancelListen();
  finishRecord(false);
  const i = Math.min(st.pos[st.level] || 0, Math.max(0, list.length - 1));
  cur = list[i] || null;
  peek = false;
  $('shResult').hidden = true;
  if (myVoice) { URL.revokeObjectURL(myVoice); myVoice = null; }
  $('shMine').hidden = true;
  $('shCompare').hidden = true;
  if (!cur) {
    $('shPos').textContent = '';
    $('shMeta').textContent = '';
    $('shSrc').textContent = '';
    $('shJa').textContent = '';
    $('shText').innerHTML = `<p class="muted">${st.level === 'custom' ? '上の「英文を貼り付けて練習」に英文を入れてください。' : st.level === 'weak' ? '苦手な文はまだありません（瞬間英作文で × を付けた文がここに入ります）。' : '例文がありません。'}</p>`;
    $('shPlay').disabled = true;
    renderSteps();
    return;
  }
  $('shPlay').disabled = false;
  tokens = tokenize(cur.en);
  makeBlanks();
  $('shPos').textContent = `${i + 1} / ${list.length}`;
  const best = typeof cur.id === 'number' ? record(cur.id)?.best : null;
  $('shMeta').textContent = [st.level === 'custom' ? '貼り付けた英文' : LEVELS[cur.level], best != null ? `発音ベスト ${best}%` : ''].filter(Boolean).join('・');
  $('shSrc').textContent = typeof cur.id === 'number' ? `Tatoeba #${cur.id}` : '';
  if (typeof cur.id === 'number') $('shSrc').href = tatoebaUrl(cur.id); else $('shSrc').removeAttribute('href');
  renderSteps();
  renderRate();
}

/* ---------------- steps & text ---------------- */

function setStep(i) {
  st.step = Math.max(0, Math.min(STEPS.length - 1, i));
  store.set('shadowStep', st.step);
  peek = false;
  stop();
  renderSteps();
}

function renderSteps() {
  $('shSteps').innerHTML = STEPS.map((s, i) => `<button class="chip" data-step="${i}" aria-selected="${i === st.step}">${s.label}</button>`).join('');
  $('shSteps').querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  $('shHow').textContent = STEPS[st.step].how;
  const check = STEPS[st.step].text === 'cloze';
  $('shCloze').hidden = !check || !cur;
  $('shRatio').innerHTML = RATIOS.map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === st.ratio}">${l}</button>`).join('');
  renderText();
}

function makeBlanks() {
  const words = tokens.map((t, i) => (t.word ? i : -1)).filter((i) => i >= 0);
  if (st.ratio >= 1) { blanks = new Set(words); return; }
  const n = Math.max(1, Math.round(words.length * st.ratio));
  // Prefer content words; fall back to any word for very short sentences.
  const content = words.filter((i) => !STOP.has(tokens[i].word.toLowerCase()));
  const pool = content.length >= n ? content : words;
  blanks = new Set([...pool].sort(() => Math.random() - 0.5).slice(0, n));
}

function renderText() {
  if (!cur) return;
  const mode = peek ? 'en' : STEPS[st.step].text;
  const el = $('shText');
  el.className = 'p-en';
  $('shJa').textContent = cur.ja || '';
  $('shJa').hidden = !cur.ja || mode === 'none';
  $('shPeek').hidden = mode === 'en';
  $('shPeek').textContent = '英文を表示';
  if (peek) { $('shPeek').hidden = false; $('shPeek').textContent = '英文を隠す'; }
  if (mode === 'en') {
    el.innerHTML = wordsHtml(cur.en);
  } else if (mode === 'cloze') {
    el.innerHTML = tokens.map((t, i) => {
      if (!blanks.has(i)) return t.word ? `${escapeHtml(t.pre)}<span class="w" data-i="${i}" data-word="${escapeHtml(t.word)}">${escapeHtml(t.word)}</span>${escapeHtml(t.post)}` : escapeHtml(t.text);
      const size = Math.max(3, t.word.length + 1);
      return `${escapeHtml(t.pre)}<span class="blank-wrap" data-i="${i}"><input class="blank" data-i="${i}" size="${size}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="空欄"></span>${escapeHtml(t.post)}`;
    }).join(' ');
  } else {
    el.classList.add('hidden-text');
    el.innerHTML = `<span class="muted">${mode === 'ja' ? '（英文は隠しています）' : '（文字を見ずに練習）'}</span>`;
  }
}

function gradeCloze() {
  const inputs = [...$('shText').querySelectorAll('input.blank')];
  if (!inputs.length) return;
  const clean = (s) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']/g, '');
  let ok = 0;
  for (const input of inputs) {
    const t = tokens[Number(input.dataset.i)];
    const right = clean(input.value) === clean(t.word);
    if (right) ok++;
    input.classList.toggle('ok', right);
    input.classList.toggle('ng', !right);
    input.closest('.blank-wrap').querySelector('.ans')?.remove();
    if (!right) input.insertAdjacentHTML('afterend', `<span class="ans">${escapeHtml(t.word)}</span>`);
  }
  showResult(`穴埋め ${ok} / ${inputs.length}${ok === inputs.length ? '　全問正解！' : '　赤い所をもう一度聞いてみましょう'}`);
}

/* ---------------- playback ---------------- */

function play() {
  if (!cur) return;
  hooks.pauseAudio?.();
  stop();
  playing = { left: st.reps, timer: 0 };
  $('shPlay').textContent = '■ 停止';
  playOnce();
}

function playOnce() {
  if (!playing) return;
  const el = $('shText');
  const rep = st.reps - playing.left + 1;
  $('shPlayInfo').textContent = st.reps > 1 ? `${rep} / ${st.reps} 回目` : '';
  speech.speak(cur.en, {
    rate: st.rate,
    onBoundary: (i) => highlightAt(el, tokens, i),
    onEnd: (ok, ms) => {
      clearHighlight(el);
      if (!playing) return;
      playing.left--;
      if (!ok || playing.left <= 0) { finished(ok); return; }
      // Repeating leaves as long a pause as the sentence took; shadowing just a short breath.
      const pause = st.gap ? Math.max(1200, ms * 1.15) : 900;
      playing.timer = setTimeout(playOnce, pause);
    },
  });
}

function finished(ok) {
  stop();
  if (ok && st.auto && st.step < STEPS.length - 1) {
    setStep(st.step + 1);
    playing = { left: 0, timer: setTimeout(play, 1200) };
    $('shPlay').textContent = '■ 停止';
    $('shPlayInfo').textContent = `次は ${STEPS[st.step].label}`;
  }
}

function stop() {
  if (playing) clearTimeout(playing.timer);
  playing = null;
  speech.stopSpeaking();
  player.pause();
  clearHighlight($('shText'));
  $('shPlay').textContent = '▶ 再生';
  $('shPlayInfo').textContent = '';
}

function renderRate() {
  $('shRateVal').textContent = `${st.rate.toFixed(2)}×`;
}

/* ---------------- recording & speech check ---------------- */

let recGen = 0;          // bumps whenever a recording starts or is abandoned
let recStarting = false;

async function toggleRecord() {
  if (recStarting) return;
  if (recorder) { finishRecord(true); return; }
  if (!cur) return;
  stop();
  hooks.pauseAudio?.();
  const gen = ++recGen;
  const sentence = cur;
  recStarting = true;
  let r;
  try {
    r = await speech.startRecording();
  } catch {
    recStarting = false;
    if (gen === recGen) showResult('マイクを使えませんでした。ブラウザのマイクの許可を確認してください。');
    return;
  }
  recStarting = false;
  // The sentence changed or the tab closed while the microphone was opening.
  if (gen !== recGen || cur !== sentence || $('shadowView').hidden) { r.stop(); return; }
  recorder = r;
  $('shRec').textContent = '■ 録音停止';
  $('shRec').classList.add('rec');
  if (st.recModel) {
    // Shadow along with the model; stop a moment after it ends.
    const el = $('shText');
    speech.speak(sentence.en, {
      rate: st.rate,
      onBoundary: (i) => highlightAt(el, tokens, i),
      onEnd: () => {
        clearHighlight(el);
        setTimeout(() => { if (recorder && gen === recGen) finishRecord(true); }, 1500);
      },
    });
  }
}

/** Stops the recording; keep=false throws it away (sentence changed, tab left). */
async function finishRecord(keep) {
  recGen++;
  const r = recorder;
  recorder = null;
  $('shRec').textContent = '🎙 録音';
  $('shRec').classList.remove('rec');
  if (!r) return;
  if (keep) stop();
  const blob = await r.stop();
  if (!keep) return;
  if (myVoice) URL.revokeObjectURL(myVoice);
  myVoice = URL.createObjectURL(blob);
  $('shMine').hidden = false;
  $('shCompare').hidden = false;
}

function playMine() {
  if (!myVoice) return;
  speech.stopSpeaking();
  player.src = myVoice;
  player.play().catch(() => {});
}

/** Abandons a running speech check without scoring it. */
function cancelListen() {
  if (!listening) return;
  const l = listening;
  listening = null;
  l.stop?.();
  $('shSpeak').textContent = '🗣 発音チェック';
  $('shSpeak').classList.remove('rec');
}

function toggleListen() {
  if (listening) { listening.stop?.(); return; }  // ends normally and gets scored
  if (!cur) return;
  stop();
  hooks.pauseAudio?.();
  $('shSpeak').textContent = '■ 聞き取り中…';
  $('shSpeak').classList.add('rec');
  showResult('<span class="muted">英文を声に出して言ってください</span>', true);
  const sentence = cur;
  const toks = tokens;
  const session = {};
  listening = session;
  const live = () => listening === session;
  const r = speech.recognize({
    onText: (text) => { if (live()) showResult(`<span class="muted">${escapeHtml(text)}</span>`, true); },
    onError: (err) => {
      if (!live()) return;
      showResult(err === 'not-allowed' || err === 'service-not-allowed'
        ? 'マイクを使えませんでした。ブラウザのマイクの許可を確認してください。'
        : `聞き取りに失敗しました（${escapeHtml(err)}）`, true);
    },
    onDone: (text) => {
      if (!live()) return;
      listening = null;
      $('shSpeak').textContent = '🗣 発音チェック';
      $('shSpeak').classList.remove('rec');
      if (text) scoreSpeech(text, sentence, toks);
    },
  });
  session.stop = r.stop;
}

function scoreSpeech(text, sentence, toks) {
  const spoken = speech.compareWords(text);
  const parts = toks.map((t) => speech.compareWords(t.word));
  const flat = parts.flat();
  const hit = speech.matchWords(flat, spoken);
  let k = 0;
  const okTok = parts.map((p) => { const r = p.every((_, j) => hit[k + j]); k += p.length; return r; });
  const score = flat.length ? Math.round((hit.filter(Boolean).length / flat.length) * 100) : 0;
  const words = toks.map((t, i) => (t.word
    ? `${escapeHtml(t.pre)}<span class="${okTok[i] ? 'hit' : 'miss'}">${escapeHtml(t.word)}</span>${escapeHtml(t.post)}`
    : escapeHtml(t.text))).join(' ');
  let best = null;
  if (typeof sentence.id === 'number') best = updateRecord(sentence.id, (r) => ({ ...r, best: Math.max(r.best || 0, score) })).best;
  showResult(`<div class="score ${score >= 90 ? 'good' : score >= 60 ? 'mid' : 'low'}">${score}%</div>
    <div class="said">${words}</div>
    <div class="muted small">聞き取られた英語：${escapeHtml(text)}</div>
    <div class="muted small">${score >= 90 ? 'よく通じています！' : '赤い単語が聞き取られませんでした。お手本を聞き直してもう一度。'}${best != null ? `（ベスト ${best}%）` : ''}</div>`, true);
}

function showResult(html, isHtml = false) {
  const el = $('shResult');
  el.hidden = false;
  if (isHtml) el.innerHTML = html; else el.textContent = html;
}

/* ---------------- pasted text ---------------- */

function useCustom() {
  const text = $('customText').value.replace(/\s+/g, ' ').trim();
  if (!text) return;
  // One sentence per item; abbreviations such as "Mr." and "U.S." don't end a sentence.
  const safe = text.replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|No|U\.S|U\.K|e\.g|i\.e|a\.m|p\.m)\./gi, (m) => m.replace(/\./g, '․'));
  // (No lookbehind: older iPhone Safari can't parse it and the whole app would fail to start.)
  const parts = safe.replace(/([.!?]["”’']?)\s+(?=["“‘']?[A-Z0-9])/g, '$1\n').split('\n').map((s) => s.replace(/․/g, '.'));
  st.custom = parts.map((s) => s.trim()).filter((s) => /[A-Za-z]/.test(s)).slice(0, 200)
    .map((en, i) => ({ id: `c${i + 1}`, en, ja: '' }));
  store.set('shadowCustom', st.custom);
  st.level = 'custom';
  store.set('shadowLevel', st.level);
  st.pos.custom = 0;
  store.set('shadowPos', st.pos);
  $('customText').value = '';
  buildList();
  $('customBox').open = false;
  load();
  hooks.toast?.(`${st.custom.length} 文に分けました`);
}

function onKey(e) {
  if ($('shadowView').hidden || e.target.closest('input, select, textarea, dialog[open], summary') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ') { e.preventDefault(); if (playing) stop(); else play(); }
  else if (e.key === 'ArrowRight') go(1);
  else if (e.key === 'ArrowLeft') go(-1);
}

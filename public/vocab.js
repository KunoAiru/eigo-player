// Word book: word lists per audio track, word details and flashcards.
// Word data (vocab.json made by tools/) comes from the PC server or from this device (IndexedDB);
// it is never part of the published app.
import { $, store, norm, escapeHtml } from './util.js';
import * as db from './db.js';

const vocab = new Map();   // book title -> {words, byNo, byCd, source}
let hooks = null;          // {currentBook(), books(), play(book, index)}
const ui = {
  view: store.get('view', 'audio'),
  chip: 'all',             // all | fav | rank:N
  track: null,             // {bookId, index}: words of one audio track
  query: '',
  dir: store.get('cardDir', 'en'),     // en: English → Japanese, ja: Japanese → English
  shuffle: store.get('cardShuffle', false),
};
const favs = new Set(store.get('favs', []));
const favKey = (title, no) => `${title}#${no}`;

/* ---------------- data ---------------- */

function prepare(data, source) {
  const words = (data.words || []).filter((w) => w && w.word);
  const byNo = new Map();
  const byCd = new Map();
  for (const w of words) {
    w.senses ||= [];
    for (const k of ['synonyms', 'antonyms', 'related', 'examples']) w[k] ||= [];
    w.search = norm([
      w.word, w.no,
      ...w.senses.flatMap((s) => s.meanings),
      ...w.synonyms.map(refWord), ...w.antonyms.map(refWord),
      ...w.related.map((r) => `${r.word} ${r.meaning || ''}`),
    ].join(' '));
    if (w.no != null) byNo.set(w.no, w);
    if (w.cd) {
      if (!byCd.has(w.cd)) byCd.set(w.cd, []);
      byCd.get(w.cd).push(w);
    }
  }
  return { words, byNo, byCd, source, book: data.book };
}

const refWord = (r) => (typeof r === 'string' ? r : r.word);

export async function loadVocab(books) {
  vocab.clear();
  for (const rec of await db.getAllVocab().catch(() => [])) vocab.set(rec.title, prepare(rec.data, 'local'));
  // A copy saved on the phone wins, like the audio does.
  await Promise.all(books.filter((b) => b.vocabUrl && !vocab.has(b.title)).map(async (b) => {
    try {
      const res = await fetch(b.vocabUrl, { cache: 'no-cache' });
      if (res.ok) vocab.set(b.title, prepare(await res.json(), 'server'));
    } catch { /* PC server gone */ }
  }));
}

export const hasVocab = (book) => !!(book && vocab.get(book.title)?.words.length);

export function wordsForTrack(book, t) {
  const v = book && vocab.get(book.title);
  if (!v || !t) return [];
  // The book prints "CD 1-4" before the words recorded on disc 1, track 4.
  const cd = t.track != null ? `${t.disc}-${t.track}` : null;
  if (cd && v.byCd.has(cd)) return v.byCd.get(cd);
  if (t.ranges?.length) return v.words.filter((w) => t.ranges.some(([a, b]) => w.no >= a && w.no <= b));
  return [];
}

function trackForWord(book, w) {
  if (!book) return -1;
  const [disc, track] = (w.cd || '').split('-').map(Number);
  let i = book.tracks.findIndex((t) => t.disc === disc && t.track === track);
  if (i < 0) i = book.tracks.findIndex((t) => t.ranges?.some(([a, b]) => w.no >= a && w.no <= b));
  return i;
}

export async function importVocabFile(file, fallbackTitle) {
  const data = JSON.parse(await file.text());
  if (!Array.isArray(data.words)) throw new Error('vocab.json の形式ではありません');
  const titles = hooks.books().map((b) => b.title);
  const title = titles.includes(data.book) ? data.book : fallbackTitle || data.book || '単語帳';
  await db.putVocab(title, data);
  vocab.set(title, prepare(data, 'local'));
  return { title, count: vocab.get(title).words.length };
}

export async function deleteLocalVocab(title) {
  await db.deleteVocab(title);
}

export const localVocabList = () => [...vocab.entries()]
  .filter(([, v]) => v.source === 'local').map(([title, v]) => ({ title, count: v.words.length }));

/* ---------------- views ---------------- */

export function init(h) {
  hooks = h;
  document.querySelector('.views').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });
  $('wordSearch').addEventListener('input', (e) => {
    ui.query = e.target.value;
    $('clearWordSearch').hidden = !ui.query;
    renderWordList();
  });
  $('clearWordSearch').addEventListener('click', () => {
    $('wordSearch').value = '';
    ui.query = '';
    $('clearWordSearch').hidden = true;
    renderWordList();
  });
  $('wordChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (!chip) return;
    if (chip.dataset.chip === 'track') ui.track = null;
    else ui.chip = chip.dataset.chip;
    renderWords();
  });
  $('wordList').addEventListener('click', (e) => {
    const fav = e.target.closest('[data-fav]');
    const row = e.target.closest('[data-no]');
    if (fav) { toggleFav(Number(fav.dataset.fav)); renderWords(); return; }
    if (row) openDetail(Number(row.dataset.no));
  });
  $('studyBtn').addEventListener('click', () => startCards(visibleWords()));
  $('dirBtn').addEventListener('click', () => { setDir(ui.dir === 'en' ? 'ja' : 'en'); renderStudyBar(); });

  $('wordSheet').addEventListener('click', (e) => {
    if (e.target === $('wordSheet')) $('wordSheet').close();
    const fav = e.target.closest('[data-fav]');
    if (fav) { toggleFav(Number(fav.dataset.fav)); refreshFavButtons(); renderWords(); }
    const play = e.target.closest('[data-play]');
    if (play) { $('wordSheet').close(); hooks.play(hooks.currentBook(), Number(play.dataset.play)); }
  });

  initCards();
  setView(ui.view);
}

export function setView(view) {
  ui.view = view === 'words' ? 'words' : 'audio';
  store.set('view', ui.view);
  const words = ui.view === 'words';
  for (const b of document.querySelectorAll('.views [data-view]')) b.setAttribute('aria-selected', b.dataset.view === ui.view);
  $('audioBar').hidden = words;
  $('audioView').hidden = words;
  $('wordsBar').hidden = !words;
  $('wordsView').hidden = !words;
  if (words) renderWords();
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event('scroll'));  // refresh the "now playing" jump button
}

export function showTrackWords(book, index) {
  ui.track = { bookId: book.id, index };
  ui.chip = 'all';
  ui.query = '';
  $('wordSearch').value = '';
  $('clearWordSearch').hidden = true;
  setView('words');
}

function currentTrack() {
  const book = hooks.currentBook();
  if (!ui.track || !book || ui.track.bookId !== book.id) return null;
  return book.tracks[ui.track.index] || null;
}

function visibleWords() {
  const book = hooks.currentBook();
  const v = book && vocab.get(book.title);
  if (!v) return [];
  const t = currentTrack();
  let list = t ? wordsForTrack(book, t) : v.words;
  if (ui.chip === 'fav') list = list.filter((w) => favs.has(favKey(book.title, w.no)));
  else if (ui.chip.startsWith('rank:')) list = list.filter((w) => String(w.rank) === ui.chip.slice(5));
  const tokens = norm(ui.query).split(' ').filter(Boolean);
  if (tokens.length) list = list.filter((w) => tokens.every((tok) => w.search.includes(tok)));
  return list;
}

export function renderWords() {
  if (!hooks || ui.view !== 'words') return;
  const book = hooks.currentBook();
  const v = book && vocab.get(book.title);
  const chips = $('wordChips');
  if (!v) {
    chips.innerHTML = '';
    $('studyBar').hidden = true;
    $('wordStatus').textContent = '';
    $('wordList').innerHTML = `<li class="empty">この教材の単語データがまだありません。<br>
      PC で tools/ のスクリプトを使って vocab.json を作り、教材フォルダに置くか、<br>右上のメニューの「単語データを取り込む」から読み込んでください。</li>`;
    return;
  }
  const t = currentTrack();
  const ranks = [...new Set(v.words.map((w) => w.rank).filter(Boolean))].sort((a, b) => a - b);
  const favCount = v.words.filter((w) => favs.has(favKey(book.title, w.no))).length;
  const chip = (value, label) => `<button class="chip" role="tab" data-chip="${value}" aria-selected="${ui.chip === value}">${escapeHtml(label)}</button>`;
  chips.innerHTML = [
    t ? `<button class="chip track" data-chip="track" aria-selected="true" aria-label="トラックの絞り込みを解除">▶ ${escapeHtml(t.title)} ×</button>` : '',
    chip('all', 'すべて'),
    chip('fav', `★ お気に入り ${favCount}`),
    ...(ranks.length > 1 ? ranks.map((r) => chip(`rank:${r}`, `RANK${r}`)) : []),
  ].join('');
  renderWordList();
}

function renderWordList() {
  const book = hooks.currentBook();
  const list = visibleWords();
  const total = vocab.get(book?.title)?.words.length || 0;
  $('wordStatus').textContent = list.length === total ? `全 ${total} 語` : `${list.length} 語 / 全 ${total} 語`;
  renderStudyBar(list.length);
  if (!list.length) {
    $('wordList').innerHTML = `<li class="empty">${ui.chip === 'fav' ? 'お気に入りはまだありません。単語の ☆ をタップして登録できます。' : '見つかりませんでした'}</li>`;
    return;
  }
  $('wordList').innerHTML = list.map((w) => {
    const fav = favs.has(favKey(book.title, w.no));
    return `<li class="item word" data-no="${w.no}">
      <span class="num">${w.no ?? ''}</span>
      <span class="txt"><div class="title">${escapeHtml(w.word)}</div><div class="sub">${escapeHtml(summary(w))}</div></span>
      <button class="star" data-fav="${w.no}" aria-pressed="${fav}" aria-label="お気に入り">${fav ? '★' : '☆'}</button>
    </li>`;
  }).join('');
}

function renderStudyBar(count = visibleWords().length) {
  $('studyBar').hidden = false;
  $('studyBtn').textContent = `カードで学習（${count} 語）`;
  $('studyBtn').disabled = !count;
  $('dirBtn').textContent = ui.dir === 'en' ? '英 → 日' : '日 → 英';
}

const summary = (w) => w.senses.map((s) => `${s.pos ? `${s.pos} ` : ''}${s.meanings.join('，')}`).join('　') || '（訳語なし）';

function toggleFav(no) {
  const title = hooks.currentBook()?.title;
  if (!title) return;
  const key = favKey(title, no);
  if (favs.has(key)) favs.delete(key); else favs.add(key);
  store.set('favs', [...favs]);
}

function refreshFavButtons() {
  const title = hooks.currentBook()?.title;
  for (const b of document.querySelectorAll('dialog [data-fav]')) {
    const on = favs.has(favKey(title, Number(b.dataset.fav)));
    b.setAttribute('aria-pressed', on);
    b.textContent = on ? '★' : '☆';
  }
}

/* ---------------- word details ---------------- */

function highlightWord(sentence, word) {
  const stem = word.length > 4 ? word.slice(0, -2) : word;
  const re = new RegExp(`\\b(${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-z]*)`, 'gi');
  return escapeHtml(sentence).replace(re, '<b>$1</b>');
}

const posBox = (pos) => (pos ? `<span class="pos">${escapeHtml(pos)}</span>` : '');
const refHtml = (r) => (typeof r === 'string'
  ? `<li>${escapeHtml(r)}</li>`
  : `<li><b>${escapeHtml(r.word)}</b>${r.meaning ? ` <span>${escapeHtml(r.meaning)}</span>` : ''}</li>`);

function detailHtml(w, { head = true } = {}) {
  const parts = [];
  if (head) {
    parts.push(`<div class="d-head">
      <div class="d-no">${w.no != null ? String(w.no).padStart(4, '0') : ''}</div>
      <div class="d-word">${escapeHtml(w.word)}</div>
      ${w.pron ? `<div class="d-pron">[${escapeHtml(w.pron)}]</div>` : ''}
    </div>`);
  }
  if (w.senses.length) {
    parts.push(`<ul class="d-senses">${w.senses.map((s) => `<li>${posBox(s.pos)}<span class="m">${escapeHtml(s.meanings.join('，'))}</span>${s.pron ? ` <span class="d-pron">[${escapeHtml(s.pron)}]</span>` : ''}</li>`).join('')}</ul>`);
  }
  if (w.related.length) {
    parts.push(`<h4>派生語・関連語</h4><ul class="d-rel">${w.related.map((r) => `<li>${posBox(r.pos)}<b>${escapeHtml(r.word)}</b>${r.meaning ? ` <span>${escapeHtml(r.meaning)}</span>` : ''}</li>`).join('')}</ul>`);
  }
  if (w.synonyms.length) parts.push(`<h4>同義語</h4><ul class="d-refs">${w.synonyms.map(refHtml).join('')}</ul>`);
  if (w.antonyms.length) parts.push(`<h4>反意語</h4><ul class="d-refs">${w.antonyms.map(refHtml).join('')}</ul>`);
  if (w.examples.length) {
    parts.push(`<h4>例文</h4><ul class="d-ex">${w.examples.map((x) => `<li><div class="en">${highlightWord(x.en, w.word)}</div>${x.ja ? `<div class="ja">${escapeHtml(x.ja)}</div>` : ''}</li>`).join('')}</ul>`);
  }
  if (w.note) parts.push(`<h4>補足</h4><p class="d-note">${escapeHtml(w.note)}</p>`);
  return parts.join('');
}

function openDetail(no) {
  const book = hooks.currentBook();
  const w = vocab.get(book?.title)?.byNo.get(no);
  if (!w) return;
  const fav = favs.has(favKey(book.title, w.no));
  const ti = trackForWord(book, w);
  $('wordSheetBody').innerHTML = `
    <div class="d-actions">
      <button class="star big" data-fav="${w.no}" aria-pressed="${fav}" aria-label="お気に入り">${fav ? '★' : '☆'}</button>
      ${ti >= 0 ? `<button class="pill" data-play="${ti}">▶ 収録音声を再生${w.cd ? `（CD${escapeHtml(w.cd)}）` : ''}</button>` : ''}
    </div>
    ${detailHtml(w)}`;
  $('wordSheet').showModal();
  $('wordSheet').scrollTop = 0;
}

/* ---------------- flashcards ---------------- */

const cards = { deck: [], order: [], i: 0, flipped: false };

function setDir(dir) {
  ui.dir = dir;
  store.set('cardDir', dir);
}

function startCards(words) {
  if (!words.length) return;
  cards.deck = words;
  makeOrder();
  $('cards').showModal();
  renderCard();
}

function makeOrder() {
  cards.order = cards.deck.map((_, i) => i);
  if (ui.shuffle) {
    for (let i = cards.order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards.order[i], cards.order[j]] = [cards.order[j], cards.order[i]];
    }
  }
  cards.i = 0;
  cards.flipped = false;
}

const cardWord = () => cards.deck[cards.order[cards.i]];

function renderCard() {
  const w = cardWord();
  if (!w) return;
  const title = hooks.currentBook()?.title;
  const front = ui.dir === 'en'
    ? `<div class="c-word">${escapeHtml(w.word)}</div>${w.pron ? `<div class="d-pron">[${escapeHtml(w.pron)}]</div>` : ''}`
    : `<ul class="c-ja">${w.senses.map((s) => `<li>${posBox(s.pos)}<span>${escapeHtml(s.meanings.join('，'))}</span></li>`).join('') || '<li>（訳語なし）</li>'}</ul>`;
  const back = ui.dir === 'en' ? detailHtml(w, { head: false }) : detailHtml(w);
  $('cardFront').innerHTML = `<div class="c-no">${w.no ?? ''}</div><div class="c-center">${front}</div><div class="c-hint">タップで裏返す</div>`;
  $('cardBack').innerHTML = `${ui.dir === 'en' ? `<div class="c-backword">${escapeHtml(w.word)}</div>` : ''}${back}`;
  $('cardBack').scrollTop = 0;
  $('card').classList.toggle('flipped', cards.flipped);
  $('cardProgress').textContent = `${cards.i + 1} / ${cards.order.length}`;
  const fav = favs.has(favKey(title, w.no));
  $('cardFav').textContent = fav ? '★' : '☆';
  $('cardFav').setAttribute('aria-pressed', fav);
  $('cardPrev').disabled = cards.i === 0;
  $('cardNext').textContent = cards.i === cards.order.length - 1 ? '最初から' : '次へ';
  $('cardDir').textContent = ui.dir === 'en' ? '英 → 日' : '日 → 英';
  $('cardShuffle').classList.toggle('on', ui.shuffle);
}

function flip() {
  cards.flipped = !cards.flipped;
  $('card').classList.toggle('flipped', cards.flipped);
}

function move(delta) {
  const next = cards.i + delta;
  if (next < 0) return;
  cards.i = next >= cards.order.length ? 0 : next;
  cards.flipped = false;
  $('card').classList.add('instant');
  renderCard();
  requestAnimationFrame(() => $('card').classList.remove('instant'));
}

function initCards() {
  let start = null;
  let swiped = false;
  const stage = $('cardStage');
  stage.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY }; swiped = false; });
  stage.addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { swiped = true; move(dx < 0 ? 1 : -1); }
  });
  stage.addEventListener('click', (e) => {
    if (swiped) { swiped = false; return; }
    // Taps on the back face's scrollable details still flip, unless text is being selected.
    if (!window.getSelection()?.toString()) flip();
    e.preventDefault();
  });
  $('cardPrev').addEventListener('click', () => move(-1));
  $('cardNext').addEventListener('click', () => move(1));
  $('cardFlip').addEventListener('click', flip);
  $('cardFav').addEventListener('click', () => {
    toggleFav(cardWord().no);
    renderCard();
    renderWords();
  });
  $('cardDir').addEventListener('click', () => {
    setDir(ui.dir === 'en' ? 'ja' : 'en');
    cards.flipped = false;
    renderCard();
    renderStudyBar();
  });
  $('cardShuffle').addEventListener('click', () => {
    ui.shuffle = !ui.shuffle;
    store.set('cardShuffle', ui.shuffle);
    makeOrder();
    renderCard();
  });
  $('cardClose').addEventListener('click', () => $('cards').close());
  $('cards').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
    else if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (e.target.closest('button') && e.key === 'Enter') return;
      e.preventDefault();
      flip();
    }
  });
}

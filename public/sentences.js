// Shared parts of the speaking practice tabs: the sentence corpus (Tatoeba), tappable English text
// and the word popup (meaning lookup, read aloud, add to マイ単語).
import { $, store, escapeHtml } from './util.js';
import { speak } from './speech.js';
import * as vocab from './vocab.js';

export const LEVELS = { 1: '初級', 2: '中級', 3: '上級' };
let corpus = null;

/** Loads public/sentences.json: [{id, jid, level, en, ja, alts}]. */
export async function loadSentences() {
  corpus ??= fetch('sentences.json', { cache: 'no-cache' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.status))))
    .then((d) => d.items.map((x) => ({ id: x.i, jid: x.j, level: x.l, en: x.e, ja: x.ja, alts: x.a || [] })))
    .catch((err) => { corpus = null; throw err; });
  return corpus;
}

export const tatoebaUrl = (id) => `https://tatoeba.org/ja/sentences/show/${id}`;

/** Per-sentence learning record shared by both tabs: {box, seen, ok, best}. */
const records = store.get('sentenceRecords', {});
export const record = (id) => records[id] || null;
export function updateRecord(id, fn) {
  records[id] = fn({ box: 0, seen: 0, ok: 0, ...records[id] });
  store.set('sentenceRecords', records);
  return records[id];
}
export const weakIds = () => Object.entries(records).filter(([, r]) => r.weak).map(([id]) => Number(id));

/**
 * Splits English into tokens with character offsets, so speech boundaries (charIndex) can light them up.
 * [{text, word, start, end}] — `word` is the bare word (no punctuation), empty for spaces.
 */
export function tokenize(en) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(en))) {
    const raw = m[0];
    const core = raw.match(/^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/);
    out.push({ text: raw, pre: core[1], word: core[2], post: core[3], start: m.index, end: m.index + raw.length });
  }
  return out;
}

/** English sentence as tappable words. */
export function wordsHtml(en) {
  return tokenize(en).map((t, i) => (t.word
    ? `${escapeHtml(t.pre)}<span class="w" data-i="${i}" data-word="${escapeHtml(t.word)}">${escapeHtml(t.word)}</span>${escapeHtml(t.post)}`
    : escapeHtml(t.text))).join(' ');
}

/** Lights up the word being spoken (speech boundary events). */
export function highlightAt(container, tokens, charIndex) {
  const i = tokens.findIndex((t) => charIndex >= t.start && charIndex < t.end);
  for (const el of container.querySelectorAll('.now')) el.classList.remove('now');
  if (i >= 0) container.querySelector(`[data-i="${i}"]`)?.classList.add('now');
}

export function clearHighlight(container) {
  for (const el of container.querySelectorAll('.now')) el.classList.remove('now');
}

/* ---------------- word popup ---------------- */

let popupCtx = null;

/** Shows the meaning (from the word book / idioms / my words) of a tapped word, with 🔊 and ＋. */
export function openWordPopup(word, sentence) {
  popupCtx = { word, sentence };
  const hit = vocab.lookupWord(word);
  const exact = vocab.findWord(word);
  $('wordPopWord').textContent = word;
  $('wordPopMeaning').innerHTML = hit
    ? `${hit.w.word.toLowerCase() !== word.toLowerCase() ? `<b>${escapeHtml(hit.w.word)}</b>：` : ''}${escapeHtml(vocab.summaryOf(hit.w))}<span class="src">${escapeHtml(hit.title)}</span>`
    : '<span class="muted">単語帳にない単語です</span>';
  const add = $('wordPopAdd');
  add.disabled = !!exact;
  add.textContent = exact ? `登録済み（${exact.title}）` : '＋ マイ単語に追加';
  $('wordPop').showModal();
}

export function initWordPopup({ pauseAudio }) {
  const dlg = $('wordPop');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('wordPopClose').addEventListener('click', () => dlg.close());
  $('wordPopSay').addEventListener('click', () => { pauseAudio?.(); speak(popupCtx.word); });
  $('wordPopAdd').addEventListener('click', () => {
    dlg.close();
    const { word, sentence } = popupCtx;
    // A capital only because it starts the sentence is dropped ("Where" → "where"); names keep theirs.
    const first = sentence?.en.trimStart().startsWith(word) && word !== 'I' && !/^[A-Z]{2,}$/.test(word);
    vocab.openAddWord({ word: first ? word.toLowerCase() : word, exEn: sentence?.en, exJa: sentence?.ja });
  });
}

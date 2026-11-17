// Free speech features built into the browser: text-to-speech (Web Speech API),
// speech recognition (where supported) and microphone recording (MediaRecorder).
import { store } from './util.js';

/* ---------------- text-to-speech ---------------- */

export const ttsSupported = 'speechSynthesis' in window;
let voices = [];
let voiceURI = store.get('ttsVoice', '');
const voiceListeners = new Set();

function loadVoices() {
  voices = speechSynthesis.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
  voiceListeners.forEach((fn) => fn());
}
if (ttsSupported) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

export const englishVoices = () => voices;
export const onVoicesChanged = (fn) => voiceListeners.add(fn);

// Natural / neural voices (Edge "Online (Natural)", Chrome "Google", iOS "Enhanced") sound far better.
function voiceScore(v) {
  let s = 0;
  if (/natural|neural|online|enhanced|premium/i.test(v.name)) s += 4;
  if (/google/i.test(v.name)) s += 3;
  if (/en[-_]US/i.test(v.lang)) s += 2;
  else if (/en[-_]GB/i.test(v.lang)) s += 1;
  return s;
}

export function currentVoice() {
  return voices.find((v) => v.voiceURI === voiceURI)
    || [...voices].sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
}

export function setVoice(uri) {
  voiceURI = uri;
  store.set('ttsVoice', uri);
}

let session = 0;

/**
 * Speaks English text. onBoundary(charIndex) fires per word where the voice supports it.
 * onEnd(ok, ms) gets how long the speech took (used to size the pause for repeating).
 * A newer speak() or stopSpeaking() silences the callbacks of the older one.
 */
export function speak(text, { rate = 1, onStart, onBoundary, onEnd } = {}) {
  const id = ++session;
  if (!ttsSupported || !text) { setTimeout(() => onEnd?.(false, 0)); return id; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = currentVoice();
  if (v) u.voice = v;
  u.lang = v?.lang || 'en-US';
  u.rate = rate;
  let started = 0;
  u.onstart = () => { started = performance.now(); if (id === session) onStart?.(); };
  u.onboundary = (e) => {
    if (id === session && (!e.name || e.name === 'word')) onBoundary?.(e.charIndex, e.charLength);
  };
  const done = (ok) => {
    if (id !== session) return;
    session++;
    onEnd?.(ok, started ? performance.now() - started : 0);
  };
  u.onend = () => done(true);
  u.onerror = () => done(false);
  // Chrome can drop an utterance queued in the same tick as cancel().
  setTimeout(() => { if (id === session) speechSynthesis.speak(u); }, 60);
  return id;
}

export function stopSpeaking() {
  session++;
  if (ttsSupported) speechSynthesis.cancel();
}

/* ---------------- speech recognition ---------------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const recognitionSupported = !!SR;

/** Listens for English speech. Returns {stop()}; onDone(text) fires once at the end. */
export function recognize({ onText, onDone, onError, continuous = false } = {}) {
  const r = new SR();
  r.lang = 'en-US';
  r.interimResults = true;
  r.continuous = continuous;  // false: stops by itself when you pause
  r.maxAlternatives = 1;
  let text = '';
  let finished = false;
  r.onresult = (e) => {
    text = [...e.results].map((res) => res[0].transcript).join(' ').replace(/\s+/g, ' ').trim();
    onText?.(text);
  };
  r.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') onError?.(e.error); };
  r.onend = () => { if (!finished) { finished = true; onDone?.(text); } };
  try {
    r.start();
  } catch (err) {
    finished = true;
    setTimeout(() => { onError?.(err.message); onDone?.(''); });
  }
  return { stop: () => { try { r.stop(); } catch { /* already stopped */ } } };
}

/* ---------------- recording ---------------- */

export const recordingSupported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

/** Starts recording the microphone. Resolves to {stop(): Promise<Blob>}. */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start();
  return {
    stop: () => new Promise((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      };
      if (rec.state !== 'inactive') rec.stop(); else rec.onstop();
    }),
  };
}

/* ---------------- comparing what was said ---------------- */

const NUMS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function numberWords(n) {
  if (n < 20) return NUMS[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${NUMS[n % 10]}` : ''}`;
  return String(n);
}

/** Lower-cases and splits into comparable words: contractions expanded, small numbers spelled out. */
export function compareWords(text) {
  return (text || '').toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\b(\d{1,2})\b/g, (_, d) => numberWords(Number(d)))
    .replace(/\bcan't\b|\bcannot\b/g, 'can not')
    .replace(/\bwon't\b/g, 'will not')
    .replace(/n't\b/g, ' not')
    .replace(/'re\b/g, ' are').replace(/'m\b/g, ' am').replace(/'ll\b/g, ' will')
    .replace(/'ve\b/g, ' have').replace(/'d\b/g, ' would')
    .replace(/\b(it|he|she|that|what|there|here|who|where|how)'s\b/g, '$1 is')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/).filter(Boolean);
}

/**
 * Matches the spoken words against the target words (longest common subsequence).
 * Returns a boolean per target word.
 */
export function matchWords(target, spoken) {
  const n = target.length;
  const m = spoken.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = target[i] === spoken[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hit = new Array(n).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (target[i] === spoken[j]) { hit[i] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return hit;
}

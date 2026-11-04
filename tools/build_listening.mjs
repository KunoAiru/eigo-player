// Builds public/listening.json: the TOEFL listening playlists (titles, lengths, chapters) joined with
// the answer keys in tools/listening_keys.json.
//
//   YT_API_KEY=xxxx node tools/build_listening.mjs          (YouTube Data API v3)
//   node tools/build_listening.mjs                          (no key: reads the public YouTube pages instead)
//
// The answer keys are read by hand from each video's "Answer Key" screen. A video in a playlist that has
// no entry in listening_keys.json is still listed, but it can't be marked until its key is added.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS = path.join(HERE, 'listening_keys.json');
const OUT = path.join(HERE, '..', 'public', 'listening.json');

const PLAYLISTS = [
  { id: 'PLDysj-2jpdTtsniblszfWEGsfHbFOFBYD', short: 'Tatiana（模試）' },
  { id: 'PLjSl_IdITCEXwAZTANKkdf2YwS61LP0MU', short: 'Nadeen（形式別）' },
];

const API_KEY = process.env.YT_API_KEY || readKeyFile();
function readKeyFile() {
  try { return fs.readFileSync(path.join(HERE, '.youtube_key'), 'utf8').trim(); } catch { return ''; }
}

/* ---------------- fetching ---------------- */

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url.replace(/key=[^&]+/, 'key=…')}\n${await res.text()}`);
  return res.json();
}

const isoSeconds = (iso) => {
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
};

async function viaApi(playlistId) {
  const api = 'https://www.googleapis.com/youtube/v3';
  const pl = await getJson(`${api}/playlists?part=snippet&id=${playlistId}&key=${API_KEY}`);
  const ids = [];
  let page = '';
  do {
    const r = await getJson(`${api}/playlistItems?part=contentDetails&maxResults=50&playlistId=${playlistId}&key=${API_KEY}${page ? `&pageToken=${page}` : ''}`);
    ids.push(...r.items.map((i) => i.contentDetails.videoId));
    page = r.nextPageToken;
  } while (page);
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await getJson(`${api}/videos?part=snippet,contentDetails&id=${ids.slice(i, i + 50).join(',')}&key=${API_KEY}`);
    for (const v of r.items) {
      videos.push({ id: v.id, title: v.snippet.title, len: isoSeconds(v.contentDetails.duration), description: v.snippet.description });
    }
  }
  // Private / deleted videos drop out of videos.list; keep the playlist order for the rest.
  videos.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  const s = pl.items[0]?.snippet ?? {};
  return { title: s.title, channel: s.channelTitle, videos };
}

const HEADERS = { 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1', 'user-agent': 'Mozilla/5.0 (listening-builder)' };
async function page(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}
const embedded = (html, name) => {
  const m = html.match(new RegExp(`var ${name} = (\\{.*?\\});(?:var |</script>)`, 's'));
  if (!m) throw new Error(`${name} not found`);
  return JSON.parse(m[1]);
};

async function viaPages(playlistId) {
  const data = embedded(await page(`https://www.youtube.com/playlist?list=${playlistId}&hl=en`), 'ytInitialData');
  const ids = [];
  JSON.stringify(data, (k, v) => {
    if (v?.playlistVideoRenderer?.videoId) ids.push(v.playlistVideoRenderer.videoId);
    if (v?.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') ids.push(v.lockupViewModel.contentId);
    return v;
  });
  const header = data.header?.pageHeaderRenderer?.pageTitle ?? data.metadata?.playlistMetadataRenderer?.title;
  const videos = [];
  let channel = '';
  for (const id of [...new Set(ids)]) {
    const p = embedded(await page(`https://www.youtube.com/watch?v=${id}&hl=en`), 'ytInitialPlayerResponse');
    const d = p.videoDetails;
    if (!d) continue;
    channel ||= d.author;
    videos.push({ id, title: d.title, len: Number(d.lengthSeconds), description: d.shortDescription || '' });
  }
  return { title: header, channel, videos };
}

/* ---------------- shaping ---------------- */

const toSec = (ts) => ts.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);

// "0:22 Questions 1-5" lines (several may share one line) -> [[22, "Questions 1-5"], ...]
function chapters(description) {
  const out = [];
  for (const line of description.split('\n')) {
    const marks = [...line.matchAll(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?=\s|$)/g)];
    marks.forEach((m, i) => {
      const from = m.index + m[0].length;
      const to = marks[i + 1]?.index ?? line.length;
      const label = line.slice(from, to).replace(/^[\s\-–—:|]+|[\s\-–—:|=]+$/g, '').trim();
      if (label) out.push([toSec(m[1]), label]);
    });
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const SKIP = /intro|instruction|subscribe|answer|download|worksheet|pdf/i;
const KIND = { mod: 'module', module: 'module', talk: 'talk', lecture: 'talk', topic: 'talk', conversation: 'conv', announcement: 'ann' };
function sectionKey(label) {
  const m = label.match(/\b(module|mod|talk|lecture|topic|conversation|announcement)\.?\s*0*(\d+)/i);
  return m ? `${KIND[m[1].toLowerCase()]}${m[2]}` : null;
}

function kindOf(groups) {
  const name = groups[0][0];
  if (/^module/i.test(name)) return 'test';
  if (/^questions/i.test(name)) return 'response';
  if (/^conversation/i.test(name)) return 'conversation';
  if (/^announcement/i.test(name)) return 'announcement';
  return 'talk';
}

// A key may set "start" (seconds) and "chapters": false when the description's timestamps are wrong.
function shape(v, key) {
  const all = key?.chapters === false ? [] : chapters(v.description);
  const end = key?.end ?? v.len;
  const content = all.filter(([t, label]) => !SKIP.test(label) && t < end);
  const kind = key ? kindOf(key.groups) : null;
  // No usable chapters: skip the channel intro by the usual length for that kind of video.
  const start = key?.start ?? (content.length ? content[0][0] : kind === 'response' ? 22 : kind ? 28 : 0);
  const sections = content.filter(([t]) => t >= start);
  const out = { id: v.id, title: v.title, len: v.len, start, end, sections };
  if (key) {
    out.kind = kind;
    out.groups = key.groups.map(([name, answers], i) => {
      const k = sectionKey(name);
      let at = k ? sections.find(([, label]) => sectionKey(label) === k)?.[0] : undefined;
      if (at === undefined && sections.length === key.groups.length) at = sections[i][0];
      return at === undefined ? { name, answers } : { name, answers, at };
    });
  }
  return out;
}

/* ---------------- main ---------------- */

const keys = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
console.log(API_KEY ? 'YouTube Data API で取得します' : 'API キーがないので公開ページから取得します');
const playlists = [];
const missing = [];
for (const p of PLAYLISTS) {
  const info = API_KEY ? await viaApi(p.id) : await viaPages(p.id);
  const videos = info.videos.map((v) => shape(v, keys[v.id]));
  missing.push(...videos.filter((v) => !v.groups).map((v) => `${v.id} ${v.title}`));
  playlists.push({ id: p.id, short: p.short, title: info.title, channel: info.channel, videos });
  console.log(`${p.short}: ${videos.length} 本`);
}
const data = { updated: new Date().toISOString().slice(0, 10), playlists };
fs.writeFileSync(OUT, `${JSON.stringify(data)}\n`);
console.log(`→ ${path.relative(process.cwd(), OUT)}`);
if (missing.length) console.log(`解答キーが未登録の動画（${missing.length} 本）:\n  ${missing.join('\n  ')}`);

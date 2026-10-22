// Serves the player app and every audio folder next to it to phones on the same Wi-Fi.
//   node server.mjs [audioRoot] [port]
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseID3, id3TagSize } from './public/id3.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const AUDIO_ROOT = path.resolve(process.argv[2] || path.join(HERE, '..'));
const PORT = Number(process.argv[3] || process.env.PORT || 8800);

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
};

const naturalCompare = new Intl.Collator('ja', { numeric: true }).compare;

async function readTags(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(10);
    await fh.read(head, 0, 10, 0);
    const size = id3TagSize(head);
    if (!size) return {};
    const buf = Buffer.alloc(Math.min(size, 2 * 1024 * 1024));
    await fh.read(buf, 0, buf.length, 0);
    return parseID3(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
  } finally {
    await fh.close();
  }
}

async function walk(dir) {
  const out = [];
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (AUDIO_EXT.has(path.extname(ent.name).toLowerCase())) out.push(full);
  }
  return out;
}

// Each top-level folder under AUDIO_ROOT is one book; sub-folders (CD1, CD2...) are discs.
async function scanLibrary() {
  const books = [];
  for (const ent of await fsp.readdir(AUDIO_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.') || path.join(AUDIO_ROOT, ent.name) === HERE) continue;
    const bookDir = path.join(AUDIO_ROOT, ent.name);
    const files = await walk(bookDir);
    if (!files.length) continue;
    const tracks = await Promise.all(files.map(async (file) => {
      const rel = path.relative(AUDIO_ROOT, file).split(path.sep);
      const sub = rel.slice(1, -1).join('/');
      const tags = await readTags(file).catch(() => ({}));
      const base = path.basename(file, path.extname(file));
      return {
        id: rel.join('/'),
        title: tags.title || base,
        file: base,
        album: tags.album,
        disc: tags.disc ?? (parseInt(sub.match(/\d+/)?.[0], 10) || 1),
        discLabel: sub || (tags.disc ? `Disc ${tags.disc}` : ''),
        track: tags.track,
        url: '/audio/' + rel.map(encodeURIComponent).join('/'),
      };
    }));
    tracks.sort((a, b) => a.disc - b.disc || (a.track ?? 1e9) - (b.track ?? 1e9) || naturalCompare(a.id, b.id));
    books.push({ id: ent.name, title: tracks.find((t) => t.album)?.album || ent.name, tracks });
  }
  books.sort((a, b) => naturalCompare(a.title, b.title));
  return books;
}

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => `http://${n.address}:${PORT}/`);
}

async function sendFile(req, res, file) {
  let stat;
  try { stat = await fsp.stat(file); } catch { return notFound(res); }
  if (!stat.isFile()) return notFound(res);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const isAudio = type.startsWith('audio/');
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': isAudio ? 'public, max-age=86400' : 'no-cache',
  };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : stat.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

// Resolve a URL path under root, refusing anything that escapes it.
function safeJoin(root, urlPath) {
  const full = path.resolve(root, '.' + path.posix.normalize('/' + urlPath));
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/api/library') {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ books: await scanLibrary(), urls: lanUrls() }));
    }
    if (pathname.startsWith('/audio/')) {
      const file = safeJoin(AUDIO_ROOT, pathname.slice('/audio/'.length));
      return file && !file.startsWith(HERE + path.sep) ? sendFile(req, res, file) : notFound(res);
    }
    const file = safeJoin(PUBLIC, pathname === '/' ? 'index.html' : pathname);
    return file ? sendFile(req, res, file) : notFound(res);
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  const books = await scanLibrary();
  console.log(`\n  音声フォルダ: ${AUDIO_ROOT}`);
  for (const b of books) console.log(`    - ${b.title} (${b.tracks.length}曲)`);
  console.log(`\n  PC で開く:   http://localhost:${PORT}/`);
  for (const u of lanUrls()) console.log(`  スマホで開く: ${u}`);
  console.log('\n  (止めるときは Ctrl+C)\n');
});

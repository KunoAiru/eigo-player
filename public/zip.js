// Minimal ZIP reader for importing a whole book as one file (phones cannot pick folders).
// Stored entries are sliced straight out of the file, so a large ZIP never has to fit in memory;
// deflated entries are inflated with the browser's DecompressionStream.

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

async function view(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

function decodeName(bytes, utf8) {
  if (!utf8) {
    try { return new TextDecoder('shift_jis', { fatal: true }).decode(bytes); } catch { /* not Shift-JIS */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Returns File objects for every file in the ZIP; each has `relPath` (its path inside the ZIP). */
export async function unzip(file) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await view(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP ファイルではありません');
  const count = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdStart = u32(tail, eocd + 16);
  const cd = await view(file, cdStart, cdStart + cdSize);

  const entries = [];
  for (let p = 0, i = 0; i < count && u32(cd, p) === 0x02014b50; i++) {
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const size = u32(cd, p + 20);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const offset = u32(cd, p + 42);
    const name = decodeName(new Uint8Array(cd.buffer, p + 46, nameLen), flags & 0x800);
    entries.push({ name, method, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const files = [];
  for (const e of entries) {
    if (e.name.endsWith('/') || e.name.startsWith('__MACOSX/') || e.name.split('/').pop().startsWith('.')) continue;
    const local = await view(file, e.offset, e.offset + 30);
    const start = e.offset + 30 + u16(local, 26) + u16(local, 28);
    let blob = file.slice(start, start + e.size);
    if (e.method === 8) {
      blob = await new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    } else if (e.method !== 0) {
      continue;  // other compression methods are not used for audio
    }
    const base = e.name.split('/').pop();
    const type = /\.mp3$/i.test(base) ? 'audio/mpeg' : /\.json$/i.test(base) ? 'application/json' : '';
    const f = new File([blob], base, { type });
    f.relPath = e.name;
    files.push(f);
  }
  return files;
}

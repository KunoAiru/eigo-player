// Minimal ID3v2.2 / 2.3 / 2.4 text-frame reader (browser + Node).
// Japanese CDs often store Shift-JIS in "ISO-8859-1" frames, so we try that first.

const FRAME_MAP = {
  TT2: 'title', TIT2: 'title',
  TAL: 'album', TALB: 'album',
  TP1: 'artist', TPE1: 'artist',
  TRK: 'track', TRCK: 'track',
  TPA: 'disc', TPOS: 'disc',
};

const synchsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];

/** Total tag length (header included) from the first 10 bytes, or 0 if none. */
export function id3TagSize(head) {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  return synchsafe(head, 6) + 10 + (head[5] & 0x10 ? 10 : 0);
}

function decodeText(bytes) {
  const enc = bytes[0];
  let body = bytes.subarray(1);
  let text;
  try {
    if (enc === 1 || enc === 2) {
      let le = enc === 1;
      if (body[0] === 0xff && body[1] === 0xfe) { le = true; body = body.subarray(2); }
      else if (body[0] === 0xfe && body[1] === 0xff) { le = false; body = body.subarray(2); }
      text = new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(body);
    } else if (enc === 3) {
      text = new TextDecoder('utf-8').decode(body);
    } else if (body.some((c) => c >= 0x80)) {
      try { text = new TextDecoder('shift_jis', { fatal: true }).decode(body); }
      catch { text = new TextDecoder('latin1').decode(body); }
    } else {
      text = new TextDecoder('latin1').decode(body);
    }
  } catch {
    return '';
  }
  return text.split('\0')[0].trim();
}

/** Parse an ID3v2 tag. Returns {title, album, artist, track, disc} (missing keys omitted). */
export function parseID3(buf) {
  const out = {};
  if (id3TagSize(buf) === 0) return out;
  const ver = buf[3];
  const flags = buf[5];
  const end = Math.min(buf.length, synchsafe(buf, 6) + 10);
  let i = 10;
  if (flags & 0x40 && ver >= 3) {
    i += ver === 4 ? synchsafe(buf, 10) : ((buf[10] << 24) | (buf[11] << 16) | (buf[12] << 8) | buf[13]) + 4;
  }
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  while (i + hdrLen <= end) {
    const id = String.fromCharCode(...buf.subarray(i, i + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let size;
    if (ver === 2) size = (buf[i + 3] << 16) | (buf[i + 4] << 8) | buf[i + 5];
    else if (ver === 4) size = synchsafe(buf, i + 4);
    else size = ((buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7]) >>> 0;
    const start = i + hdrLen;
    if (size <= 0 || start + size > end) break;
    const key = FRAME_MAP[id];
    if (key && !(key in out)) {
      const val = decodeText(buf.subarray(start, start + size));
      if (val) out[key] = key === 'track' || key === 'disc' ? parseInt(val, 10) || undefined : val;
      if (out[key] === undefined) delete out[key];
    }
    i = start + size;
  }
  return out;
}

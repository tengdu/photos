// Videos in the build: the metadata comes straight from the QuickTime/MP4 boxes (nothing is
// decoded), and ffmpeg decodes one frame for the video's single 720px preview.
import { open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const EPOCH_1904 = Date.UTC(1904, 0, 1); // QuickTime times count seconds from here

function* boxes(buf, start = 0, end = buf.length) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    let head = 8;
    if (size === 1 && p + 16 <= end) {
      size = Number(buf.readBigUInt64BE(p + 8));
      head = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < head || p + size > end) return;
    yield { type: buf.toString('latin1', p + 4, p + 8), at: p, start: p + head, end: p + size };
    p += size;
  }
}

const child = (buf, box, ...types) => types.reduce((b, t) => b && [...boxes(buf, b.start, b.end)].find((c) => c.type === t), box);

// The moov box holds all metadata. iPhone videos keep it at the end, after the media data,
// so the file is walked box by box instead of being read whole.
async function readMoov(file) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(16);
    for (let p = 0; p + 8 <= size;) {
      await fh.read(head, 0, 16, p);
      let len = head.readUInt32BE(0);
      let hl = 8;
      if (len === 1) {
        len = Number(head.readBigUInt64BE(8));
        hl = 16;
      } else if (len === 0) {
        len = size - p;
      }
      if (len < hl) break;
      if (head.toString('latin1', 4, 8) === 'moov') {
        const moov = Buffer.alloc(len - hl);
        await fh.read(moov, 0, moov.length, p + hl);
        return moov;
      }
      p += len;
    }
  } finally {
    await fh.close();
  }
  throw new Error('not a QuickTime/MP4 video (no moov box)');
}

// mvhd and mdhd: creation time, timescale, duration.
function header(buf, b) {
  const o = b.start + 4;
  return buf[b.start] === 1
    ? { created: Number(buf.readBigUInt64BE(o)), timescale: buf.readUInt32BE(o + 16), duration: Number(buf.readBigUInt64BE(o + 20)) }
    : { created: buf.readUInt32BE(o), timescale: buf.readUInt32BE(o + 8), duration: buf.readUInt32BE(o + 12) };
}

function track(buf, trak) {
  const tkhd = child(buf, trak, 'tkhd');
  const mdia = child(buf, trak, 'mdia');
  const hdlr = mdia && child(buf, mdia, 'hdlr');
  if (!tkhd || !hdlr) return null;
  const v1 = buf[tkhd.start] === 1;
  const m = tkhd.start + 4 + (v1 ? 48 : 36); // display matrix
  const fixed = (i) => buf.readInt32BE(m + i * 4) / 65536;
  const t = {
    handler: buf.toString('latin1', hdlr.start + 8, hdlr.start + 12),
    enabled: (buf.readUInt32BE(tkhd.start) & 1) === 1,
    width: buf.readUInt32BE(m + 36) / 65536,
    height: buf.readUInt32BE(m + 40) / 65536,
    rotation: Math.round((Math.atan2(fixed(1), fixed(0)) * 180) / Math.PI),
    ...(child(buf, mdia, 'mdhd') && header(buf, child(buf, mdia, 'mdhd'))),
  };
  const stbl = child(buf, mdia, 'minf', 'stbl');
  const stsd = stbl && child(buf, stbl, 'stsd');
  if (stsd && buf.readUInt32BE(stsd.start + 4) > 0) {
    const e = stsd.start + 8; // first sample description
    t.format = buf.toString('latin1', e + 4, e + 8);
    if (t.handler === 'vide') {
      t.codedWidth = buf.readUInt16BE(e + 32);
      t.codedHeight = buf.readUInt16BE(e + 34);
      for (const c of boxes(buf, e + 86, e + buf.readUInt32BE(e))) {
        if (c.type === 'colr' && /^ncl[xc]$/.test(buf.toString('latin1', c.start, c.start + 4))) {
          t.color = { primaries: buf.readUInt16BE(c.start + 4), transfer: buf.readUInt16BE(c.start + 6), matrix: buf.readUInt16BE(c.start + 8) };
        }
        if (c.type === 'dvcC' || c.type === 'dvvC' || c.type === 'dvwC') t.dolbyVision = true;
      }
    }
  }
  const stsz = stbl && (child(buf, stbl, 'stsz') || child(buf, stbl, 'stz2'));
  if (stsz) t.samples = buf.readUInt32BE(stsz.start + 8);
  return t;
}

function value(buf, data) {
  const type = buf.readUInt32BE(data.start) & 0xffffff;
  const v = buf.subarray(data.start + 8, data.end);
  if (type === 1) return v.toString('utf8');
  if (type === 21 && [1, 2, 4].includes(v.length)) return v.readIntBE(0, v.length);
  if (type === 22 && [1, 2, 4].includes(v.length)) return v.readUIntBE(0, v.length);
  if (type === 23 && v.length === 4) return v.readFloatBE(0);
  if (type === 24 && v.length === 8) return v.readDoubleBE(0);
  return undefined;
}

// Metadata items: Apple's "mdta" keys (com.apple.quicktime.…) or iTunes-style ones (©day…).
function metaItems(buf, meta, out) {
  // In QuickTime files 'meta' is a plain box; in MP4 files it has 4 bytes of version/flags.
  const start = buf.toString('latin1', meta.start + 4, meta.start + 8) === 'hdlr' ? meta.start : meta.start + 4;
  const box = { start, end: meta.end };
  const keys = [];
  const kb = child(buf, box, 'keys');
  if (kb) {
    let p = kb.start + 8;
    for (let n = buf.readUInt32BE(kb.start + 4); n > 0 && p + 8 <= kb.end; n--) {
      const size = buf.readUInt32BE(p);
      if (size < 8) break;
      keys.push(buf.toString('utf8', p + 8, p + size));
      p += size;
    }
  }
  const ilst = child(buf, box, 'ilst');
  for (const item of ilst ? boxes(buf, ilst.start, ilst.end) : []) {
    const key = kb ? keys[buf.readUInt32BE(item.at + 4) - 1] : item.type;
    const data = [...boxes(buf, item.start, item.end)].find((d) => d.type === 'data');
    if (key && data) out[key] ??= value(buf, data);
  }
}

// QuickTime user data: ©xyz, ©day, ©mak, ©mod… (16-bit length, 16-bit language, text).
function userData(buf, udta, out) {
  for (const b of boxes(buf, udta.start, udta.end)) {
    if (b.type === 'meta') metaItems(buf, b, out);
    else if (b.type[0] === '©' && b.end - b.start > 4) {
      const len = buf.readUInt16BE(b.start);
      if (len > 0 && b.start + 4 + len <= b.end) out[b.type] ??= buf.toString('utf8', b.start + 4, b.start + 4 + len);
    }
  }
}

// "2026-09-20T18:30:05+0900" → "2026-09-20T18:30:05+09:00" (the video's own local time).
function localTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/.exec(typeof s === 'string' ? s.trim() : '');
  if (!m || m[1] === '0000') return null;
  const off = !m[7] ? '' : m[7] === 'Z' ? '+00:00' : `${m[7].slice(0, 3)}:${m[7].slice(-2)}`;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`;
}

// ISO 6709, e.g. "+35.6586+139.7454+040.000/".
function location(s) {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(typeof s === 'string' ? s : '');
  const lat = m && Number(m[1]), lon = m && Number(m[2]);
  return m && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon) ? [lat, lon] : null;
}

const CODECS = { hvc1: 'HEVC', hev1: 'HEVC', dvh1: 'HEVC', dvhe: 'HEVC', avc1: 'H.264', avc3: 'H.264', av01: 'AV1', vp09: 'VP9', mp4v: 'MPEG-4' };

/** Capture time, place, camera, size and video details of a .mov/.mp4 file. */
export async function readVideo(file) {
  const moov = await readMoov(file);
  const root = { start: 0, end: moov.length };
  const mvhd = child(moov, root, 'mvhd');
  const movie = mvhd ? header(moov, mvhd) : {};
  const tracks = [...boxes(moov)].filter((b) => b.type === 'trak').map((b) => track(moov, b)).filter(Boolean);
  // The picture: the largest enabled video track (Live Photo clips also carry small auxiliary ones).
  const pictures = tracks.filter((t) => t.handler === 'vide');
  const v = (pictures.filter((t) => t.enabled).length ? pictures.filter((t) => t.enabled) : pictures)
    .sort((a, b) => b.width * b.height - a.width * a.height || b.codedWidth * b.codedHeight - a.codedWidth * a.codedHeight)[0];
  if (!v) throw new Error('no video track');

  const tags = {};
  const meta = child(moov, root, 'meta');
  if (meta) metaItems(moov, meta, tags);
  const udta = child(moov, root, 'udta');
  if (udta) userData(moov, udta, tags);
  const tag = (...names) => names.map((n) => tags[n]).find((x) => x !== undefined && x !== '');

  const created = movie.created > 2082844800 ? new Date(EPOCH_1904 + movie.created * 1000).toISOString().slice(0, 19) : null; // after 1970
  const taken = localTime(tag('com.apple.quicktime.creationdate', '©day')) || (created && `${created}+00:00`);

  const make = tag('com.apple.quicktime.make', '©mak');
  const model = tag('com.apple.quicktime.model', '©mod');
  let lens = tag('com.apple.quicktime.camera.lens_model');
  if (typeof lens === 'string' && model && lens.startsWith(model)) lens = lens.slice(model.length).trim(); // "iPhone 15 Pro back triple camera…"
  const fl35 = Number(tag('com.apple.quicktime.camera.focal_length.35mm_equivalent')) || undefined;
  const cam = Object.fromEntries(Object.entries({ make, model, lens, fl35 }).filter(([, x]) => x !== undefined && x !== ''));

  let w = Math.round(v.width) || v.codedWidth;
  let h = Math.round(v.height) || v.codedHeight;
  if (Math.abs(v.rotation) % 180 === 90) [w, h] = [h, w];
  const seconds = movie.timescale ? movie.duration / movie.timescale : v.timescale ? v.duration / v.timescale : 0;
  const trackSeconds = v.timescale ? v.duration / v.timescale : 0;
  const fps = v.samples && trackSeconds ? Math.round(v.samples / trackSeconds) : undefined;
  const transfer = v.color?.transfer;
  const hdr = v.dolbyVision ? 'Dolby Vision' : transfer === 18 ? 'HLG' : transfer === 16 ? 'HDR10' : undefined;

  return {
    taken,
    geo: location(tag('com.apple.quicktime.location.ISO6709', '©xyz')),
    cam: Object.keys(cam).length ? cam : null,
    w,
    h,
    video: {
      dur: Math.round(seconds * 10) / 10,
      codec: CODECS[v.format] || v.format || undefined,
      ...(fps && { fps }),
      ...(hdr && { hdr }),
    },
    color: v.color || null,
  };
}

/**
 * The first frame as PNG, upright and in sRGB (HDR is tone-mapped), via ffmpeg.
 * `color` comes from readVideo(); without zscale in ffmpeg, the frame is decoded as is.
 */
export function videoFrame(file, color) {
  const hdr = color?.transfer === 16 || color?.transfer === 18; // PQ, HLG
  const wide = [9, 11, 12].includes(color?.primaries); // BT.2020, DCI-P3, Display P3
  const filters = [];
  if (hdr) filters.push('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p');
  else if (wide) filters.push('zscale=p=bt709');
  filters.push(null);
  let error;
  for (const vf of filters) {
    try {
      const png = execFileSync(FFMPEG, [
        '-v', 'error', '-i', file, '-map', '0:V:0', '-frames:v', '1',
        ...(vf ? ['-vf', vf] : []),
        '-f', 'image2pipe', '-c:v', 'png', '-',
      ], { maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      if (error) console.warn(`warning: ffmpeg couldn't convert the colours (${error.stderr?.toString().trim().split('\n').pop()}); preview decoded as is`);
      return png;
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('ffmpeg not found (needed for video previews)');
      error = e;
    }
  }
  throw error;
}

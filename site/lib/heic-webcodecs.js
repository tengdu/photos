// Fast HEIC decoding with the browser's (usually hardware) HEVC decoder via WebCodecs.
// A HEIC photo is a grid of HEVC-coded tiles; each tile is decoded as a key frame, drawn into
// place, then the file's rotation/mirroring is applied. Throws on anything unusual, so the
// caller can fall back to libheif.
import { itemData, itemProps, refsFrom } from './heif.js';

/** RFC 6381 codec string ("hvc1.1.6.L93.B0") from an HEVCDecoderConfigurationRecord. */
export function hevcCodecString(hvcC) {
  const profileSpace = hvcC[1] >> 6;
  const tier = (hvcC[1] >> 5) & 1;
  const profile = hvcC[1] & 0x1f;
  const compat = ((hvcC[2] << 24) | (hvcC[3] << 16) | (hvcC[4] << 8) | hvcC[5]) >>> 0;
  let reversed = 0;
  for (let i = 0; i < 32; i++) if (compat & (2 ** i)) reversed += 2 ** (31 - i);
  const constraints = [...hvcC.subarray(6, 12)];
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  return ['hvc1', ['', 'A', 'B', 'C'][profileSpace] + profile, reversed.toString(16), (tier ? 'H' : 'L') + hvcC[12],
    ...constraints.map((b) => b.toString(16).toUpperCase())].join('.');
}

function gridLayout(heif, id) {
  const d = itemData(heif, id);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const wide = d[1] & 1;
  return {
    rows: d[2] + 1,
    cols: d[3] + 1,
    width: wide ? dv.getUint32(4) : dv.getUint16(4),
    height: wide ? dv.getUint32(8) : dv.getUint16(6),
  };
}

function applyTransform(src, t, colorSpace) {
  const { width: w, height: h } = src;
  const quarter = t.type === 'irot' && t.angle % 180 === 90;
  const out = new OffscreenCanvas(quarter ? h : w, quarter ? w : h);
  const c = out.getContext('2d', { colorSpace });
  if (t.type === 'irot') {
    if (t.angle === 90) { c.translate(0, w); c.rotate(-Math.PI / 2); } // counter-clockwise
    else if (t.angle === 180) { c.translate(w, h); c.rotate(Math.PI); }
    else if (t.angle === 270) { c.translate(h, 0); c.rotate(Math.PI / 2); }
  } else if (t.axis === 0) { c.translate(w, 0); c.scale(-1, 1); } // mirror left↔right
  else { c.translate(0, h); c.scale(1, -1); } // mirror top↕bottom
  c.drawImage(src, 0, 0);
  return out;
}

/**
 * Decode the primary image. Returns { canvas: OffscreenCanvas, width, height }.
 * `colorSpace` is the canvas color space ('display-p3' or 'srgb'); `frameColorSpace`
 * overrides the color description of the decoded HEVC frames.
 */
export async function decodeWithWebCodecs(heif, { colorSpace, frameColorSpace } = {}) {
  if (typeof VideoDecoder === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('WebCodecs is not available');
  const primary = heif.items.get(heif.primaryId);
  const props = itemProps(heif, heif.primaryId);
  if (props.transforms.some((t) => t.type === 'clap')) throw new Error('cropped (clap) images are not handled here');
  const hasAlpha = heif.refs.some((r) => r.type === 'auxl' && r.to.includes(heif.primaryId)
    && /alpha/i.test(itemProps(heif, r.from).auxC?.auxType || ''));
  if (hasAlpha) throw new Error('images with alpha are not handled here');

  let tiles, grid;
  if (primary?.type === 'grid') {
    tiles = refsFrom(heif, 'dimg', heif.primaryId);
    grid = gridLayout(heif, heif.primaryId);
  } else if (primary?.type === 'hvc1') {
    tiles = [heif.primaryId];
    grid = { rows: 1, cols: 1, width: props.ispe.width, height: props.ispe.height };
  } else {
    throw new Error(`unsupported image type ${primary?.type}`);
  }
  if (!tiles.length || tiles.length !== grid.rows * grid.cols) throw new Error('unexpected tile layout');
  const first = itemProps(heif, tiles[0]);
  if (!first.hvcC || !first.ispe) throw new Error('missing HEVC configuration');
  for (const id of tiles) {
    const p = itemProps(heif, id);
    if (heif.items.get(id).type !== 'hvc1' || p.hvcC?.record !== first.hvcC.record && !sameBytes(p.hvcC?.record, first.hvcC.record)) {
      throw new Error('tiles with different configurations');
    }
  }

  const config = {
    codec: hevcCodecString(first.hvcC.record),
    description: first.hvcC.record,
    codedWidth: first.ispe.width,
    codedHeight: first.ispe.height,
    optimizeForLatency: true,
    ...(frameColorSpace && { colorSpace: frameColorSpace }),
  };
  const { supported } = await VideoDecoder.isConfigSupported(config);
  if (!supported) throw new Error(`HEVC (${config.codec}) is not supported by this browser`);

  const canvas = new OffscreenCanvas(grid.width, grid.height);
  const ctx = canvas.getContext('2d', { colorSpace });
  const tileW = first.ispe.width, tileH = first.ispe.height;
  let failure = null;
  let drawn = 0;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const i = frame.timestamp;
      ctx.drawImage(frame, (i % grid.cols) * tileW, Math.floor(i / grid.cols) * tileH);
      frame.close();
      drawn++;
    },
    error: (e) => { failure = e; },
  });
  try {
    decoder.configure(config);
    tiles.forEach((id, i) => decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, data: itemData(heif, id) })));
    await decoder.flush();
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (failure) throw failure;
  if (drawn !== tiles.length) throw new Error(`decoded ${drawn} of ${tiles.length} tiles`);

  let out = canvas;
  for (const t of props.transforms) out = applyTransform(out, t, colorSpace);
  return { canvas: out, width: out.width, height: out.height };
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Minimal HEIF (ISO/IEC 23008-12) container reader, shared by the build (Node) and the browser.
// It only reads structure: items, their locations, properties and references. Pixel decoding
// is left to libheif / WebCodecs.

const td = new TextDecoder();
const fourcc = (u8, at) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);

function* boxes(u8, start, end) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let at = start;
  while (at + 8 <= end) {
    let size = dv.getUint32(at);
    const type = fourcc(u8, at + 4);
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(at + 8)); header = 16; }
    else if (size === 0) size = end - at;
    if (size < header || at + size > end) throw new Error(`bad box ${type} at ${at}`);
    yield { type, start: at, body: at + header, end: at + size };
    at += size;
  }
}

function reader(u8, at) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    get at() { return at; },
    u8() { return dv.getUint8(at++); },
    u16() { const v = dv.getUint16(at); at += 2; return v; },
    u32() { const v = dv.getUint32(at); at += 4; return v; },
    uN(bytes) {
      if (bytes === 0) return 0;
      if (bytes === 4) return this.u32();
      if (bytes === 8) { const v = Number(dv.getBigUint64(at)); at += 8; return v; }
      if (bytes === 2) return this.u16();
      throw new Error(`unsupported field size ${bytes}`);
    },
    str(end) { let e = at; while (e < end && u8[e] !== 0) e++; const s = td.decode(u8.subarray(at, e)); at = Math.min(e + 1, end); return s; },
    skip(n) { at += n; },
  };
}

const fullBox = (r) => { const v = r.u32(); return { version: v >>> 24, flags: v & 0xffffff }; };

function parseProperty(u8, box) {
  const r = reader(u8, box.body);
  switch (box.type) {
    case 'ispe': fullBox(r); return { width: r.u32(), height: r.u32() };
    case 'irot': return { angle: (r.u8() & 3) * 90 };
    case 'imir': return { axis: r.u8() & 1 };
    case 'colr': {
      const kind = fourcc(u8, box.body);
      r.skip(4);
      if (kind === 'nclx') {
        const primaries = r.u16(), transfer = r.u16(), matrix = r.u16();
        return { kind, primaries, transfer, matrix, fullRange: (r.u8() & 0x80) !== 0 };
      }
      return { kind, icc: u8.subarray(r.at, box.end) };
    }
    case 'hvcC': return { record: u8.subarray(box.body, box.end) };
    case 'auxC': fullBox(r); return { auxType: r.str(box.end) };
    case 'pixi': { fullBox(r); const n = r.u8(); return { bits: Array.from({ length: n }, () => r.u8()) }; }
    default: return {};
  }
}

export function parseHeif(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  let meta;
  for (const b of boxes(u8, 0, u8.length)) {
    if (b.type === 'ftyp') {
      const brands = [];
      for (let at = b.body + 8; at + 4 <= b.end; at += 4) brands.push(fourcc(u8, at));
      if (![fourcc(u8, b.body), ...brands].some((x) => ['heic', 'heix', 'mif1', 'msf1', 'heim', 'heis'].includes(x))) {
        throw new Error('not a HEIF file');
      }
    }
    if (b.type === 'meta') { meta = b; break; }
  }
  if (!meta) throw new Error('no meta box');

  const heif = { u8, primaryId: 0, items: new Map(), props: [], refs: [], idat: null };
  for (const b of boxes(u8, meta.body + 4, meta.end)) {
    const r = reader(u8, b.body);
    if (b.type === 'pitm') {
      const { version } = fullBox(r);
      heif.primaryId = version === 0 ? r.u16() : r.u32();
    } else if (b.type === 'iinf') {
      const { version } = fullBox(r);
      version === 0 ? r.u16() : r.u32();
      for (const e of boxes(u8, r.at, b.end)) {
        if (e.type !== 'infe') continue;
        const er = reader(u8, e.body);
        const { version: v } = fullBox(er);
        if (v < 2) continue;
        const id = v === 2 ? er.u16() : er.u32();
        er.u16(); // protection index
        const type = fourcc(u8, er.at);
        er.skip(4);
        const item = heif.items.get(id) || { id, extents: [], props: [] };
        Object.assign(item, { type, name: er.str(e.end) });
        heif.items.set(id, item);
      }
    } else if (b.type === 'iloc') {
      const { version } = fullBox(r);
      const a = r.u8(), c = r.u8();
      const offsetSize = a >> 4, lengthSize = a & 15, baseOffsetSize = c >> 4;
      const indexSize = version >= 1 ? c & 15 : 0;
      const count = version < 2 ? r.u16() : r.u32();
      for (let i = 0; i < count; i++) {
        const id = version < 2 ? r.u16() : r.u32();
        const method = version >= 1 ? r.u16() & 15 : 0;
        r.u16(); // data reference index
        const base = r.uN(baseOffsetSize);
        const n = r.u16();
        const extents = [];
        for (let k = 0; k < n; k++) {
          if (indexSize) r.uN(indexSize);
          const offset = r.uN(offsetSize), length = r.uN(lengthSize);
          extents.push({ offset: base + offset, length });
        }
        const item = heif.items.get(id) || { id, props: [] };
        Object.assign(item, { method, extents });
        heif.items.set(id, item);
      }
    } else if (b.type === 'iref') {
      const { version } = fullBox(r);
      for (const e of boxes(u8, r.at, b.end)) {
        const er = reader(u8, e.body);
        const id = () => (version === 0 ? er.u16() : er.u32());
        const from = id(), n = er.u16();
        heif.refs.push({ type: e.type, from, to: Array.from({ length: n }, id) });
      }
    } else if (b.type === 'idat') {
      heif.idat = u8.subarray(b.body, b.end);
    } else if (b.type === 'iprp') {
      for (const p of boxes(u8, b.body, b.end)) {
        if (p.type === 'ipco') {
          for (const prop of boxes(u8, p.body, p.end)) heif.props.push({ type: prop.type, ...parseProperty(u8, prop) });
        } else if (p.type === 'ipma') {
          const pr = reader(u8, p.body);
          const { version, flags } = fullBox(pr);
          const n = pr.u32();
          for (let i = 0; i < n; i++) {
            const id = version < 1 ? pr.u16() : pr.u32();
            const k = pr.u8();
            const list = [];
            for (let j = 0; j < k; j++) {
              const v = flags & 1 ? pr.u16() : pr.u8();
              const index = flags & 1 ? v & 0x7fff : v & 0x7f;
              if (index) list.push(index - 1);
            }
            const item = heif.items.get(id) || { id, extents: [] };
            item.props = list;
            heif.items.set(id, item);
          }
        }
      }
    }
  }
  return heif;
}

/** Bytes of an item, concatenating its extents. */
export function itemData(heif, id) {
  const item = heif.items.get(id);
  if (!item) throw new Error(`no item ${id}`);
  const src = item.method === 1 ? heif.idat : heif.u8;
  if (item.method > 1 || !src) throw new Error(`unsupported construction method ${item.method}`);
  if (item.extents.length === 1) {
    const { offset, length } = item.extents[0];
    return src.subarray(offset, length ? offset + length : src.length);
  }
  const total = item.extents.reduce((n, e) => n + e.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const { offset, length } of item.extents) { out.set(src.subarray(offset, offset + length), at); at += length; }
  return out;
}

/** Properties of an item, keyed by type (first one wins), plus the ordered transform list. */
export function itemProps(heif, id) {
  const out = { transforms: [] };
  for (const i of heif.items.get(id)?.props || []) {
    const p = heif.props[i];
    if (!p) continue;
    if (!(p.type in out)) out[p.type] = p;
    if (p.type === 'irot' || p.type === 'imir' || p.type === 'clap') out.transforms.push(p);
  }
  return out;
}

export const refsFrom = (heif, type, from) => heif.refs.find((r) => r.type === type && r.from === from)?.to || [];

/** Displayed size of the primary image (after rotation). */
export function primarySize(heif) {
  const { ispe, transforms } = itemProps(heif, heif.primaryId);
  if (!ispe) return null;
  const quarterTurns = transforms.filter((t) => t.type === 'irot').reduce((n, t) => n + t.angle / 90, 0);
  return quarterTurns % 2 ? { width: ispe.height, height: ispe.width } : { width: ispe.width, height: ispe.height };
}

/** The EXIF block of the primary image as a TIFF stream (starts with "MM" or "II"), or null. */
export function exifTiff(heif) {
  const exifItems = [...heif.items.values()].filter((i) => i.type === 'Exif');
  const item = exifItems.find((i) => refsFrom(heif, 'cdsc', i.id).includes(heif.primaryId)) || exifItems[0];
  if (!item) return null;
  const data = itemData(heif, item.id);
  const skip = new DataView(data.buffer, data.byteOffset).getUint32(0);
  return data.subarray(4 + skip);
}

/** Color space for decoded RGB of the primary image: 'display-p3' or 'srgb'. */
export function primaryColorSpace(heif) {
  const { colr } = itemProps(heif, heif.primaryId);
  if (colr?.kind === 'nclx') return colr.primaries === 12 ? 'display-p3' : 'srgb';
  if (colr?.icc) {
    // The profile description is often UTF-16 ("mluc"), so compare with NUL bytes dropped.
    const text = String.fromCharCode(...colr.icc.subarray(0, Math.min(colr.icc.length, 4096)).filter((b) => b !== 0));
    return /P3/.test(text) ? 'display-p3' : 'srgb';
  }
  return 'srgb';
}

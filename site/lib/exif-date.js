// Writes the capture time into a photo's own EXIF (JPEG and HEIC), shared by the browser and Node.
// Nothing already in the file moves: the changed EXIF directory is appended as a new copy and the
// one pointer to it is updated, so every other offset in the file (maker notes, thumbnails, the
// image data) stays valid. In a HEIC, the grown EXIF item goes into a new box at the end of the file.
import { parseHeif, exifItem, itemData } from './heif.js';

const DATE_TIME_ORIGINAL = 0x9003;
const DATE_TIME_DIGITIZED = 0x9004;
const OFFSET_TIME_ORIGINAL = 0x9011;
const OFFSET_TIME_DIGITIZED = 0x9012;
const SUBSEC_ORIGINAL = 0x9291;
const SUBSEC_DIGITIZED = 0x9292;
const EXIF_VERSION = 0x9000;
const EXIF_IFD = 0x8769;
const ASCII = 2, LONG = 4, UNDEFINED = 7;

const te = new TextEncoder();
const ascii = (s) => ({ type: ASCII, data: te.encode(`${s}\0`) });

/**
 * The file's bytes with its capture time set. `when`: "2026:10:04 14:23:24" (the photo's local
 * time); `offset`: its time zone, "-05:00", or null to leave the time zone out.
 */
export function setDateTaken(bytes, fmt, { when, offset }) {
  if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(when)) throw new Error(`bad date ${when}`);
  if (offset != null && !/^[+-]\d{2}:\d{2}$/.test(offset)) throw new Error(`bad time zone ${offset}`);
  const tz = offset ? ascii(offset) : null;
  const changes = new Map([
    [DATE_TIME_ORIGINAL, ascii(when)],
    [DATE_TIME_DIGITIZED, ascii(when)],
    [OFFSET_TIME_ORIGINAL, tz],
    [OFFSET_TIME_DIGITIZED, tz],
    // Fractions of a second belonged to the old time.
    [SUBSEC_ORIGINAL, null],
    [SUBSEC_DIGITIZED, null],
  ]);
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (fmt === 'jpg' || fmt === 'jpeg') return jpegWith(u8, changes);
  if (fmt === 'heic' || fmt === 'heif') return heifWith(u8, changes);
  throw new Error(`Can't write the date into ${fmt.toUpperCase()} files.`);
}

// ---------- TIFF (the EXIF block itself) ----------

function readIfd(dv, le, at) {
  if (at < 8 || at + 2 > dv.byteLength) throw new Error('bad EXIF directory');
  const n = dv.getUint16(at, le);
  if (at + 2 + n * 12 + 4 > dv.byteLength) throw new Error('bad EXIF directory');
  const entries = [];
  for (let i = 0; i < n; i++) {
    const p = at + 2 + i * 12;
    entries.push({
      at: p,
      tag: dv.getUint16(p, le),
      type: dv.getUint16(p + 2, le),
      count: dv.getUint32(p + 4, le),
      raw: new Uint8Array(dv.buffer, dv.byteOffset + p + 8, 4).slice(),
    });
  }
  return { entries, next: dv.getUint32(at + 2 + n * 12, le) };
}

/** `tiff` with the Exif sub-directory's tags changed ({ type, data } sets one, null removes it). */
export function setExifTags(tiff, changes) {
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0], tiff[1]);
  const le = order === 'II';
  if ((order !== 'II' && order !== 'MM') || dv.getUint16(2, le) !== 42) throw new Error('bad EXIF header');
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, le); return b; };

  const ifd0At = dv.getUint32(4, le);
  const ifd0 = readIfd(dv, le, ifd0At);
  const ptr = ifd0.entries.find((e) => e.tag === EXIF_IFD);
  const exif = ptr ? readIfd(dv, le, new DataView(ptr.raw.buffer).getUint32(0, le)) : { entries: [], next: 0 };

  const byTag = new Map(exif.entries.map((e) => [e.tag, e]));
  if (!ptr) byTag.set(EXIF_VERSION, { type: UNDEFINED, data: te.encode('0232') });
  for (const [tag, e] of changes) {
    if (e) byTag.set(tag, { tag, count: e.data.length, ...e });
    else byTag.delete(tag);
  }

  // Appended after the original bytes; each directory and value starts on an even offset.
  const chunks = [];
  let length = tiff.length;
  const append = (bytes) => { chunks.push(bytes); length += bytes.length; };
  const writeIfd = (entries, next) => {
    if (length % 2) append(new Uint8Array(1));
    entries.sort((a, b) => a.tag - b.tag);
    const at = length;
    const size = 2 + entries.length * 12 + 4;
    const values = [];
    let valuesAt = at + size;
    const block = new Uint8Array(size);
    const bv = new DataView(block.buffer);
    bv.setUint16(0, entries.length, le);
    entries.forEach((e, i) => {
      const p = 2 + i * 12;
      bv.setUint16(p, e.tag, le);
      bv.setUint16(p + 2, e.type, le);
      bv.setUint32(p + 4, e.count, le);
      if (!e.data) block.set(e.raw, p + 8); // unchanged: its value (or the offset to it) stays valid
      else if (e.data.length <= 4) block.set(e.data, p + 8);
      else {
        block.set(u32(valuesAt), p + 8);
        values.push(e.data);
        valuesAt += e.data.length + (e.data.length % 2);
        if (e.data.length % 2) values.push(new Uint8Array(1));
      }
    });
    bv.setUint32(size - 4, next, le);
    append(block);
    values.forEach(append);
    return at;
  };

  const newExifAt = writeIfd([...byTag.values()], exif.next);
  let patch;
  if (ptr) {
    patch = [ptr.at + 8, newExifAt]; // the pointer in IFD0, in place
  } else {
    // IFD0 needs one more entry: append a copy of it with the pointer added.
    const newIfd0At = writeIfd([...ifd0.entries, { tag: EXIF_IFD, type: LONG, count: 1, data: u32(newExifAt) }], ifd0.next);
    patch = [4, newIfd0At]; // the header's pointer to IFD0
  }
  if (length > 0xffffffff) throw new Error('EXIF block too large');

  const out = new Uint8Array(length);
  out.set(tiff);
  let at = tiff.length;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  new DataView(out.buffer).setUint32(patch[0], patch[1], le);
  return out;
}

// An EXIF block with nothing in it, for files that have none.
const emptyTiff = () => Uint8Array.of(0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0);

// ---------- JPEG ----------

const EXIF_ID = te.encode('Exif\0\0');

function jpegSegments(u8) {
  if (u8[0] !== 0xff || u8[1] !== 0xd8) throw new Error('not a JPEG file');
  const segments = [];
  let at = 2;
  while (at + 4 <= u8.length) {
    if (u8[at] !== 0xff) throw new Error('bad JPEG file');
    const marker = u8[at + 1];
    if (marker === 0xff) { at++; continue; } // fill byte
    if (marker === 0xda || marker === 0xd9) break; // image data starts
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
    const end = at + 2 + ((u8[at + 2] << 8) | u8[at + 3]);
    segments.push({ marker, start: at, body: at + 4, end });
    at = end;
  }
  return segments;
}

function jpegWith(u8, changes) {
  const segments = jpegSegments(u8);
  const isExif = (s) => s.marker === 0xe1 && EXIF_ID.every((b, i) => u8[s.body + i] === b);
  const seg = segments.find(isExif);
  // Without an EXIF segment, add one right after the start (after JFIF's APP0, which must be first).
  const at = seg ? seg.start : segments[0]?.marker === 0xe0 ? segments[0].end : 2;
  const tiff = setExifTags(seg ? u8.subarray(seg.body + EXIF_ID.length, seg.end) : emptyTiff(), changes);
  const segLength = 2 + EXIF_ID.length + tiff.length;
  if (segLength > 0xffff) throw new Error('EXIF block too large for a JPEG');
  const rest = u8.subarray(seg ? seg.end : at);
  const out = new Uint8Array(at + 2 + segLength + rest.length);
  out.set(u8.subarray(0, at));
  out.set([0xff, 0xe1, segLength >> 8, segLength & 0xff], at);
  out.set(EXIF_ID, at + 4);
  out.set(tiff, at + 4 + EXIF_ID.length);
  out.set(rest, at + 2 + segLength);
  return out;
}

// ---------- HEIC ----------

function heifWith(u8, changes) {
  const heif = parseHeif(u8);
  const item = exifItem(heif);
  if (!item) throw new Error('This HEIC file has no EXIF block to write the date into.');
  if (item.method !== 0 || item.extents.length !== 1) throw new Error('Unsupported HEIC layout.');
  // The item: a 4-byte offset to the TIFF header (and whatever it skips), then the TIFF block.
  const data = itemData(heif, item.id);
  const skip = 4 + new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  const tiff = setExifTags(data.subarray(skip), changes);

  // A last box whose size is 0 runs to the end of the file: give it its real size first.
  let end = u8.length;
  const dvIn = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let open = null;
  for (let at = 0; at + 8 <= u8.length;) {
    let size = dvIn.getUint32(at);
    if (size === 1) size = Number(dvIn.getBigUint64(at + 8));
    else if (size === 0) { open = at; break; }
    if (size < 8) throw new Error('bad HEIC file');
    at += size;
    end = Math.min(at, u8.length);
  }
  if (open != null) end = u8.length;

  const boxAt = end;
  const dataAt = boxAt + 8;
  const payload = skip + tiff.length;
  if (dataAt + payload > 0xffffffff) throw new Error('HEIC file too large');
  const out = new Uint8Array(dataAt + payload);
  out.set(u8.subarray(0, end));
  const dv = new DataView(out.buffer);
  if (open != null) {
    if (end - open > 0xffffffff) throw new Error('HEIC file too large');
    dv.setUint32(open, end - open);
  }
  dv.setUint32(boxAt, 8 + payload);
  out.set(te.encode('mdat'), boxAt + 4);
  out.set(data.subarray(0, skip), dataAt);
  out.set(tiff, dataAt + skip);

  // Point the item at its new bytes.
  const { loc } = item;
  const field = loc.fields[0];
  const put = (at, size, v) => {
    if (size === 8) dv.setBigUint64(at, BigInt(v));
    else if (size === 4 && v <= 0xffffffff) dv.setUint32(at, v);
    else if (size === 2 && v <= 0xffff) dv.setUint16(at, v);
    else throw new Error('Unsupported HEIC layout.');
  };
  if (loc.offsetSize) put(field.offsetAt, loc.offsetSize, dataAt - loc.base);
  else if (loc.baseSize) put(loc.baseAt, loc.baseSize, dataAt);
  else throw new Error('Unsupported HEIC layout.');
  // A length field of size 0 means "to the end of the file", which is where the item now ends.
  if (loc.lengthSize) put(field.lengthAt, loc.lengthSize, payload);
  return out;
}

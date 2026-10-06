// Builds the gallery in _site/ from the originals in photos/.
// Each photo gets exactly ONE generated image: a 720px WebP preview, used everywhere except the
// viewer. The viewer always shows the original file, loaded from raw.githubusercontent.com.
import { readdir, mkdir, mkdtemp, copyFile, writeFile, readFile, access, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import exifr from 'exifr';
import * as esbuild from 'esbuild';
import { rgbaToThumbHash } from 'thumbhash';
import { parseHeif, itemProps, primarySize, exifTiff } from '../site/lib/heif.js';
import { placeFor } from './places.mjs';

const SRC = 'photos';
const CACHE = '.cache/v2';
const OUT = '_site';
const PREVIEW = 720; // long side of the one generated image per photo
const REPO = process.env.GITHUB_REPOSITORY || process.env.PHOTOS_REPO || 'tengdu/photos';
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
// Where the browser loads originals from (overridable for local testing).
const RAW_BASE = process.env.RAW_BASE || `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

const STILL = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']);
const HEIF = new Set(['.heic', '.heif']);
const MOTION = new Set(['.mov', '.mp4']);
const EXIF_PICK = [
  'Make', 'Model', 'LensModel', 'FNumber', 'ExposureTime', 'ISO', 'FocalLength', 'FocalLengthIn35mmFormat',
  'DateTimeOriginal', 'OffsetTimeOriginal', 'CreateDate', 'OffsetTime',
  'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef',
];

const exists = (p) => access(p).then(() => true, () => false);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
const sha1 = (data) => createHash('sha1').update(data).digest('hex');
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

// HEIC can't be decoded by the prebuilt sharp: use libheif (CI) or sips (macOS).
function heicToJpeg(src, dest) {
  for (const [cmd, args] of [
    ['heif-dec', ['--quality', '92', src, dest]],
    ['heif-convert', ['-q', '92', src, dest]],
    ['sips', ['-s', 'format', 'jpeg', src, '--out', dest]],
  ]) {
    try { run(cmd, args); return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error('no HEIC decoder found (install libheif-examples)');
}

async function readExif(input) {
  try {
    return (await exifr.parse(input, {
      reviveValues: false, translateValues: false, gps: true,
      xmp: false, icc: false, iptc: false, jfif: false, ihdr: false, pick: EXIF_PICK,
    })) || {};
  } catch {
    return {};
  }
}

// "2026:10:04 14:23:24" + "-05:00" → "2026-10-04T14:23:24-05:00" (the photo's own local time).
function takenAt(exif, file) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(exif.DateTimeOriginal || exif.CreateDate || '');
  if (m && m[1] !== '0000') {
    const off = exif.OffsetTimeOriginal || exif.OffsetTime;
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${/^[+-]\d{2}:\d{2}$/.test(off || '') ? off : ''}`;
  }
  // No EXIF date: use the upload time in the file name (YYYYMMDD-HHmmss-...).
  const s = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(path.basename(file));
  return s ? `${s[1]}-${s[2]}-${s[3]}T${s[4]}:${s[5]}:${s[6]}` : null;
}

const instant = (taken) => (taken ? Date.parse(/[+-]\d{2}:\d{2}$/.test(taken) ? taken : `${taken}Z`) : -Infinity);

function camera(exif) {
  const clean = (s) => (typeof s === 'string' ? s.replace(/\0/g, '').trim() : undefined) || undefined;
  const num = (v) => (Array.isArray(v) ? v[0] : v);
  const make = clean(exif.Make);
  const model = clean(exif.Model);
  let lens = clean(exif.LensModel);
  if (lens && model && lens.startsWith(model)) lens = lens.slice(model.length).trim(); // "iPhone 18 Pro back triple camera…"
  const cam = {
    make, model, lens,
    f: exif.FNumber ? round(exif.FNumber, 2) : undefined,
    exp: num(exif.ExposureTime) || undefined,
    iso: num(exif.ISO) || undefined,
    fl: exif.FocalLength ? round(exif.FocalLength, 1) : undefined,
    fl35: num(exif.FocalLengthIn35mmFormat) || undefined,
  };
  Object.keys(cam).forEach((k) => cam[k] === undefined && delete cam[k]);
  return Object.keys(cam).length ? cam : null;
}

// ---------- Privacy zones (GitHub Secret PRIVACY_ZONES = "lat,lon,radius_m; …") ----------
function privacyZones() {
  const zones = (process.env.PRIVACY_ZONES || '')
    .split(/[;\n]/)
    .map((s) => s.trim().split(/\s*,\s*/).map(Number))
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))
    .map(([lat, lon, r]) => ({ lat, lon, r: r > 0 ? r : 1000 }));
  // Never log the coordinates themselves.
  console.log(zones.length ? `privacy zones: ${zones.length}` : 'privacy zones: none (set the PRIVACY_ZONES secret to hide places near home)');
  return zones;
}

function metersBetween([lat1, lon1], [lat2, lon2]) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

// ---------- Collect originals ----------
async function collect(hashes) {
  const files = (await readdir(SRC, { recursive: true, withFileTypes: true }))
    .filter((d) => d.isFile())
    .map((d) => path.relative('.', path.join(d.parentPath, d.name)).split(path.sep).join('/'))
    .sort();
  // A still and a .mov with the same name are a Live Photo.
  const byStem = new Map();
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    const kind = STILL.has(ext) ? 'still' : MOTION.has(ext) ? 'motion' : null;
    if (!kind) continue;
    const stem = rel.slice(0, -ext.length).toLowerCase();
    const e = byStem.get(stem) || {};
    e[kind] = rel;
    if (kind === 'still') e.ext = ext;
    byStem.set(stem, e);
  }
  // Identical files (the same photo uploaded twice) are shown once; prefer the copy with motion.
  const byId = new Map();
  for (const e of byStem.values()) {
    if (!e.still) { console.log(`skip ${e.motion}: videos aren't supported yet`); continue; }
    const { size } = await stat(e.still);
    const key = `${e.still}|${size}`;
    e.id = hashes[key] ??= sha1(await readFile(e.still)).slice(0, 16);
    const prev = byId.get(e.id);
    if (prev) {
      const keep = !prev.motion && e.motion ? e : prev;
      console.log(`duplicate: ${(keep === e ? prev : e).still} is the same file as ${keep.still}`);
      byId.set(e.id, keep);
    } else {
      byId.set(e.id, e);
    }
  }
  return [...byId.values()];
}

// ---------- Per-photo processing (cached by content hash) ----------
async function processItem(item, tmpDir) {
  const metaFile = path.join(CACHE, `${item.id}.json`);
  const webp = path.join(CACHE, `${item.id}.webp`);
  if (await exists(metaFile) && await exists(webp)) return JSON.parse(await readFile(metaFile, 'utf8'));

  const buf = await readFile(item.still);
  let exif, w, h, input, rotate;
  if (HEIF.has(item.ext)) {
    const heif = parseHeif(buf);
    const tiff = exifTiff(heif);
    exif = tiff ? await readExif(Buffer.from(tiff.buffer, tiff.byteOffset, tiff.byteLength)) : {};
    ({ width: w, height: h } = primarySize(heif));
    input = path.join(tmpDir, `${item.id}.jpg`);
    heicToJpeg(item.still, input);
    // Decoders differ in whether they apply the HEIF rotation; compare with the upright size.
    const m = await sharp(input).metadata();
    const ccw = itemProps(heif, heif.primaryId).transforms.filter((t) => t.type === 'irot').reduce((a, t) => a + t.angle, 0) % 360;
    rotate = m.width === w && m.height === h ? 0 : (360 - ccw) % 360;
  } else {
    exif = await readExif(buf);
    const m = await sharp(buf).metadata();
    [w, h] = (m.orientation || 1) >= 5 ? [m.height, m.width] : [m.width, m.height];
    input = buf;
    rotate = 'exif';
  }

  let img = sharp(input, { failOn: 'none' });
  if (rotate === 'exif') img = img.rotate();
  else if (rotate) img = img.rotate(rotate);
  const out = await img.clone()
    .resize(PREVIEW, PREVIEW, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 70, effort: 5 })
    .toFile(webp);
  if (w !== h && out.width !== out.height && (w > h) !== (out.width > out.height)) {
    console.warn(`warning: preview orientation differs from the original for ${item.still}`);
  }
  const { data, info } = await img.clone()
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lat = exif.latitude, lon = exif.longitude;
  const geo = Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon) ? [round(lat, 5), round(lon, 5)] : null;
  const meta = {
    taken: takenAt(exif, item.still),
    w, h,
    th: Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString('base64'),
    fmt: item.ext === '.jpeg' ? 'jpg' : item.ext.slice(1),
    size: buf.length,
    geo,
    cam: camera(exif),
  };
  await writeFile(metaFile, JSON.stringify(meta));
  return meta;
}

// ---------- Front-end bundle ----------
async function bundle(dataVersion) {
  const assets = path.join(OUT, 'assets');
  await mkdir(assets, { recursive: true });
  const rel = (f) => path.relative(OUT, f).split(path.sep).join('/');
  const common = {
    bundle: true, minify: true, metafile: true, legalComments: 'none', logLevel: 'warning',
    target: ['chrome100', 'safari15', 'firefox100'],
    outdir: assets, entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]', assetNames: '[name]-[hash]',
    external: ['fs', 'path', 'crypto', 'url', 'module', 'worker_threads', 'perf_hooks'], // libheif's Node-only branch
  };

  const wasm = await readFile('node_modules/libheif-js/libheif-wasm/libheif.wasm');
  const wasmName = `libheif-${sha1(wasm).slice(0, 8)}.wasm`;
  await writeFile(path.join(assets, wasmName), wasm);

  const worker = await esbuild.build({
    ...common,
    entryPoints: ['site/heic-worker.js'],
    format: 'iife',
    define: { __LIBHEIF_WASM__: JSON.stringify(wasmName) },
  });
  const workerFile = Object.keys(worker.metafile.outputs).find((f) => f.endsWith('.js'));

  // MapLibre is shipped as-is (its worker imports the same shared module) and loaded on demand.
  const mlDir = 'node_modules/maplibre-gl/dist';
  const mlVersion = JSON.parse(await readFile('node_modules/maplibre-gl/package.json', 'utf8')).version;
  const mlOut = path.join(assets, `maplibre-${mlVersion}`);
  await mkdir(mlOut, { recursive: true });
  for (const f of ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css']) {
    const text = (await readFile(path.join(mlDir, f), 'utf8')).replace(/\n\/[/*][#@] sourceMappingURL=\S+\s*$/, '\n');
    await writeFile(path.join(mlOut, f), text);
  }

  const app = await esbuild.build({
    ...common,
    entryPoints: ['site/main.js'],
    format: 'esm',
    splitting: true,
    define: {
      __HEIC_WORKER__: JSON.stringify(rel(workerFile)),
      __MAPLIBRE__: JSON.stringify(`${rel(mlOut)}/`),
    },
  });
  const [js, out] = Object.entries(app.metafile.outputs).find(([, o]) => o.entryPoint?.endsWith('site/main.js'));

  const html = (await readFile('site/index.html', 'utf8'))
    .replace('__JS__', rel(js))
    .replace('__CSS__', rel(out.cssBundle))
    .replace('__PHOTOS__', `photos.json?v=${dataVersion}`);
  await writeFile(path.join(OUT, 'index.html'), html);
  // GitHub Pages lets browsers cache index.html for 10 minutes; the page checks this file
  // (never cached) to pick up new photos or a new app version right away.
  await writeFile(path.join(OUT, 'version.json'), JSON.stringify({ app: rel(js), data: `photos.json?v=${dataVersion}` }));
  await copyFile('assets/heic-test.heic', path.join(OUT, 'heic-test.heic'));

  // Installable web app: icons, manifest, and a service worker for instant repeat visits.
  const icon = await readFile('site/icon.svg');
  await writeFile(path.join(OUT, 'icon.svg'), icon);
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    await sharp(icon, { density: 300 }).resize(size, size).png().toFile(path.join(OUT, name));
  }
  await writeFile(path.join(OUT, 'manifest.webmanifest'), JSON.stringify({
    name: 'Photos', short_name: 'Photos', start_url: './', scope: './', display: 'standalone',
    background_color: '#000000', theme_color: '#000000',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }));
  const sw = (await readFile('site/sw.js', 'utf8')).replace('__PV__', path.basename(CACHE));
  await writeFile(path.join(OUT, 'sw.js'), `// build ${dataVersion}\n${sw}`);
  const sizes = Object.entries({ ...app.metafile.outputs, ...worker.metafile.outputs })
    .map(([f, o]) => `${rel(f)} ${(o.bytes / 1024).toFixed(0)} KB`);
  console.log(`bundle: ${sizes.join(', ')}, ${wasmName} ${(wasm.length / 1024).toFixed(0)} KB`);
}

// ---------- Main ----------
async function main() {
  await mkdir(CACHE, { recursive: true });
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'm'), { recursive: true });
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gallery-'));
  const hashFile = path.join(CACHE, 'hashes.json');
  const hashes = (await exists(hashFile)) ? JSON.parse(await readFile(hashFile, 'utf8')) : {};
  const zones = privacyZones();

  const items = [];
  let fresh = 0;
  for (const item of await collect(hashes)) {
    try {
      const cached = await exists(path.join(CACHE, `${item.id}.json`));
      const meta = await processItem(item, tmpDir);
      if (!cached) fresh++;
      await copyFile(path.join(CACHE, `${item.id}.webp`), path.join(OUT, 'm', `${item.id}.webp`));
      const hidden = meta.geo && zones.some((z) => metersBetween(meta.geo, [z.lat, z.lon]) <= z.r);
      const place = meta.geo ? placeFor(meta.geo[0], meta.geo[1]) : null; // not cached: cheap, and rules may change
      items.push({
        id: item.id,
        path: item.still,
        taken: meta.taken,
        w: meta.w,
        h: meta.h,
        th: meta.th,
        fmt: meta.fmt,
        size: meta.size,
        ...(item.motion && { live: item.motion }),
        ...(meta.geo && !hidden && { geo: meta.geo }),
        ...(place && { place }),
        ...(meta.cam && { cam: meta.cam }),
      });
    } catch (e) {
      console.warn(`skip ${item.still}: ${e.stderr?.toString().trim() || e.message}`);
    }
  }
  await rm(tmpDir, { recursive: true, force: true });
  await writeFile(hashFile, JSON.stringify(hashes));

  items.sort((a, b) => instant(b.taken) - instant(a.taken) || (a.path < b.path ? 1 : -1));
  const json = JSON.stringify({ raw: RAW_BASE, items });
  await writeFile(path.join(OUT, 'photos.json'), json);
  await bundle(sha1(json).slice(0, 10));

  const live = items.filter((i) => i.live).length;
  const mapped = items.filter((i) => i.geo).length;
  console.log(`built ${items.length} photos (${fresh} new, ${live} live, ${mapped} on the map) → ${OUT}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });

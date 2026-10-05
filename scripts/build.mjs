// Builds the static gallery in _site/ from the originals in photos/.
// Originals are never modified; the page loads them from raw.githubusercontent.com
// when the browser can display them, and falls back to the generated JPEG / MP4 otherwise.
import { readdir, mkdir, mkdtemp, copyFile, writeFile, readFile, access, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const SRC = 'photos';
const CACHE = '.cache/v1';
const OUT = '_site';
const REPO = process.env.GITHUB_REPOSITORY || process.env.PHOTOS_REPO || 'tengdu/photos';
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const TITLE = process.env.SITE_TITLE || 'Photos';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const STILL = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']);
const WEB_SAFE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MOTION = new Set(['.mov', '.mp4']);

const exists = (p) => access(p).then(() => true, () => false);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
const rawUrl = (rel) =>
  `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${rel.split('/').map(encodeURIComponent).join('/')}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// HEIC can't be decoded by the prebuilt sharp: use libheif (CI) or sips (macOS).
function heicToJpeg(src, dest) {
  for (const [cmd, args] of [
    ['heif-dec', [src, dest]],
    ['heif-convert', [src, dest]],
    ['sips', ['-s', 'format', 'jpeg', src, '--out', dest]],
  ]) {
    try { run(cmd, args); return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error('no HEIC decoder found (install libheif-examples)');
}

async function processStill(item, tmpDir) {
  const base = path.join(CACHE, item.id);
  const metaFile = `${base}.json`;
  if (await exists(metaFile)) return JSON.parse(await readFile(metaFile, 'utf8'));

  let input = item.still;
  if (!WEB_SAFE.has(item.ext)) {
    input = path.join(tmpDir, `${item.id}.jpg`);
    heicToJpeg(item.still, input);
  }
  const img = sharp(input, { failOn: 'none' }).rotate();
  const { width, height } = await img.clone().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true }).toFile(`${base}-l.jpg`);
  await img.clone().resize(600, 600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true }).toFile(`${base}-t.jpg`);
  const meta = { w: width, h: height };
  await writeFile(metaFile, JSON.stringify(meta));
  return meta;
}

async function processMotion(item) {
  const out = path.join(CACHE, `${item.id}.mp4`);
  if (await exists(out)) return;
  // Cap the long side at 1080px, keep audio, make it streamable.
  run(FFMPEG, ['-y', '-v', 'error', '-i', item.motion,
    '-vf', "scale='if(gt(iw,ih),min(1080,iw),-2)':'if(gt(iw,ih),-2,min(1080,ih))'",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out]);
}

async function collect() {
  const files = (await readdir(SRC, { recursive: true, withFileTypes: true }))
    .filter((d) => d.isFile())
    .map((d) => path.relative('.', path.join(d.parentPath, d.name)).split(path.sep).join('/'));
  const byStem = new Map();
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    const kind = STILL.has(ext) ? 'still' : MOTION.has(ext) ? 'motion' : null;
    if (!kind) continue;
    const stem = rel.slice(0, -ext.length).toLowerCase();
    const entry = byStem.get(stem) || {};
    entry[kind] = rel;
    if (kind === 'still') entry.ext = ext;
    byStem.set(stem, entry);
  }
  const items = [];
  for (const [stem, e] of byStem) {
    if (!e.still) { console.warn(`skip ${e.motion}: video without a still photo`); continue; }
    e.id = createHash('sha1').update(e.still).digest('hex').slice(0, 16);
    e.stem = stem;
    items.push(e);
  }
  // Uploads are named photos/YYYY/MM/YYYYMMDD-HHmmss-*, so path order is upload order.
  return items.sort((a, b) => (a.still < b.still ? 1 : -1));
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'm'), { recursive: true });
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gallery-'));

  const photos = [];
  for (const item of await collect()) {
    try {
      const meta = await processStill(item, tmpDir);
      let motion = false;
      if (item.motion) {
        try { await processMotion(item); motion = true; }
        catch (e) { console.warn(`motion failed for ${item.motion}: ${e.stderr || e.message}`); }
      }
      const copy = [`${item.id}-t.jpg`, `${item.id}-l.jpg`, ...(motion ? [`${item.id}.mp4`] : [])];
      for (const f of copy) await copyFile(path.join(CACHE, f), path.join(OUT, 'm', f));
      const m = item.still.match(/^photos\/(\d{4})\/(\d{2})\//);
      photos.push({
        name: path.basename(item.still),
        group: m ? `${m[1]}-${m[2]}` : 'Other',
        w: meta.w, h: meta.h,
        thumb: `m/${item.id}-t.jpg`,
        large: `m/${item.id}-l.jpg`,
        orig: rawUrl(item.still),
        heic: !WEB_SAFE.has(item.ext),
        ...(motion && { mp4: `m/${item.id}.mp4`, mov: item.motion.toLowerCase().endsWith('.mov') ? rawUrl(item.motion) : null }),
      });
      console.log(`ok  ${item.still}${motion ? ' (live)' : ''}`);
    } catch (e) {
      console.warn(`skip ${item.still}: ${e.stderr || e.message}`);
    }
  }
  await rm(tmpDir, { recursive: true, force: true });
  await copyFile('assets/heic-test.heic', path.join(OUT, 'heic-test.heic'));
  const template = await readFile('scripts/template.html', 'utf8');
  await writeFile(path.join(OUT, 'index.html'), render(template, photos));
  console.log(`built ${photos.length} photos → ${OUT}/`);
}

function render(template, photos) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const label = (g) => (g === 'Other' ? 'Other' : `${months[+g.slice(5) - 1]} ${g.slice(0, 4)}`);
  let html = '';
  let group = null;
  photos.forEach((p, i) => {
    if (p.group !== group) {
      if (group !== null) html += '</div></section>';
      group = p.group;
      html += `<section><h2>${esc(label(group))}</h2><div class="grid">`;
    }
    html += `<a class="tile" href="${esc(p.large)}" data-i="${i}">`
      + `<img src="${esc(p.thumb)}" alt="${esc(p.name)}" width="${p.w}" height="${p.h}" loading="lazy" decoding="async">`
      + (p.mp4 ? '<span class="badge">LIVE</span>' : '') + '</a>';
  });
  if (group !== null) html += '</div></section>';
  if (!photos.length) html = '<p class="empty">No photos yet.</p>';
  // Function replacers so "$" in file names is never treated as a replacement pattern.
  return template
    .replaceAll('{{TITLE}}', () => esc(TITLE))
    .replace('{{COUNT}}', () => `${photos.length} photo${photos.length === 1 ? '' : 's'}`)
    .replace('{{GRID}}', () => html)
    .replace('{{DATA}}', () => JSON.stringify(photos).replace(/</g, '\\u003c'));
}

main().catch((e) => { console.error(e); process.exit(1); });

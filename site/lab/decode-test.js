// Diagnostics page (not linked from the site): how long does this browser take to show an
// original HEIC, depending on how it is decoded? Open /lab/decode-test.html on the device.
import { parseHeif, itemData, itemProps, refsFrom, primaryColorSpace } from '../lib/heif.js';
import { hevcCodecString } from '../lib/heic-webcodecs.js';

const out = document.getElementById('out');
const row = (label, value) => {
  const li = document.createElement('li');
  li.innerHTML = `<b>${label}</b> ${value}`;
  out.append(li);
  return li;
};
const sec = (ms) => `${(ms / 1000).toFixed(2)} s`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const data = await fetch('../photos.json', { cache: 'no-store' }).then((r) => r.json());
const heics = data.items.filter((i) => i.fmt === 'heic').sort((a, b) => b.w * b.h - a.w * a.h);
const p = heics[0];
if (!p) {
  row('No HEIC photo', 'upload one first');
  throw new Error('no heic');
}
const base = data.raw + p.path.split('/').map(encodeURIComponent).join('/');
const fresh = (tag) => `${base}?t=${tag}-${Date.now()}`; // new URL each time: no cached decode

row('Photo', `${p.path.split('/').pop()} · ${p.w}×${p.h} · ${(p.size / 1e6).toFixed(1)} MB`);
row('Device', navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''));
row('Screen', `${screen.width}×${screen.height} @${devicePixelRatio}x · HDR display: ${matchMedia('(dynamic-range: high)').matches}`);
row('CSS dynamic-range-limit', CSS.supports('dynamic-range-limit', 'standard') ? 'supported' : 'not supported');

const stage = document.getElementById('stage');

// Tests 1–3: the browser's own decoder, set up in different ways.
async function imgTest(label, { attach, sdr, decode = true }) {
  const li = row(label, 'running…');
  const img = new Image();
  img.decoding = 'async';
  img.fetchPriority = 'high';
  if (sdr) img.style.dynamicRangeLimit = 'standard';
  img.style.width = '160px';
  if (attach) stage.append(img);
  const t0 = performance.now();
  let loaded;
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('load failed'));
      img.src = fresh(label.slice(0, 2));
    });
    loaded = performance.now();
    if (decode) await img.decode();
    else await frame();
    const done = performance.now();
    li.innerHTML = `<b>${label}</b> download ${sec(loaded - t0)}, decode ${sec(done - loaded)} → <b>${sec(done - t0)}</b>`;
  } catch (e) {
    li.innerHTML = `<b>${label}</b> failed: ${e.message}`;
  }
  await wait(300);
  img.remove();
}

// Test 4: hardware HEVC via WebCodecs, drawn into canvases no bigger than iOS allows.
async function webCodecsTest() {
  const li = row('5. WebCodecs (hardware HEVC)', 'running…');
  if (typeof VideoDecoder === 'undefined') {
    li.innerHTML = '<b>5. WebCodecs</b> not available in this browser';
    return;
  }
  try {
    const t0 = performance.now();
    const bytes = new Uint8Array(await (await fetch(fresh('wc'))).arrayBuffer());
    const downloaded = performance.now();
    const heif = parseHeif(bytes);
    const tiles = refsFrom(heif, 'dimg', heif.primaryId);
    const first = itemProps(heif, tiles[0]);
    // The tiles are "Main Still Picture" (profile 3), a subset of Main: if the exact profile is
    // rejected, try the same stream described as Main.
    const own = hevcCodecString(first.hvcC.record);
    const level = own.split('.')[3];
    const candidates = [own, `hvc1.1.6.${level}.B0`, 'hvc1.1.6.L120.B0', `hev1.1.6.${level}.B0`];
    let config = null;
    const tried = [];
    for (const codec of candidates) {
      const c = { codec, description: first.hvcC.record, codedWidth: first.ispe.width, codedHeight: first.ispe.height };
      const ok = (await VideoDecoder.isConfigSupported(c).catch(() => ({ supported: false }))).supported;
      tried.push(`${codec} ${ok ? '✓' : '✗'}`);
      if (ok) { config = c; break; }
    }
    if (!config) {
      li.innerHTML = `<b>5. WebCodecs</b> HEVC not supported (${tried.join(', ')})`;
      return;
    }
    const grid = itemData(heif, heif.primaryId);
    const cols = grid[3] + 1;
    const dv = new DataView(grid.buffer, grid.byteOffset, grid.byteLength);
    const W = grid[1] & 1 ? dv.getUint32(4) : dv.getUint16(4);
    const H = grid[1] & 1 ? dv.getUint32(8) : dv.getUint16(6);
    // Full resolution, split into horizontal bands that each stay under 16.7 MP.
    const bandH = Math.floor(16_000_000 / W);
    const colorSpace = primaryColorSpace(heif);
    const bands = [];
    for (let y = 0; y < H; y += bandH) {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = Math.min(bandH, H - y);
      bands.push({ y, ctx: c.getContext('2d', { colorSpace }) });
    }
    let drawn = 0;
    const tw = first.ispe.width, th = first.ispe.height;
    const decoder = new VideoDecoder({
      output: (f) => {
        const i = f.timestamp;
        const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
        for (const b of bands) if (y < b.y + b.ctx.canvas.height && y + th > b.y) b.ctx.drawImage(f, x, y - b.y);
        f.close();
        drawn++;
      },
      error: (e) => { throw e; },
    });
    decoder.configure(config);
    tiles.forEach((id, i) => decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, data: itemData(heif, id) })));
    await decoder.flush();
    decoder.close();
    const px = bands[0].ctx.getImageData(Math.floor(W / 2), 10, 1, 1).data;
    const done = performance.now();
    li.innerHTML = `<b>5. WebCodecs</b> [${tried.join(', ')}] download ${sec(downloaded - t0)}, decode ${drawn}/${tiles.length} tiles into ${bands.length} canvases ${sec(done - downloaded)} → <b>${sec(done - t0)}</b> (pixel ${px[0]},${px[1]},${px[2]})`;
  } catch (e) {
    li.innerHTML = `<b>5. WebCodecs</b> failed: ${e.message}`;
  }
}

// Test 6: draw the loaded original into a screen-sized canvas. drawImage() can't return before
// the image is decoded, so this measures what showing it at screen size really costs.
async function drawAtScreenSize() {
  const li = row('6. Draw at screen size (what showing it costs)', 'running…');
  const img = new Image();
  img.decoding = 'async';
  img.style.width = '160px';
  stage.append(img);
  try {
    const t0 = performance.now();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('load failed')); img.src = fresh('draw'); });
    const loaded = performance.now();
    const w = Math.round(screen.width * devicePixelRatio);
    const h = Math.round((w * img.naturalHeight) / img.naturalWidth);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const px = c.getContext('2d').getImageData(w >> 1, h >> 1, 1, 1).data;
    const drawn = performance.now();
    li.innerHTML = `<b>6. Draw at screen size</b> (${w}×${h}) download ${sec(loaded - t0)}, draw ${sec(drawn - loaded)} → <b>${sec(drawn - t0)}</b> (pixel ${px[0]},${px[1]},${px[2]})`;
  } catch (e) {
    li.innerHTML = `<b>6. Draw at screen size</b> failed: ${e.message}`;
  }
  img.remove();
}

const go = document.getElementById('go');
go.onclick = async () => {
  go.disabled = true;
  await imgTest('1. Detached image + decode() (how the site did it before)', { attach: false });
  await imgTest('2. Image in the page + decode()', { attach: true });
  await imgTest('3. Image in the page, HDR off (dynamic-range-limit: standard)', { attach: true, sdr: true });
  await imgTest('4. Image in the page, no decode() (shown when ready)', { attach: true, decode: false });
  await webCodecsTest();
  await drawAtScreenSize();
  row('Done', 'please send a screenshot of this page');
  go.disabled = false;
};

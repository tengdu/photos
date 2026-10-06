// Loads ORIGINAL files for the viewer. Nothing here ever substitutes the generated preview:
// either the original is displayed (natively, or decoded from the original bytes), or loading fails.

/* global __HEIC_WORKER__ */

const HEIF = new Set(['heic', 'heif']);
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
const LIMIT = (navigator.deviceMemory || 4) >= 8 ? 6 : 3;

export const progress = new EventTarget();
const cache = new Map(); // id -> { promise, result } in least-recently-used order
let highPriority = 0;
let idleWaiters = [];

let heicSupport;
/** Can this browser render HEIC by itself (Safari)? */
export function nativeHeic() {
  heicSupport ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = 'heic-test.heic';
  });
  return heicSupport;
}

export const needsDecode = async (p) => HEIF.has(p.fmt) && !(await nativeHeic());

/** Already-loaded original, if any (synchronous). */
export const peek = (id) => cache.get(id)?.result || null;

export function loadOriginal(p, { priority = 'high' } = {}) {
  let entry = cache.get(p.id);
  if (entry) {
    cache.delete(p.id);
    cache.set(p.id, entry);
    return entry.promise;
  }
  entry = { result: null };
  entry.promise = load(p, priority).then((result) => (entry.result = result));
  entry.promise.catch(() => cache.get(p.id) === entry && cache.delete(p.id));
  cache.set(p.id, entry);
  trim();
  return entry.promise;
}

function trim() {
  for (const [id, entry] of cache) {
    if (cache.size <= LIMIT) break;
    if (!entry.result) continue; // still loading
    cache.delete(id);
    if (entry.result.url) URL.revokeObjectURL(entry.result.url);
    entry.result.bitmap?.close();
  }
}

async function load(p, priority) {
  if (priority === 'high') highPriority++;
  else await new Promise((resolve) => (highPriority ? idleWaiters.push(resolve) : resolve()));
  try {
    const blob = await download(p, priority);
    if (await needsDecode(p)) return { ...(await decodeHeic(await blob.arrayBuffer())), bytes: blob.size };
    return { url: URL.createObjectURL(new Blob([blob], { type: MIME[p.fmt] || '' })), bytes: blob.size };
  } finally {
    if (priority === 'high' && --highPriority === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((fn) => fn());
    }
  }
}

async function download(p, priority) {
  const res = await fetch(p.src, { priority });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${p.name}`);
  const total = Number(res.headers.get('content-length')) || p.size || 0;
  if (!res.body) return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    progress.dispatchEvent(new CustomEvent('progress', { detail: { id: p.id, loaded, total } }));
  }
  return new Blob(chunks);
}

// One worker decodes HEIC files with libheif (WASM), one file at a time.
let worker;
let nextId = 0;
const pending = new Map();
function decodeHeic(buffer) {
  if (!worker) {
    worker = new Worker(new URL(__HEIC_WORKER__, document.baseURI));
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else {
        console.debug(`[photos] HEIC decoded ${data.width}×${data.height} ${JSON.stringify(data.timing)}`);
        job.resolve({ bitmap: data.bitmap, width: data.width, height: data.height, colorSpace: data.colorSpace });
      }
    };
    worker.onerror = (e) => {
      for (const job of pending.values()) job.reject(new Error(e.message || 'HEIC decoder failed to start'));
      pending.clear();
      worker = null;
    };
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, buffer }, [buffer]);
  });
}

// Owner-only: upload photos and videos from this device (picked files, a picked folder, or files
// and folders dropped onto the page). select.js puts them into photos/ in one commit, untouched and
// named like the iPhone shortcut names them ("<upload time>-<file name>"), so the build treats them
// the same way: a still and a .mov with the same name in the same folder become a Live Photo.
//
// Big videos can't be uploaded from a browser: they belong in the "media" release, and GitHub's
// release upload endpoint doesn't allow cross-origin requests. Through the Git API a file goes
// base64-encoded in a JSON body, so files are kept below MAX_BYTES.

const STILL = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']); // as in build.mjs
const VIDEO = new Set(['.mov', '.mp4', '.m4v']);
export const MAX_BYTES = 40 * 1024 * 1024;
export const MAX_LABEL = '40 MB';
export const ACCEPT = 'image/*,video/*,.heic,.heif,.mov,.mp4,.m4v';

const extOf = (name) => (/\.[^.]+$/.exec(name)?.[0] || '').toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** { file, path } for each picked file (`path`: relative to the picked folder, if any). */
export const pickedFiles = (input) => [...input.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));

/**
 * { file, path } for each dropped file; dropped folders are read with all their subfolders.
 * Must be called synchronously from the drop handler (the entries are gone after it returns).
 */
export function droppedFiles(dataTransfer) {
  const entries = [...(dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const plain = [...dataTransfer.files].map((file) => ({ file, path: file.name }));
  if (!entries.length) return Promise.resolve(plain);
  const out = [];
  async function walk(entry, dir) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: dir + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${dir}${entry.name}/`);
      }
    }
  }
  return (async () => {
    for (const e of entries) await walk(e, '');
    return out;
  })();
}

// The id the build gives a photo: the first 16 hex digits of its file's SHA-1.
async function fileId(file) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', await file.arrayBuffer()));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What uploading `files` would add. `existing`: Map id → photo of the library.
 * Returns {
 *   items: [{ name, video, stem, files: [{ file, path }] }]  // path: where it goes in the repo
 *   dupes: [photo]        // already in the library (the library's copy)
 *   unsupported: [name]   // not a photo or video the site shows (e.g. .dng, .aae)
 *   tooBig: [name]        // over MAX_BYTES
 * }
 */
export async function planUpload(files, existing, progress = () => {}, now = new Date()) {
  const unsupported = [];
  const tooBig = [];
  // A still and a video with the same name in the same folder are a Live Photo.
  const groups = new Map();
  for (const f of files) {
    const name = f.path.split('/').pop();
    if (name.startsWith('.')) continue; // .DS_Store, macOS "._" files
    const ext = extOf(name);
    const kind = STILL.has(ext) ? 'still' : VIDEO.has(ext) ? 'motion' : null;
    if (!kind || !f.file.size) { unsupported.push(name); continue; }
    if (f.file.size > MAX_BYTES) { tooBig.push(name); continue; }
    let key = f.path.slice(0, -ext.length).toLowerCase();
    if (groups.get(key)?.[kind]) key += `\0${ext}`; // e.g. IMG_1.jpg next to IMG_1.heic
    groups.set(key, { ...groups.get(key), [kind]: { ...f, name, ext } });
  }

  const stamp = stampOf(now);
  const items = [];
  const dupes = [];
  const seen = new Set();
  const stems = new Set();
  let done = 0;
  for (const g of groups.values()) {
    progress(++done, groups.size);
    const main = g.still || g.motion;
    const id = await fileId(main.file);
    if (seen.has(id)) continue; // the same file twice in this upload
    seen.add(id);
    if (existing.has(id)) { dupes.push(existing.get(id)); continue; }
    const base = main.name.slice(0, -main.ext.length).normalize('NFC').replace(/[\u0000-\u001f\\]/g, '').trim() || 'photo';
    let stem = `${stamp}-${base}`;
    for (let n = 2; stems.has(stem.toLowerCase()); n++) stem = `${stamp}-${base}-${n}`;
    stems.add(stem.toLowerCase());
    items.push({
      name: main.name,
      video: !g.still,
      stem,
      files: [g.still, g.motion].filter(Boolean).map((f) => ({ file: f.file, path: `photos/${stem}${f.ext}` })),
    });
  }
  return { items, dupes, unsupported, tooBig };
}

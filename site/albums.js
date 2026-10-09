// Albums: albums/<album name>/<photo file name without extension>, one empty file per photo (see
// scripts/build.mjs). The owner changes them from the site (select.js); until the site has been
// rebuilt, this device remembers the changes so they show at once.
const EDITS_KEY = 'photos.albumEdits';
const KEEP_MS = 10 * 60 * 1000;

function recentEdits() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(EDITS_KEY) || '[]'); } catch {}
  const now = Date.now();
  return Array.isArray(list) ? list.filter((e) => now - e.t < KEEP_MS) : [];
}

export function rememberAlbumEdit(op, name, ids) {
  const list = [...recentEdits(), { op, name, ids: [...ids], t: Date.now() }];
  try { localStorage.setItem(EDITS_KEY, JSON.stringify(list)); } catch {}
}

/** [{ name, items }] from photos.json plus this device's recent changes; newest album first. */
export function buildAlbums(raw, byId) {
  const albums = new Map((raw || []).map((a) => [a.name, new Set(a.ids)]));
  for (const e of recentEdits()) {
    const ids = albums.get(e.name) || new Set();
    for (const id of e.ids) {
      if (e.op === 'add') ids.add(id);
      else ids.delete(id);
    }
    albums.set(e.name, ids);
  }
  return [...albums]
    .map(([name, ids]) => ({ name, items: [...ids].map((id) => byId.get(id)).filter(Boolean).sort((a, b) => a.index - b.index) }))
    .filter((a) => a.items.length)
    .sort((a, b) => a.items[0].index - b.items[0].index || a.name.localeCompare(b.name));
}

/** A typed album name, made safe for a folder name. */
export const cleanAlbumName = (s) => String(s || '').normalize('NFC').replace(/[/\\]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim();

/** Repo path of a photo's file in an album. */
export const entryPath = (name, p) => `albums/${name}/${p.stem}`;

export const albumHash = (name) => `#/album/${encodeURIComponent(name)}`;

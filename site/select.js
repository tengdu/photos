// Owner-only: select photos in All Photos, Days or an album, then delete them, add them to an album
// or remove them from the album, with the "Delete from GitHub" and "Add to Album" shortcuts
// (iPhone, iPad, Mac). The shortcuts hold the GitHub token; the site stores none.
import { itemsLabel } from './format.js';
import { cleanAlbumName, entryPath } from './albums.js';

const DELETE_SHORTCUT = 'Delete from GitHub';
const ADD_SHORTCUT = 'Add to Album';
// Shortcuts can be started from a web page on iPhone, iPad (reports itself as Macintosh) and Mac.
const HAS_SHORTCUTS = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const DELETED_KEY = 'photos.deleted';
const HIDE_FOR_MS = 30 * 60 * 1000; // until the rebuilt site no longer lists them

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// An earlier version could keep a GitHub token in the browser; make sure none is left behind.
store.del('photos.token');

/** Ids deleted from this device recently: hidden even if the site hasn't been rebuilt yet. */
export function recentlyDeleted() {
  let map = {};
  try { map = JSON.parse(store.get(DELETED_KEY) || '{}'); } catch {}
  const now = Date.now();
  for (const [id, t] of Object.entries(map)) if (now - t > HIDE_FOR_MS) delete map[id];
  store.set(DELETED_KEY, JSON.stringify(map));
  return new Set(Object.keys(map));
}

export function rememberDeleted(ids) {
  let map = {};
  try { map = JSON.parse(store.get(DELETED_KEY) || '{}'); } catch {}
  for (const id of ids) map[id] = Date.now();
  store.set(DELETED_KEY, JSON.stringify(map));
}

// A repo path, URL-encoded: the shortcuts append it to the GitHub API's URL.
const apiPath = (path) => path.split('/').map(encodeURIComponent).join('/');
const idList = (photos) => photos.map((p) => p.id).join(',');

/**
 * x-callback-url that runs a shortcut with `lines` (one repo path per line) as its input.
 * Shortcuts then returns to the site: to `success` when it finished, to `error` if it failed,
 * or to `cancel`.
 */
export function shortcutUrl({ shortcut, lines, success, cancel, error }) {
  const params = new URLSearchParams({
    name: shortcut,
    input: 'text',
    text: lines.join('\n'),
    'x-success': success,
    'x-cancel': cancel,
    'x-error': error,
  });
  return `shortcuts://x-callback-url/run-shortcut?${params.toString().replace(/\+/g, '%20')}`;
}

export function createSelection({ button, root, getPhotos, getAlbums }) {
  const selected = new Set();
  let active = false;
  let album = null; // the album on screen: its trash button removes photos from it

  const bar = document.createElement('div');
  bar.className = 'selbar';
  bar.hidden = true;
  bar.innerHTML = `<button type="button" class="sel-btn" data-act="all">Select All</button>
    <span class="sel-count" aria-live="polite"></span>
    <button type="button" class="sel-btn sel-icon" data-act="add" title="Add to Album" aria-label="Add to Album" disabled>${ALBUM_ADD}</button>
    <button type="button" class="sel-btn sel-delete" data-act="delete" disabled>${TRASH}<span>Delete</span></button>`;
  document.body.append(bar);

  const sheetWrap = document.createElement('div');
  sheetWrap.className = 'sheet-wrap';
  sheetWrap.hidden = true;
  sheetWrap.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"></div>';
  document.body.append(sheetWrap);
  const sheet = sheetWrap.firstElementChild;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.hidden = true;
  document.body.append(toast);

  function render() {
    document.documentElement.toggleAttribute('data-selecting', active);
    button.textContent = active ? 'Cancel' : 'Select';
    bar.hidden = !active;
    bar.querySelector('.sel-count').textContent = selected.size ? `${itemsLabel(chosen())} Selected` : 'Select Items';
    for (const b of bar.querySelectorAll('[data-act="add"], [data-act="delete"]')) b.disabled = !selected.size;
    bar.querySelector('.sel-delete span').textContent = album ? 'Remove' : 'Delete';
    for (const tile of root.querySelectorAll('.tile')) tile.classList.toggle('selected', selected.has(tile.dataset.id));
  }

  function setActive(on) {
    active = on;
    if (!on) selected.clear();
    render();
  }

  button.addEventListener('click', () => setActive(!active));
  bar.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'all') {
      const ids = [...root.querySelectorAll('.tile')].map((t) => t.dataset.id);
      const all = ids.every((id) => selected.has(id));
      ids.forEach((id) => (all ? selected.delete(id) : selected.add(id)));
      render();
    } else if (act === 'add') {
      chooseAlbum();
    } else if (act === 'delete') {
      if (album) confirmRemove();
      else confirmDelete();
    }
  });

  function closeSheet() {
    sheetWrap.hidden = true;
    sheet.innerHTML = '';
    sheetWrap.style.paddingBottom = '';
  }
  sheetWrap.addEventListener('click', (e) => e.target === sheetWrap && closeSheet());
  // Keep the sheet above the on-screen keyboard while typing an album name.
  window.visualViewport?.addEventListener('resize', () => {
    if (sheetWrap.hidden) return;
    const keyboard = innerHeight - visualViewport.height - visualViewport.offsetTop;
    sheetWrap.style.paddingBottom = keyboard > 80 ? `${keyboard + 12}px` : '';
  });

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => (toast.hidden = true), 5000);
  }

  // The selected photos and videos.
  function chosen() {
    const byId = new Map(getPhotos().map((p) => [p.id, p]));
    return [...selected].map((id) => byId.get(id)).filter(Boolean);
  }

  function confirmDelete() {
    const photos = chosen();
    if (!photos.length) return;
    // Their files, and their entries in albums.
    const lines = photos.flatMap((p) => [p.path, p.live].filter(Boolean).map(apiPath));
    for (const a of getAlbums()) for (const p of photos) if (a.items.includes(p)) lines.push(entryPath(a.name, p));
    confirm(`Delete ${itemsLabel(photos)}?`, photos, 'Delete with Shortcut',
      () => run({ shortcut: DELETE_SHORTCUT, lines, done: `deleted/${idList(photos)}`, failed: 'delete-failed' }));
  }

  // In an album: remove its entries for these photos; the photos stay in the library.
  function confirmRemove() {
    const photos = chosen();
    if (!photos.length) return;
    const name = album;
    confirm(`Remove ${itemsLabel(photos)} from “${name}”?`, photos, 'Remove with Shortcut',
      () => run({ shortcut: DELETE_SHORTCUT, lines: photos.map((p) => entryPath(name, p)), done: `album-removed/${encodeURIComponent(name)}/${idList(photos)}`, failed: 'delete-failed' }));
  }

  function confirm(title, photos, action, onRun) {
    const names = photos.slice(0, 4).map((p) => esc(p.name)).join(', ') + (photos.length > 4 ? `, and ${photos.length - 4} more` : '');
    sheet.innerHTML = `<h3>${esc(title)}</h3>
      <p>${names}</p>
      <div class="sheet-actions"><button type="button" class="sheet-btn" data-act="cancel">Cancel</button>
        <button type="button" class="sheet-btn sheet-danger" data-act="run">${action}</button></div>`;
    sheetWrap.hidden = false;
    sheet.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') closeSheet();
      if (act === 'run') onRun();
    };
  }

  function chooseAlbum() {
    const photos = chosen();
    if (!photos.length) return;
    const albums = getAlbums().filter((a) => a.name !== album);
    sheet.innerHTML = `<h3>Add ${itemsLabel(photos)} to an Album</h3>
      <form class="pick-new"><input name="album" type="text" maxlength="80" placeholder="New album" autocomplete="off" enterkeyhint="done" aria-label="New album name">
        <button type="submit" class="sheet-btn sheet-primary">Create</button></form>
      ${albums.length ? `<div class="pick">${albums.map((a, i) => `<button type="button" class="pick-row" data-i="${i}"><img src="${a.items[0].thumb}" alt=""><span><b>${esc(a.name)}</b><small>${a.items.length.toLocaleString('en-US')}</small></span></button>`).join('')}</div>` : ''}
      <div class="sheet-actions"><button type="button" class="sheet-btn" data-act="cancel">Cancel</button></div>`;
    sheetWrap.hidden = false;
    sheet.onclick = (e) => {
      if (e.target.closest('[data-act="cancel"]')) return closeSheet();
      const row = e.target.closest('.pick-row');
      if (row) addTo(albums[Number(row.dataset.i)].name, photos);
    };
    sheet.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const input = e.target.elements.album;
      const name = cleanAlbumName(input.value);
      if (name) addTo(name, photos);
      else input.focus();
    };
  }

  function addTo(name, photos) {
    const have = new Set(getAlbums().find((a) => a.name === name)?.items.map((p) => p.id));
    const add = photos.filter((p) => !have.has(p.id));
    if (!add.length) {
      closeSheet();
      setActive(false);
      showToast(`Already in “${name}”.`);
      return;
    }
    run({ shortcut: ADD_SHORTCUT, lines: add.map((p) => entryPath(name, p)), done: `album-added/${encodeURIComponent(name)}/${idList(add)}`, failed: 'album-failed' });
  }

  function run({ shortcut, lines, done, failed }) {
    // Shortcuts comes back to this view.
    const view = /^#\/(all|days|album\/[^/?#]+)/.exec(location.hash)?.[1] || 'all';
    try { sessionStorage.setItem('photos.returnView', view); } catch {}
    closeSheet();
    setActive(false);
    const base = `${location.origin}${location.pathname}`;
    location.href = shortcutUrl({ shortcut, lines, success: `${base}#/${done}`, cancel: `${base}#/${view}`, error: `${base}#/${failed}/${view}` });
  }

  return {
    get active() { return active; },
    toggle(id) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      render();
    },
    /** Show the Select button only where tiles can be selected (and Shortcuts exists). */
    setAvailable(on, inAlbum = null) {
      if (inAlbum !== album && active) setActive(false);
      album = inAlbum;
      button.hidden = !(on && HAS_SHORTCUTS);
      if (button.hidden && active) setActive(false);
    },
    refresh: render,
    toast: showToast,
  };
}

const ALBUM_ADD = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M8 4.5h10A1.5 1.5 0 0 1 19.5 6v10M5.5 7.5h9A1.5 1.5 0 0 1 16 9v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 18V9a1.5 1.5 0 0 1 1.5-1.5ZM10 10.5v6M7 13.5h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 7h16M9 7V4.8h6V7m-8.5 0 .9 12.2h9.2L17.5 7M10 11v5m4-5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

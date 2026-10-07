// Owner-only: select photos in All Photos / Days and delete them with the "Delete from GitHub"
// shortcut (iPhone, iPad, Mac). The shortcut holds the GitHub token; the site stores none.
import { count } from './format.js';

const SHORTCUT = 'Delete from GitHub';
const SETUP_URL = 'https://github.com/tengdu/photos#delete-from-github-shortcut';
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

/**
 * x-callback-url that runs the "Delete from GitHub" shortcut with the files to delete (one path
 * per line). Shortcuts then returns to the site: #/deleted/<ids> on success, #/delete-failed/<view>
 * on error, or back to the view if cancelled.
 */
export function shortcutUrl({ base, view, photos }) {
  const params = new URLSearchParams({
    name: SHORTCUT,
    input: 'text',
    text: photos.flatMap((p) => [p.path, p.live].filter(Boolean)).join('\n'),
    'x-success': `${base}#/deleted/${photos.map((p) => p.id).join(',')}`,
    'x-cancel': `${base}#/${view}`,
    'x-error': `${base}#/delete-failed/${view}`,
  });
  return `shortcuts://x-callback-url/run-shortcut?${params.toString().replace(/\+/g, '%20')}`;
}

export function createSelection({ button, root, getPhotos }) {
  const selected = new Set();
  let active = false;

  const bar = document.createElement('div');
  bar.className = 'selbar';
  bar.hidden = true;
  bar.innerHTML = `<button type="button" class="sel-btn" data-act="all">Select All</button>
    <span class="sel-count" aria-live="polite"></span>
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
    bar.querySelector('.sel-count').textContent = selected.size ? `${count(selected.size, 'Photo')} Selected` : 'Select Photos';
    bar.querySelector('[data-act="delete"]').disabled = !selected.size;
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
    } else if (act === 'delete') {
      confirmDelete();
    }
  });

  function closeSheet() {
    sheetWrap.hidden = true;
    sheet.innerHTML = '';
  }
  sheetWrap.addEventListener('click', (e) => e.target === sheetWrap && closeSheet());

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => (toast.hidden = true), 5000);
  }

  function confirmDelete() {
    const byId = new Map(getPhotos().map((p) => [p.id, p]));
    const photos = [...selected].map((id) => byId.get(id)).filter(Boolean);
    if (!photos.length) return;
    const videos = photos.filter((p) => p.live).length;
    const names = photos.slice(0, 4).map((p) => esc(p.name)).join(', ') + (photos.length > 4 ? `, and ${photos.length - 4} more` : '');
    sheet.innerHTML = `<h3>Delete ${count(photos.length, 'Photo')}?</h3>
      <p>${names}</p>
      <p>${videos ? `Their ${count(videos, 'Live Photo video')} ${videos === 1 ? 'is' : 'are'} deleted too. ` : ''}They are removed from the
        site and the repository; the site updates about 2 minutes later. (The files stay in the repository's history.)</p>
      <div class="sheet-actions"><button type="button" class="sheet-btn" data-act="cancel">Cancel</button>
        <button type="button" class="sheet-btn sheet-danger" data-act="run">Delete with Shortcut</button></div>
      <p class="sheet-small sheet-note">Runs your “${SHORTCUT}” shortcut, then comes back here.
        <a href="${SETUP_URL}" target="_blank" rel="noopener">How to set up the shortcut</a></p>`;
    sheetWrap.hidden = false;
    sheet.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') closeSheet();
      if (act === 'run') runShortcut(photos);
    };
  }

  function runShortcut(photos) {
    const view = /^#\/(all|days)/.exec(location.hash)?.[1] || 'all';
    try { sessionStorage.setItem('photos.returnView', view); } catch {}
    closeSheet();
    setActive(false);
    location.href = shortcutUrl({ base: `${location.origin}${location.pathname}`, view, photos });
  }

  return {
    get active() { return active; },
    toggle(id) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      render();
    },
    /** Show the Select button only where tiles can be selected (and Shortcuts exists). */
    setAvailable(on) {
      button.hidden = !(on && HAS_SHORTCUTS);
      if (button.hidden && active) setActive(false);
    },
    refresh: render,
    toast: showToast,
  };
}

const TRASH = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 7h16M9 7V4.8h6V7m-8.5 0 .9 12.2h9.2L17.5 7M10 11v5m4-5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

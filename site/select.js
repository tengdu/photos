// Owner-only: select photos in All Photos, Days or an album, then delete them, add them to an
// album, or remove them from the album. Each change is one commit through the GitHub API with the
// owner's token. The token lives in the device's passwords (iCloud Keychain…), which fill it in
// when the site asks; the site keeps it only in memory, never in its storage.
import { itemsLabel } from './format.js';
import { cleanAlbumName, entryPath } from './albums.js';
import { checkToken, commitChanges } from './github.js';

const DELETED_KEY = 'photos.deleted';
const HIDE_FOR_MS = 30 * 60 * 1000; // until the rebuilt site no longer lists them

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// An earlier version could keep a GitHub token in the browser's storage; make sure none is left.
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

let token = null; // in memory only, while the page is open

function reason(e) {
  if (e?.status === 401) return 'The token is wrong or has expired.';
  if (e?.status === 403 || e?.status === 404) return "This token can't change the photo repository.";
  if (e?.status === 0) return "Couldn't reach GitHub. Check the connection and try again.";
  return e?.message || 'Something went wrong.';
}

export function createSelection({ button, root, getPhotos, getAlbums, repo, branch, onDeleted, onAlbumChanged }) {
  const selected = new Set();
  let active = false;
  let album = null; // the album on screen: its trash button removes photos from it
  let pendingToken = null; // resolves the token prompt

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

  function openSheet(html) {
    sheet.innerHTML = html;
    sheet.onclick = null;
    sheetWrap.hidden = false;
  }

  function closeSheet() {
    sheetWrap.hidden = true;
    sheet.innerHTML = '';
    sheetWrap.style.paddingBottom = '';
    pendingToken?.(null);
  }
  sheetWrap.addEventListener('click', (e) => e.target === sheetWrap && !sheet.querySelector('.sheet-busy') && closeSheet());
  // Keep the sheet above the on-screen keyboard while typing.
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

  const names = (photos) => photos.slice(0, 4).map((p) => esc(p.name)).join(', ') + (photos.length > 4 ? `, and ${photos.length - 4} more` : '');
  const what = (photos) => (photos.length === 1 ? photos[0].name : itemsLabel(photos).toLowerCase());

  function confirm(title, photos, action, onConfirm) {
    openSheet(`<h3>${esc(title)}</h3>
      <p>${names(photos)}</p>
      <div class="sheet-actions"><button type="button" class="sheet-btn" data-act="cancel">Cancel</button>
        <button type="button" class="sheet-btn sheet-danger" data-act="run">${action}</button></div>`);
    sheet.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') closeSheet();
      if (act === 'run') onConfirm();
    };
  }

  function confirmDelete() {
    const photos = chosen();
    if (!photos.length) return;
    // The files, and their entries in albums.
    const remove = photos.flatMap((p) => [p.path, p.live].filter(Boolean));
    for (const a of getAlbums()) for (const p of photos) if (a.items.includes(p)) remove.push(entryPath(a.name, p));
    confirm(`Delete ${itemsLabel(photos)}?`, photos, 'Delete', () => save('Deleting…', { remove, message: `Delete ${what(photos)}` }, () => {
      onDeleted(photos.map((p) => p.id));
      return `Deleted ${itemsLabel(photos).toLowerCase()}. The site updates in about a minute.`;
    }));
  }

  // In an album: take the photos out of it; they stay in the library.
  function confirmRemove() {
    const photos = chosen();
    if (!photos.length) return;
    const name = album;
    confirm(`Remove ${itemsLabel(photos)} from “${name}”?`, photos, 'Remove',
      () => save('Removing…', { remove: photos.map((p) => entryPath(name, p)), message: `Remove ${what(photos)} from album “${name}”` }, () => {
        onAlbumChanged('remove', name, photos.map((p) => p.id));
        return `Removed ${itemsLabel(photos).toLowerCase()} from “${name}”.`;
      }));
  }

  function chooseAlbum() {
    const photos = chosen();
    if (!photos.length) return;
    const albums = getAlbums().filter((a) => a.name !== album);
    openSheet(`<h3>Add ${itemsLabel(photos)} to an Album</h3>
      <form class="pick-new"><input name="album" type="text" maxlength="80" placeholder="New album" autocomplete="off" enterkeyhint="done" aria-label="New album name">
        <button type="submit" class="sheet-btn sheet-primary">Create</button></form>
      ${albums.length ? `<div class="pick">${albums.map((a, i) => `<button type="button" class="pick-row" data-i="${i}"><img src="${a.items[0].thumb}" alt=""><span><b>${esc(a.name)}</b><small>${a.items.length.toLocaleString('en-US')}</small></span></button>`).join('')}</div>` : ''}
      <div class="sheet-actions"><button type="button" class="sheet-btn" data-act="cancel">Cancel</button></div>`);
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
    save('Adding…', { add: add.map((p) => ({ path: entryPath(name, p) })), message: `Add ${what(add)} to album “${name}”` }, () => {
      onAlbumChanged('add', name, add.map((p) => p.id));
      return `Added ${itemsLabel(add).toLowerCase()} to “${name}”.`;
    });
  }

  // Commit the change (asking for the token first if this page doesn't have it), then update
  // the page and say what happened.
  async function save(busy, change, done) {
    try {
      if (!token) {
        token = await askToken();
        if (!token) return;
      }
      openSheet(`<p class="sheet-busy"><i class="spin" aria-hidden="true"></i>${busy}</p>`);
      await commitChanges({ token, repo, branch, ...change });
      const message = done();
      closeSheet();
      setActive(false);
      showToast(message);
    } catch (e) {
      if (e?.status === 401) token = null; // ask again next time
      openSheet(`<h3>Couldn't save the change</h3><p>${esc(reason(e))}</p>
        <div class="sheet-actions"><button type="button" class="sheet-btn" data-act="cancel">Close</button></div>`);
      sheet.onclick = (ev) => ev.target.closest('[data-act="cancel"]') && closeSheet();
    }
  }

  // A sign-in style form, so the device's password manager offers to save the token and fills it
  // in later (Face ID / Touch ID). The hidden user name is what the saved password is listed under.
  function askToken() {
    return new Promise((resolve) => {
      openSheet(`<h3>GitHub Token</h3>
        <form class="token-form" method="post" action="#">
          <input type="text" name="username" autocomplete="username" value="${esc(repo)}" hidden>
          <input class="sheet-input" type="password" name="password" autocomplete="current-password" placeholder="Token" aria-label="GitHub token" required>
          <p class="sheet-error" hidden></p>
          <div class="sheet-actions"><button type="button" class="sheet-btn" data-act="cancel">Cancel</button>
            <button type="submit" class="sheet-btn sheet-primary">Continue</button></div>
        </form>`);
      pendingToken = (value) => {
        pendingToken = null;
        resolve(value);
      };
      const form = sheet.querySelector('form');
      sheet.onclick = (e) => e.target.closest('[data-act="cancel"]') && closeSheet();
      form.onsubmit = async (e) => {
        e.preventDefault();
        const value = form.elements.password.value.trim();
        const error = form.querySelector('.sheet-error');
        const submit = form.querySelector('[type="submit"]');
        submit.disabled = true;
        try {
          await checkToken(value, repo);
          pendingToken?.(value);
        } catch (err) {
          error.textContent = reason(err);
          error.hidden = false;
          submit.disabled = false;
        }
      };
      form.elements.password.focus();
    });
  }

  return {
    get active() { return active; },
    toggle(id) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      render();
    },
    /** Show the Select button only where tiles can be selected; `inAlbum`: the album shown. */
    setAvailable(on, inAlbum = null) {
      if (inAlbum !== album && active) setActive(false);
      album = inAlbum;
      button.hidden = !on;
      if (button.hidden && active) setActive(false);
    },
    refresh: render,
    toast: showToast,
  };
}

const ALBUM_ADD = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M8 4.5h10A1.5 1.5 0 0 1 19.5 6v10M5.5 7.5h9A1.5 1.5 0 0 1 16 9v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 18V9a1.5 1.5 0 0 1 1.5-1.5ZM10 10.5v6M7 13.5h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 7h16M9 7V4.8h6V7m-8.5 0 .9 12.2h9.2L17.5 7M10 11v5m4-5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

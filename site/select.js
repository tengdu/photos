// Owner-only: select photos in All Photos / Days and delete them from the repository in one
// commit. Uses a GitHub token that the owner pastes once; it's kept only in this browser.
import { deleteFiles } from './github.js';
import { count } from './format.js';

const TOKEN_KEY = 'photos.token';
const DELETED_KEY = 'photos.deleted';
const HIDE_FOR_MS = 30 * 60 * 1000; // until the rebuilt site no longer lists them

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

/** Ids deleted from this device recently: hidden even if the site hasn't been rebuilt yet. */
export function recentlyDeleted() {
  let map = {};
  try { map = JSON.parse(store.get(DELETED_KEY) || '{}'); } catch {}
  const now = Date.now();
  for (const [id, t] of Object.entries(map)) if (now - t > HIDE_FOR_MS) delete map[id];
  store.set(DELETED_KEY, JSON.stringify(map));
  return new Set(Object.keys(map));
}

function rememberDeleted(ids) {
  let map = {};
  try { map = JSON.parse(store.get(DELETED_KEY) || '{}'); } catch {}
  for (const id of ids) map[id] = Date.now();
  store.set(DELETED_KEY, JSON.stringify(map));
}

let sessionToken = null; // used when this browser can't store it (private mode)

export function createSelection({ button, root, github, getPhotos, onDeleted }) {
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
      startDelete();
    }
  });

  // ---- Sheets ----
  function openSheet(html) {
    sheet.innerHTML = html;
    sheetWrap.hidden = false;
    return sheet;
  }
  function closeSheet() {
    sheetWrap.hidden = true;
    sheet.innerHTML = '';
  }
  sheetWrap.addEventListener('click', (e) => {
    if (e.target === sheetWrap && !sheet.querySelector('.busy')) closeSheet();
  });

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => (toast.hidden = true), 5000);
  }

  const token = () => sessionToken || store.get(TOKEN_KEY);

  function askToken(reason) {
    return new Promise((resolve) => {
      const s = openSheet(`<h3>Connect to GitHub</h3>
        ${reason ? `<p class="sheet-warn">${esc(reason)}</p>` : ''}
        <p>To delete photos from this device, paste a GitHub token that can change <b>${esc(github.repo)}</b>
          (fine-grained, repository access to that repo only, <b>Contents: Read and write</b>). The token used by your upload shortcut works.</p>
        <p class="sheet-small">It is saved only in this browser and sent only to GitHub.
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create a token</a></p>
        <input type="password" class="sheet-input" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="sheet-actions"><button type="button" class="sheet-btn" data-act="cancel">Cancel</button>
          <button type="button" class="sheet-btn sheet-primary" data-act="save">Save</button></div>`);
      const input = s.querySelector('input');
      input.focus();
      s.onclick = (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'cancel') { closeSheet(); resolve(null); }
        if (act === 'save') {
          const value = input.value.trim();
          if (!value) return input.focus();
          if (!store.set(TOKEN_KEY, value)) sessionToken = value;
          closeSheet();
          resolve(value);
        }
      };
    });
  }

  function confirmDelete(photos) {
    const videos = photos.filter((p) => p.live).length;
    const names = photos.slice(0, 4).map((p) => esc(p.name)).join(', ') + (photos.length > 4 ? `, and ${photos.length - 4} more` : '');
    return new Promise((resolve) => {
      const s = openSheet(`<h3>Delete ${count(photos.length, 'Photo')}?</h3>
        <p>${names}</p>
        <p>${videos ? `Their ${count(videos, 'Live Photo video')} ${videos === 1 ? 'is' : 'are'} deleted too. ` : ''}They are removed from the
          site and the repository in one change; the site updates about 2 minutes later. (The files stay in the repository's history.)</p>
        <div class="sheet-actions"><button type="button" class="sheet-btn" data-act="cancel">Cancel</button>
          <button type="button" class="sheet-btn sheet-danger" data-act="ok">Delete</button></div>
        <button type="button" class="sheet-link" data-act="forget">Forget the GitHub token on this device</button>`);
      s.onclick = (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'cancel') { closeSheet(); resolve(false); }
        if (act === 'ok') resolve(true);
        if (act === 'forget') {
          store.del(TOKEN_KEY);
          sessionToken = null;
          closeSheet();
          showToast('The GitHub token was removed from this device.');
          resolve(false);
        }
      };
    });
  }

  async function startDelete() {
    const byId = new Map(getPhotos().map((p) => [p.id, p]));
    const photos = [...selected].map((id) => byId.get(id)).filter(Boolean);
    if (!photos.length) return;
    let tok = token() || (await askToken());
    if (!tok) return;
    if (!(await confirmDelete(photos))) return;
    const paths = photos.flatMap((p) => [p.path, p.live].filter(Boolean));
    const message = photos.length === 1 ? `Delete ${photos[0].name}` : `Delete ${photos.length} photos\n\n${photos.map((p) => p.name).join('\n')}`;
    for (;;) {
      openSheet(`<div class="busy"><i class="spinner"></i><p>Deleting ${count(photos.length, 'photo')}…</p></div>`);
      try {
        await deleteFiles({ token: tok, repo: github.repo, branch: github.branch, paths, message });
        closeSheet();
        rememberDeleted(photos.map((p) => p.id));
        setActive(false);
        onDeleted(new Set(photos.map((p) => p.id)));
        showToast(`Deleted ${count(photos.length, 'photo')}. The site updates in about 2 minutes.`);
        return;
      } catch (e) {
        const auth = e.status === 401 || e.status === 403 || e.status === 404;
        if (auth) {
          store.del(TOKEN_KEY);
          sessionToken = null;
          tok = await askToken(e.status === 401
            ? 'GitHub did not accept that token (it may be wrong or expired).'
            : `That token can't change ${github.repo}. It needs repository access to it with Contents: Read and write.`);
          if (!tok) return;
          continue;
        }
        const s = openSheet(`<h3>Couldn't delete</h3><p>${esc(e.message || String(e))}</p>
          <div class="sheet-actions"><button type="button" class="sheet-btn sheet-primary" data-act="close">OK</button></div>`);
        s.onclick = (ev) => ev.target.closest('[data-act]') && closeSheet();
        return;
      }
    }
  }

  return {
    get active() { return active; },
    toggle(id) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      render();
    },
    /** Show the Select button only where tiles can be selected. */
    setAvailable(on) {
      button.hidden = !on;
      if (!on && active) setActive(false);
    },
    refresh: render,
  };
}

const TRASH = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 7h16M9 7V4.8h6V7m-8.5 0 .9 12.2h9.2L17.5 7M10 11v5m4-5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

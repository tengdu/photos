// Owner-only: select photos in All Photos, Days or an album, then delete them, add them to an
// album, remove them from the album, or change their date. Each change is one commit through the
// GitHub API with the owner's token. The token lives in the device's passwords (iCloud Keychain…),
// which fill it in when the site asks; the site keeps it only in memory, never in its storage.
import { itemsLabel, takenLabel } from './format.js';
import { cleanAlbumName, entryPath } from './albums.js';
import { checkToken, commitChanges, readFile, uploadBlob, GitHubError } from './github.js';
import { canSetDate, parseTaken, inputValue, takenString, exifString, deviceOffset, OFFSETS, offsetLabel, shiftLabel } from './dates.js';

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

export function createSelection({ button, root, getPhotos, getAlbums, repo, branch, onDeleted, onAlbumChanged, onDatesChanged }) {
  const selected = new Set();
  let active = false;
  let album = null; // the album on screen: its trash button removes photos from it
  let pendingToken = null; // resolves the token prompt

  const bar = document.createElement('div');
  bar.className = 'selbar';
  bar.hidden = true;
  bar.innerHTML = `<button type="button" class="sel-btn" data-act="all">Select All</button>
    <span class="sel-count" aria-live="polite"></span>
    <button type="button" class="sel-btn sel-icon" data-act="date" title="Adjust Date &amp; Time" aria-label="Adjust Date &amp; Time" disabled>${CALENDAR}</button>
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
    bar.querySelector('[data-act="date"]').disabled = !chosen().some(canSetDate);
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
    } else if (act === 'date') {
      adjustDate();
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

  // Write the capture time into the selected photos' files (EXIF). Several photos either all move
  // by the same amount, keeping their order (the earliest one gets the time in the form, as in
  // Photos), or all get the same time.
  function adjustDate() {
    const all = chosen();
    const photos = all.filter(canSetDate);
    if (!photos.length) return;
    const skipped = all.length - photos.length;
    const undated = photos.filter((p) => p.undated).length;
    const ref = photos.reduce((a, b) => (b.index > a.index ? b : a)); // the earliest
    const now = Date.now();
    const start = parseTaken(ref.taken) || { wall: now - (now % 1000), offset: null };
    // Without a time zone in the file, suggest this device's (the upload time is its local time).
    const zone = start.offset || (ref.undated || !ref.taken ? deviceOffset(start.wall) : '');
    const minutes = (o) => (o[0] === '-' ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(4)));
    const zones = [...new Set([...OFFSETS, zone].filter(Boolean))].sort((a, b) => minutes(a) - minutes(b));
    const many = photos.length > 1;
    const before = takenLabel(ref.taken);
    const noDate = undated === photos.length
      ? `${many ? 'These photos have' : 'This photo has'} no date in the file, so the site shows the upload time.`
      : `${undated} of them ${undated === 1 ? 'has' : 'have'} no date in the file, so the site shows the upload time.`;

    openSheet(`<h3>Adjust Date &amp; Time</h3>
      <p>${names(photos)}</p>
      ${undated ? `<p>${noDate}</p>` : ''}
      <form class="date-form">
        <label class="date-field"><span>Date &amp; Time</span>
          <input class="sheet-input" type="datetime-local" name="when" step="1" min="1900-01-01T00:00" max="2100-12-31T23:59:59" value="${inputValue(start.wall)}" required></label>
        <label class="date-field"><span>Time Zone</span>
          <select class="sheet-input" name="tz"><option value="">None</option>${zones.map((o) => `<option value="${o}"${o === zone ? ' selected' : ''}>${offsetLabel(o)}</option>`).join('')}</select></label>
        ${many ? `<div class="date-mode">
          <label><input type="radio" name="mode" value="shift" checked><span>Shift all by the same amount<small>Keeps their order; the earliest one gets this time.</small></span></label>
          <label><input type="radio" name="mode" value="same"><span>Same date &amp; time for all</span></label></div>` : ''}
        <p class="date-note" aria-live="polite"></p>
        ${skipped ? `<p>${skipped} ${skipped === 1 ? 'item keeps its' : 'items keep their'} date: only JPEG and HEIC photos can be changed.</p>` : ''}
        <p class="sheet-error" hidden></p>
        <div class="sheet-actions"><button type="button" class="sheet-btn" data-act="cancel">Cancel</button>
          <button type="submit" class="sheet-btn sheet-primary">Adjust</button></div>
      </form>`);
    const form = sheet.querySelector('form');
    const note = form.querySelector('.date-note');
    const error = form.querySelector('.sheet-error');

    // The new time of each photo that changes.
    const plan = () => {
      const wall = parseTaken(form.elements.when.value)?.wall;
      if (wall == null) return null;
      const offset = form.elements.tz.value || null;
      const shift = form.elements.mode?.value !== 'same';
      return {
        delta: wall - start.wall,
        shift,
        changes: photos.map((p) => {
          const w = shift ? (parseTaken(p.taken)?.wall ?? start.wall) + (wall - start.wall) : wall;
          return { p, wall: w, offset, taken: takenString(w, offset) };
        }).filter((c) => c.p.undated || c.taken !== c.p.taken),
      };
    };
    const update = () => {
      const x = plan();
      error.hidden = true;
      const was = `Was ${before.date}${before.time ? `, ${before.time}` : ''}${ref.undated ? ' (upload time)' : ''}.`;
      if (!x) note.textContent = '';
      else if (!many) note.textContent = was;
      else if (!x.shift) note.textContent = `All ${photos.length} photos get this date and time.`;
      else note.textContent = x.delta ? `Each photo moves ${shiftLabel(x.delta)}.` : `The earliest photo w${was.slice(1)}`;
    };
    form.oninput = update;
    update();
    sheet.onclick = (e) => e.target.closest('[data-act="cancel"]') && closeSheet();
    form.onsubmit = (e) => {
      e.preventDefault();
      const x = plan();
      if (!x) return form.elements.when.focus();
      const outside = x.changes.find((c) => !(new Date(c.wall).getUTCFullYear() >= 1900 && new Date(c.wall).getUTCFullYear() <= 2100));
      if (outside) {
        error.textContent = `${outside.p.name} would move outside the years 1900–2100.`;
        error.hidden = false;
        return;
      }
      if (!x.changes.length) {
        closeSheet();
        setActive(false);
        showToast('The date is already set.');
        return;
      }
      const changed = x.changes.map((c) => c.p);
      save('Updating…', async (busy) => {
        const { setDateTaken } = await import('./lib/exif-date.js');
        const put = [];
        for (const [i, c] of x.changes.entries()) {
          if (many) busy(`Updating ${i + 1} of ${x.changes.length}…`);
          let bytes;
          try {
            bytes = setDateTaken(await readFile({ token, repo, branch, path: c.p.path }), c.p.fmt, { when: exifString(c.wall), offset: c.offset });
          } catch (err) {
            if (err instanceof GitHubError) throw err;
            throw new Error(`${c.p.name}: ${err.message}`);
          }
          put.push({ path: c.p.path, sha: await uploadBlob({ token, repo, bytes }) });
        }
        return { put, message: `Change the date of ${what(changed)}` };
      }, () => {
        onDatesChanged(x.changes.map((c) => ({ id: c.p.id, path: c.p.path, taken: c.taken })));
        return `Changed the date of ${what(changed)}. The site updates in about a minute.`;
      });
    };
  }

  // Commit the change (asking for the token first if this page doesn't have it), then update
  // the page and say what happened. `change` may be a function that prepares it, given a function
  // that updates the progress message.
  async function save(busy, change, done) {
    try {
      if (!token) {
        token = await askToken();
        if (!token) return;
      }
      const setBusy = (text) => openSheet(`<p class="sheet-busy"><i class="spin" aria-hidden="true"></i>${esc(text)}</p>`);
      setBusy(busy);
      await commitChanges({ token, repo, branch, ...(typeof change === 'function' ? await change(setBusy) : change) });
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
const CALENDAR = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M6 5.5h12A1.5 1.5 0 0 1 19.5 7v11a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7A1.5 1.5 0 0 1 6 5.5ZM4.5 10h15M8.5 3.5v4M15.5 3.5v4M12 13v3l2 1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TRASH ='<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 7h16M9 7V4.8h6V7m-8.5 0 .9 12.2h9.2L17.5 7M10 11v5m4-5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

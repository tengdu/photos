import './styles.css';
import { Library, VIEWS } from './library.js';
import { openViewer, closeViewer, isOpen } from './viewer.js';
import { loadOriginal } from './original.js';
import { createSelection, recentlyDeleted, rememberDeleted } from './select.js';
import { itemsLabel } from './format.js';

const $ = (s) => document.querySelector(s);
const state = { photos: [], byId: new Map(), view: 'all', viewerFromApp: false, viewerList: null, mapActive: false, libraryScroll: 0 };
let library;
let selection = null; // owner only
let mapModule;

boot();

// "?owner" marks this browser as the owner's (Select & delete); "?owner=off" undoes it.
function ownerMode() {
  const params = new URLSearchParams(location.search);
  try {
    if (params.has('owner')) {
      if (params.get('owner') === 'off') localStorage.removeItem('photos.owner');
      else localStorage.setItem('photos.owner', '1');
      params.delete('owner');
      const query = params.toString();
      history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    }
    return localStorage.getItem('photos.owner') === '1';
  } catch {
    return params.has('owner') && params.get('owner') !== 'off';
  }
}

async function boot() {
  const owner = ownerMode();
  if (owner) document.documentElement.dataset.owner = '';
  // Expose the header height to CSS (the map sits behind the translucent header).
  new ResizeObserver(([e]) => document.documentElement.style.setProperty('--top-h', `${e.target.offsetHeight}px`)).observe($('.top'));
  let data;
  try {
    data = await loadPhotoList();
    state.photos = prepare(data, recentlyDeleted());
  } catch (e) {
    if (e.message === 'reloading') return;
    $('#view').innerHTML = `<p class="empty">Couldn't load the photo list.<br><span>${String(e.message)}</span></p>`;
    return;
  }
  state.photos.forEach((p) => state.byId.set(p.id, p));
  library = new Library({
    root: $('#view'),
    title: $('#title'),
    subtitle: $('#subtitle'),
    dock: $('#dock'),
    zoom: $('#zoom'),
    photos: state.photos,
  });
  if (owner) selection = createSelection({ button: $('#select'), root: $('#view'), getPhotos: () => state.photos });
  document.addEventListener('click', onClick);
  bindPrefetch();
  addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && isSecureContext) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}

// The page itself may be up to 10 minutes stale (GitHub Pages caching), so ask for the
// current version, uncached, while the preloaded photo list downloads.
async function loadPhotoList() {
  const preloaded = $('link[data-photos]').href;
  const [list, latest] = await Promise.all([
    fetch(preloaded).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    fetch('version.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (!latest) return list;
  const appNow = new URL(import.meta.url).pathname.split('/').pop();
  if (!latest.app.endsWith(appNow)) {
    let reloaded = false;
    try { reloaded = sessionStorage.getItem('photos.reloaded') === latest.app; sessionStorage.setItem('photos.reloaded', latest.app); } catch {}
    if (!reloaded) {
      location.reload();
      throw new Error('reloading');
    }
  }
  if (new URL(latest.data, document.baseURI).href === preloaded) return list;
  const res = await fetch(latest.data);
  return res.ok ? res.json() : list;
}

function prepare(data, hidden = new Set()) {
  const url = (path) => data.raw + path.split('/').map(encodeURIComponent).join('/');
  return data.items.filter((it) => !hidden.has(it.id)).map((it, index) => ({
    ...it,
    index,
    src: it.url || url(it.path), // videos in the release have their own URL
    liveSrc: it.live ? url(it.live) : null,
    thumb: `m/${it.id}.webp`,
    name: it.path.split('/').pop().replace(/\.release$/, ''),
    day: it.taken ? it.taken.slice(0, 10) : 'unknown',
    month: it.taken ? it.taken.slice(0, 7) : 'unknown',
    year: it.taken ? it.taken.slice(0, 4) : 'unknown',
  }));
}

function parseRoute() {
  const [, kind, arg] = /^#\/([a-z-]+)(?:\/(.+))?$/.exec(location.hash) || [];
  if (kind === 'photo') return { photo: arg };
  if (kind === 'deleted' || kind === 'delete-failed') return { shortcut: kind, arg: arg || '' };
  if (kind === 'map') return { view: 'map', focus: arg };
  if (VIEWS.includes(kind)) return { view: kind, anchor: arg };
  return { view: state.view };
}

function route() {
  const r = parseRoute();
  if (r.shortcut) return shortcutReturned(r);
  if (r.photo) {
    const p = state.byId.get(r.photo);
    if (!p) return location.replace(`#/${state.view}`);
    if (!state.mapActive && !library.view) library.show(state.view === 'map' ? 'all' : state.view);
    const list = state.viewerList?.includes(p) ? state.viewerList : state.photos;
    openViewer({
      photos: list,
      index: list.indexOf(p),
      thumbFor: (id) => (state.mapActive ? mapModule?.thumbFor(id) : library.thumbFor(id)),
      onChange: (i) => {
        const hash = `#/photo/${list[i].id}`;
        if (location.hash !== hash) history.replaceState(null, '', hash);
      },
      onClosed,
    });
    return;
  }
  if (isOpen()) closeViewer(); // e.g. the browser's Back button while the viewer is open
  state.view = r.view;
  setDock(r.view);
  selection?.setAvailable(r.view === 'all' || r.view === 'days');
  if (r.view === 'map') return showMapView(r.focus);
  if (state.mapActive) hideMapView();
  library.show(r.view, r.anchor);
  selection?.refresh();
}

// Back from the "Delete from GitHub" shortcut (see select.js).
function shortcutReturned({ shortcut, arg }) {
  let view = 'all';
  try { view = sessionStorage.getItem('photos.returnView') || view; } catch {}
  if (shortcut === 'deleted' && selection) {
    const ids = new Set(arg.split(',').filter((id) => state.byId.has(id)));
    const what = itemsLabel([...ids].map((id) => state.byId.get(id))).toLowerCase();
    rememberDeleted(ids);
    removePhotos(ids);
    selection.toast(`Deleted ${what}. The site updates in about 2 minutes.`);
  } else if (shortcut === 'delete-failed' && selection) {
    const reason = new URLSearchParams(arg.split('?')[1] || '').get('errorMessage');
    selection.toast(`The “Delete from GitHub” shortcut didn't finish${reason ? `: ${reason}` : '.'} Nothing was hidden.`);
  }
  location.replace(`#/${view}`);
}

// After deleting: drop the photos everywhere and redraw.
function removePhotos(ids) {
  state.photos = state.photos.filter((p) => !ids.has(p.id)).map((p, index) => ({ ...p, index }));
  state.byId = new Map(state.photos.map((p) => [p.id, p]));
  library.setPhotos(state.photos);
  mapModule?.resetMap();
}

function setDock(view) {
  for (const a of $('#dock').querySelectorAll('a[data-view]')) a.toggleAttribute('aria-current', a.dataset.view === view);
}

async function showMapView(focusId) {
  if (!state.mapActive) {
    state.libraryScroll = scrollY;
    state.mapActive = true;
    document.documentElement.dataset.view = 'map';
    $('#view').hidden = true;
    $('#zoom').hidden = true;
  }
  mapModule ??= await import('./map.js');
  if (!state.mapActive) return; // left the map while it was loading
  mapModule.showMap({
    photos: state.photos,
    root: $('#mapview'),
    focusId,
    setHeader: (title, sub) => {
      $('#title').textContent = title;
      $('#subtitle').textContent = sub;
    },
    openPhotos,
  });
}

function hideMapView() {
  state.mapActive = false;
  mapModule?.hideMap();
  $('#view').hidden = false;
  requestAnimationFrame(() => scrollTo(0, state.libraryScroll));
}

/** Open the viewer on `id`, browsing `list` (e.g. the photos at one place on the map). */
function openPhotos(list, id) {
  state.viewerList = list;
  state.viewerFromApp = true;
  location.hash = `#/photo/${id}`;
}

function onClosed(id) {
  state.viewerList = null;
  // Only leave the photo URL if it still belongs to the viewer that just closed
  // (another photo may already have been requested).
  if (location.hash !== `#/photo/${id}`) return;
  if (state.viewerFromApp) history.back();
  else history.replaceState(null, '', `#/${state.view}`);
  state.viewerFromApp = false;
}

function onClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const tile = e.target.closest('.tile');
  if (!tile) return;
  e.preventDefault();
  if (selection?.active && tile.closest('#view')) return selection.toggle(tile.dataset.id);
  const hash = `#/photo/${tile.dataset.id}`;
  // If a photo is still in the URL (viewer closing), replace it instead of stacking history.
  if (location.hash.startsWith('#/photo/')) location.replace(hash);
  else {
    state.viewerFromApp = true;
    location.hash = hash;
  }
}

// Desktop: start downloading a photo's original when the mouse rests on it or presses it,
// so it's often ready by the time the viewer opens. (Not on touch, where a finger that
// merely scrolls the grid would trigger downloads.)
function bindPrefetch() {
  if (navigator.connection?.saveData) return;
  const prefetch = (tile) => {
    if (selection?.active) return;
    const p = tile && state.byId.get(tile.dataset.id);
    if (p && !p.video) loadOriginal(p).catch(() => {}); // videos stream when played
  };
  let timer = 0;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(timer);
    const tile = e.target.closest?.('.tile');
    if (tile) timer = setTimeout(() => prefetch(tile), 150);
  });
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button === 0) prefetch(e.target.closest?.('.tile'));
  });
}

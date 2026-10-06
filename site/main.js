import './styles.css';
import { Library, VIEWS } from './library.js';
import { openViewer, closeViewer, isOpen } from './viewer.js';

const $ = (s) => document.querySelector(s);
const state = { photos: [], byId: new Map(), view: 'all', viewerFromApp: false, viewerList: null, mapActive: false, libraryScroll: 0 };
let library;
let mapModule;

boot();

async function boot() {
  // Expose the header height to CSS (the map sits behind the translucent header).
  new ResizeObserver(([e]) => document.documentElement.style.setProperty('--top-h', `${e.target.offsetHeight}px`)).observe($('.top'));
  try {
    const res = await fetch($('link[data-photos]').href);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.photos = prepare(await res.json());
  } catch (e) {
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
  document.addEventListener('click', onClick);
  addEventListener('hashchange', route);
  route();
}

function prepare(data) {
  const url = (path) => data.raw + path.split('/').map(encodeURIComponent).join('/');
  return data.items.map((it, index) => ({
    ...it,
    index,
    src: url(it.path),
    liveSrc: it.live ? url(it.live) : null,
    thumb: `m/${it.id}.webp`,
    name: it.path.split('/').pop(),
    day: it.taken ? it.taken.slice(0, 10) : 'unknown',
    month: it.taken ? it.taken.slice(0, 7) : 'unknown',
    year: it.taken ? it.taken.slice(0, 4) : 'unknown',
  }));
}

function parseRoute() {
  const [, kind, arg] = /^#\/([a-z]+)(?:\/(.+))?$/.exec(location.hash) || [];
  if (kind === 'photo') return { photo: arg };
  if (kind === 'map') return { view: 'map', focus: arg };
  if (VIEWS.includes(kind)) return { view: kind, anchor: arg };
  return { view: state.view };
}

function route() {
  const r = parseRoute();
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
  if (r.view === 'map') return showMapView(r.focus);
  if (state.mapActive) hideMapView();
  library.show(r.view, r.anchor);
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
  const hash = `#/photo/${tile.dataset.id}`;
  // If a photo is still in the URL (viewer closing), replace it instead of stacking history.
  if (location.hash.startsWith('#/photo/')) location.replace(hash);
  else {
    state.viewerFromApp = true;
    location.hash = hash;
  }
}

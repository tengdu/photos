// Map view: photos clustered by location, drawn as thumbnail pins (like Places in Photos).
import Supercluster from 'supercluster';
import { loadMaplibre, mapStyle, onSchemeChange } from './maplib.js';
import { itemCount, placeLabel, rangeLabel } from './format.js';
import { tileHTML } from './library.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let ml, map, index, opts, root, canvas, sheet, ready, geo;
let sheetList = [];
const pins = new Map();

/**
 * opts: { photos, root, setHeader(title, subtitle), openPhotos(list, id), focusId }
 */
export function showMap(options) {
  opts = options;
  root = options.root;
  root.hidden = false;
  geo = opts.photos.filter((p) => p.geo);
  opts.setHeader('Map', geo.length ? `${itemCount(geo)} with a location` : 'No photos with a location yet');
  ready ??= init().catch((e) => {
    ready = null;
    root.innerHTML = `<p class="empty map-empty">Couldn't load the map.<br><span>${esc(e.message)}</span></p>`;
  });
  ready.then(() => {
    if (!map) return;
    map.resize();
    if (opts.focusId) focusPhoto(opts.focusId);
  });
}

/** Forget the map so the next showMap() builds it again from the current photos. */
export function resetMap() {
  for (const marker of pins.values()) marker.remove();
  pins.clear();
  map?.remove();
  map = null;
  ready = null;
  if (root) root.innerHTML = '';
}

export function hideMap() {
  if (root) root.hidden = true;
  closeSheet();
}

/** Thumbnail in the open place sheet (for the viewer's zoom animation). */
export const thumbFor = (id) => (sheet && !sheet.hidden ? sheet.querySelector(`.tile[data-id="${id}"] img`) : null);

async function init() {
  root.innerHTML = '<div class="map-canvas"></div><section class="map-sheet" hidden aria-label="Photos at this place"></section>';
  canvas = root.querySelector('.map-canvas');
  sheet = root.querySelector('.map-sheet');
  sheet.addEventListener('click', onSheetClick);
  ml = await loadMaplibre();

  index = new Supercluster({
    radius: 64,
    maxZoom: 17,
    map: (props) => ({ i: props.i }),
    reduce: (acc, props) => { if (props.i < acc.i) acc.i = props.i; }, // newest photo is the cover
  });
  index.load(geo.map((p) => ({ type: 'Feature', properties: { i: p.index }, geometry: { type: 'Point', coordinates: [p.geo[1], p.geo[0]] } })));

  map = new ml.Map({
    container: canvas,
    style: mapStyle(),
    center: [0, 20],
    zoom: 1.2,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    fadeDuration: 0,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
  map.on('moveend', renderPins);
  map.on('load', renderPins);
  map.on('click', closeSheet);
  onSchemeChange(() => map.setStyle(mapStyle()));
  if (geo.length && !opts.focusId) fitAll(0);
}

function padding() {
  const top = (document.querySelector('.top')?.getBoundingClientRect().bottom || 80) + 24;
  return { top, bottom: 110, left: 48, right: 48 };
}

function fitAll(duration = 600) {
  const b = new ml.LngLatBounds();
  for (const p of geo) b.extend([p.geo[1], p.geo[0]]);
  map.fitBounds(b, { padding: padding(), maxZoom: 13, duration });
}

function focusPhoto(id) {
  const p = geo.find((x) => x.id === id);
  if (!p) return;
  map.jumpTo({ center: [p.geo[1], p.geo[0]], zoom: 15 });
  opts.focusId = null;
}

function renderPins() {
  const b = map.getBounds();
  const wide = b.getEast() - b.getWest() >= 360;
  const bbox = wide ? [-180, -85, 180, 85] : [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const seen = new Set();
  for (const f of index.getClusters(bbox, Math.round(map.getZoom()))) {
    const { cluster, cluster_id: cid, point_count: n, i } = f.properties;
    const key = cluster ? `c${cid}` : `p${i}`;
    seen.add(key);
    if (pins.has(key)) continue;
    const cover = opts.photos[i];
    // MapLibre positions the marker element with `transform`, so the pin styling lives on a child.
    const el = document.createElement('div');
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'pin';
    pin.setAttribute('aria-label', cluster ? `${n} items` : `${cover.video ? 'Video' : 'Photo'}, ${placeLabel(cover.place)}`);
    pin.innerHTML = `<img src="${cover.thumb}" alt="" decoding="async">${cluster ? `<span>${n > 999 ? `${Math.floor(n / 1000)}k` : n}</span>` : ''}`;
    el.append(pin);
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cluster) openSheet(index.getLeaves(cid, Infinity).map((l) => opts.photos[l.properties.i]), cid, f.geometry.coordinates);
      else openSingle(cover);
    });
    pins.set(key, new ml.Marker({ element: el, anchor: 'center' }).setLngLat(f.geometry.coordinates).addTo(map));
  }
  for (const [key, marker] of pins) {
    if (!seen.has(key)) { marker.remove(); pins.delete(key); }
  }
}

// A single pin opens the viewer, browsing every photo currently on screen.
function openSingle(photo) {
  const b = map.getBounds();
  const onScreen = geo.filter((p) => b.contains([p.geo[1], p.geo[0]]));
  opts.openPhotos(onScreen.length ? onScreen : [photo], photo.id);
}

function openSheet(photos, clusterId, center) {
  photos.sort((a, b) => a.index - b.index);
  sheetList = photos;
  const places = [...new Set(photos.map((p) => p.place?.city).filter(Boolean))].slice(0, 3).join(' · ');
  const range = rangeLabel(photos[0].taken, photos[photos.length - 1].taken);
  sheet.innerHTML = `<header class="sheet-h"><div><strong>${esc(places || 'Photos')}</strong><span>${esc([itemCount(photos), range].filter(Boolean).join(' · '))}</span></div>`
    + '<button type="button" class="sheet-btn" data-act="zoom">Zoom In</button><button type="button" class="sheet-btn sheet-x" data-act="close" aria-label="Close">×</button></header>'
    + `<div class="grid grid-sheet">${photos.map((p) => tileHTML(p, true)).join('')}</div>`;
  sheet.querySelectorAll('img').forEach((img) => {
    if (img.complete && img.naturalWidth) img.classList.add('loaded');
    else img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
  });
  sheet.dataset.cluster = clusterId;
  sheet.dataset.center = JSON.stringify(center);
  sheet.hidden = false;
  sheet.scrollTop = 0;
}

function closeSheet() {
  if (sheet) sheet.hidden = true;
}

function onSheetClick(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') return closeSheet();
  if (act === 'zoom') {
    const cid = Number(sheet.dataset.cluster);
    map.easeTo({ center: JSON.parse(sheet.dataset.center), zoom: Math.min(index.getClusterExpansionZoom(cid), 17) });
    return closeSheet();
  }
  const tile = e.target.closest('.tile');
  if (!tile) return;
  e.preventDefault();
  opts.openPhotos(sheetList, tile.dataset.id);
}

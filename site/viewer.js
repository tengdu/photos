// Full-screen viewer (PhotoSwipe). Every slide ends up showing the ORIGINAL file; the 720px
// preview is only the placeholder while the original downloads/decodes.
import PhotoSwipe from 'photoswipe';
import 'photoswipe/style.css';
import { loadOriginal, peek, progress } from './original.js';
import { takenLabel, placeLabel, fileSize } from './format.js';

const saveData = !!navigator.connection?.saveData;
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
const status = new Map(); // id -> { state: 'loading' | 'done' | 'error', loaded, total }
let pswp = null;
let closing = false;
let pendingOpen = null;
let soundOn = false;
let ui = null;

export const isOpen = () => !!pswp && !closing;

export function openViewer(args) {
  if (pswp && closing) {
    pendingOpen = args; // open again once the closing animation has finished
    return;
  }
  if (pswp) {
    if (pswp.currIndex !== args.index) pswp.goTo(args.index);
    return;
  }
  create(args);
}

function create({ photos, index, thumbFor, onChange, onClosed }) {
  const dpr = window.devicePixelRatio || 1;
  pswp = new PhotoSwipe({
    dataSource: photos.map((p) => ({ src: p.src, msrc: p.thumb, width: p.w, height: p.h, alt: p.name, thumbCropped: true, photo: p })),
    index,
    bgOpacity: 1,
    showHideAnimationType: 'zoom',
    preload: saveData ? [0, 0] : [1, 1],
    initialZoomLevel: 'fit',
    // Second zoom step: the original's pixels 1:1 on screen (at least 2x the fitted size).
    secondaryZoomLevel: (z) => Math.max(z.fit * 2, 1 / dpr),
    maxZoomLevel: (z) => Math.max(z.fit * 4, 2 / dpr),
    wheelToZoom: true,
    imageClickAction: 'zoom',
    tapAction: 'toggle-controls',
    doubleTapAction: 'zoom',
    bgClickAction: 'close',
    counter: false,
    closeTitle: 'Close (Esc)',
    zoomTitle: 'Zoom',
    arrowPrevTitle: 'Previous (←)',
    arrowNextTitle: 'Next (→)',
    errorMsg: 'The original could not be displayed.',
    paddingFn: (viewport) => (viewport.x < 700 ? { top: 0, bottom: 0, left: 0, right: 0 } : { top: 64, bottom: 72, left: 16, right: 16 }),
  });

  // Always show the preview while the original loads (PhotoSwipe only does it for the first slide).
  pswp.addFilter('placeholderSrc', (src, content) => content.data.msrc || src);
  pswp.addFilter('thumbEl', (el, data) => thumbFor(data.photo.id) || el);
  pswp.addFilter('contentErrorElement', (el, content) => errorElement(content.data.photo));

  pswp.on('contentLoad', (e) => {
    const { content } = e;
    const p = content.data.photo;
    if (!p) return;
    e.preventDefault();
    const wrap = document.createElement('div');
    wrap.className = 'pswp__img orig';
    content.element = wrap;
    content.state = 'loading';
    const current = content.index === pswp.currIndex;
    if (!peek(p.id)) setStatus(p.id, { state: 'loading', loaded: 0, total: p.size });
    loadOriginal(p, { priority: current ? 'high' : 'low' })
      .then((result) => mount(wrap, p, result))
      .then(() => {
        setStatus(p.id, { state: 'done' });
        if (content.element !== wrap) return;
        content.onLoaded();
        if (pswp?.currSlide?.content === content) activateLive();
      })
      .catch((err) => {
        console.warn(`Original failed for ${p.name}:`, err);
        setStatus(p.id, { state: 'error' });
        if (content.element === wrap) content.onError();
      });
  });
  pswp.on('contentDestroy', ({ content }) => content.element?.querySelector('video')?.removeAttribute('src'));

  pswp.on('uiRegister', registerUI);
  pswp.on('change', () => {
    stopAllLive();
    onChange(pswp.currIndex);
    updateUI();
    activateLive();
  });
  pswp.on('tapAction', (e) => {
    if (press?.held) e.preventDefault();
  });
  pswp.on('close', () => {
    closing = true;
    stopAllLive();
    // Make sure the tile we zoom back into is on screen.
    thumbFor(pswp.currSlide.data.photo.id)?.scrollIntoView({ block: 'nearest' });
  });
  pswp.on('destroy', () => {
    const lastId = pswp.currSlide?.data.photo.id;
    pswp = null;
    closing = false;
    ui = null;
    removeEventListener('keydown', onKey);
    onClosed(lastId);
    if (pendingOpen) {
      const next = pendingOpen;
      pendingOpen = null;
      create(next);
    }
  });
  addEventListener('keydown', onKey);
  pswp.init();
}

export function closeViewer() {
  pswp?.close();
}

async function mount(wrap, p, result) {
  let el;
  if (result.url) {
    el = new Image();
    el.alt = p.name;
    el.src = result.url;
    await el.decode().catch(() => {});
  } else {
    el = document.createElement('canvas');
    el.width = result.width;
    el.height = result.height;
    el.getContext('2d', { colorSpace: result.colorSpace }).drawImage(result.bitmap, 0, 0);
  }
  el.className = 'orig-media';
  wrap.append(el);
  if (p.liveSrc && !p.liveFailed) {
    const video = document.createElement('video');
    video.className = 'orig-media live-video';
    video.playsInline = true;
    video.muted = true;
    video.preload = 'none';
    video.disablePictureInPicture = true;
    video.addEventListener('ended', () => setPlaying(video, false));
    video.addEventListener('error', () => {
      if (!video.getAttribute('src')) return;
      p.liveFailed = true; // this browser can't play the original .mov: show the still only
      video.remove();
      updateUI();
    });
    wrap.append(video);
    bindLongPress(wrap);
  }
}

// ---- Live Photos (original .mov) ----

function currentVideo() {
  return pswp?.currSlide?.content?.element?.querySelector('video') || null;
}

function setPlaying(video, on) {
  video.classList.toggle('playing', on);
  ui?.live.classList.toggle('on', on);
}

function playLive({ withSound = soundOn } = {}) {
  const video = currentVideo();
  if (!video) return;
  const p = pswp.currSlide.data.photo;
  if (!video.getAttribute('src')) video.src = p.liveSrc;
  video.currentTime = 0;
  video.muted = !withSound;
  video.play()
    .catch(() => {
      video.muted = true; // sound can be refused without a user gesture
      return video.play();
    })
    .then(() => setPlaying(video, true))
    .catch(() => {});
}

function stopLive() {
  const video = currentVideo();
  if (!video) return;
  video.pause();
  setPlaying(video, false);
}

function stopAllLive() {
  document.querySelectorAll('.pswp video.live-video').forEach((v) => {
    v.pause();
    v.classList.remove('playing');
  });
  ui?.live.classList.remove('on');
}

function activateLive() {
  const video = currentVideo();
  if (!video) return;
  video.preload = 'auto';
  if (!video.getAttribute('src')) video.src = pswp.currSlide.data.photo.liveSrc;
  // Like Photos: play the motion once (muted) when a Live Photo comes into view.
  const slide = pswp.currSlide;
  if (slide.currZoomLevel <= slide.zoomLevels.initial * 1.01) playLive({ withSound: false });
}

let press = null;
function bindLongPress(wrap) {
  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !currentVideo() || wrap !== pswp?.currSlide?.content?.element) return;
    const start = { x: e.clientX, y: e.clientY };
    press = { held: false, timer: setTimeout(() => { press.held = true; playLive(); }, 300) };
    const move = (ev) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 10) clearTimeout(press?.timer);
    };
    const end = () => {
      clearTimeout(press?.timer);
      if (press?.held) stopLive();
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      // Let PhotoSwipe's tap handler see `held` first, then reset.
      setTimeout(() => (press = null), 0);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  });
  wrap.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---- UI: title (top) and toolbar (bottom) ----

function registerUI() {
  pswp.ui.registerElement({
    name: 'title',
    order: 5,
    appendTo: 'bar',
    onInit: (el) => {
      el.classList.add('v-title');
      ui = { ...(ui || {}), title: el };
    },
  });
  pswp.ui.registerElement({
    name: 'toolbar',
    order: 20,
    appendTo: 'root',
    onInit: (el) => {
      el.classList.add('v-bar');
      el.innerHTML = `
        <button class="v-btn v-live" type="button" title="Play Live Photo (Space) — or press and hold the photo">${LIVE_ICON}<span>LIVE</span></button>
        <button class="v-btn v-sound" type="button" aria-pressed="false" title="Sound for Live Photos">${MUTED_ICON}</button>
        <span class="v-status" aria-live="polite"></span>
        <a class="v-btn v-download" target="_blank" rel="noopener" title="Download the original file" download>${DOWNLOAD_ICON}<span>Original</span></a>`;
      ui = {
        ...(ui || {}),
        bar: el,
        live: el.querySelector('.v-live'),
        sound: el.querySelector('.v-sound'),
        status: el.querySelector('.v-status'),
        download: el.querySelector('.v-download'),
      };
      ui.live.addEventListener('click', () => (currentVideo()?.classList.contains('playing') ? stopLive() : playLive()));
      ui.live.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && finePointer.matches && playLive());
      ui.live.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && stopLive());
      ui.sound.addEventListener('click', () => {
        soundOn = !soundOn;
        const v = currentVideo();
        if (v) v.muted = !soundOn;
        updateUI();
      });
      updateUI();
    },
  });
}

function updateUI() {
  if (!pswp || !ui?.bar) return;
  const p = pswp.currSlide?.data.photo || pswp.options.dataSource[pswp.currIndex].photo;
  const when = takenLabel(p.taken);
  const where = placeLabel(p.place);
  if (ui.title) ui.title.innerHTML = `<strong>${esc(when.date)}</strong><span>${esc([when.time, where].filter(Boolean).join(' · '))}</span>`;
  const live = !!p.liveSrc && !p.liveFailed;
  ui.live.hidden = ui.sound.hidden = !live;
  ui.sound.innerHTML = soundOn ? SOUND_ICON : MUTED_ICON;
  ui.sound.setAttribute('aria-pressed', String(soundOn));
  ui.sound.setAttribute('aria-label', soundOn ? 'Sound on' : 'Sound off');
  ui.download.href = p.src;
  renderStatus(p);
}

function setStatus(id, s) {
  status.set(id, { ...(status.get(id) || {}), ...s });
  const p = pswp?.currSlide?.data.photo;
  if (p && p.id === id) renderStatus(p);
}

progress.addEventListener('progress', ({ detail }) => setStatus(detail.id, { state: 'loading', loaded: detail.loaded, total: detail.total }));

function renderStatus(p) {
  if (!ui?.status) return;
  const s = peek(p.id) ? { state: 'done' } : status.get(p.id) || { state: 'loading', loaded: 0, total: p.size };
  const fmt = p.fmt === 'jpg' ? 'JPEG' : p.fmt.toUpperCase();
  const info = `${fmt} · ${p.w} × ${p.h} · ${fileSize(p.size)}`;
  ui.status.classList.toggle('is-loading', s.state === 'loading');
  ui.status.classList.toggle('is-error', s.state === 'error');
  if (s.state === 'done') ui.status.innerHTML = `<b>Original</b> · ${info}`;
  else if (s.state === 'error') ui.status.textContent = 'Original unavailable in this browser';
  else {
    const pct = s.total ? Math.min(99, Math.floor((100 * s.loaded) / s.total)) : 0;
    ui.status.innerHTML = `<i class="ring" style="--p:${pct}"></i> ${s.loaded >= s.total && s.total ? 'Decoding original…' : `Loading original… ${pct}%`}`;
  }
}

function errorElement(p) {
  const el = document.createElement('div');
  el.className = 'pswp__error-msg-container';
  el.innerHTML = `<div class="v-error"><p>This browser couldn't display the original file.</p>
    <a class="v-btn" href="${esc(p.src)}" target="_blank" rel="noopener" download>${DOWNLOAD_ICON}<span>Download original</span></a></div>`;
  return el;
}

function onKey(e) {
  if (!pswp || e.target.closest?.('input, textarea')) return;
  if (e.key === ' ' && currentVideo()) {
    e.preventDefault();
    currentVideo().classList.contains('playing') ? stopLive() : playLive();
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const LIVE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="9.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="1.6 2.2"/></svg>';
const SOUND_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const MUTED_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

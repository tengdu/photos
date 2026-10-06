// Library views (Years / Months / Days / All Photos), rendered as plain HTML strings.
import { thumbHashToDataURL } from 'thumbhash';
import { dayLabel, monthLabel, monthName, placeLabel, count, rangeLabel } from './format.js';

export const VIEWS = ['years', 'months', 'days', 'all'];
const TITLES = { years: 'Years', months: 'Months', days: 'Days', all: 'All Photos' };
const DENSITY_KEY = 'photos.density';
const EAGER = 18; // tiles on the first screen load with high priority

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function groupBy(photos, key) {
  const groups = [];
  let cur = null;
  for (const p of photos) {
    const k = p[key];
    if (!cur || cur.key !== k) groups.push((cur = { key: k, photos: [] }));
    cur.photos.push(p);
  }
  return groups;
}

// The most frequent places of a group, e.g. "Tulum · Cancún".
function places(photos, max = 2) {
  const n = new Map();
  for (const p of photos) if (p.place?.city) n.set(p.place.city, (n.get(p.place.city) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, max).map(([c]) => c).join(' · ');
}

const LIVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="6.4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="9.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="1.6 2.4"/></svg>';

let tileCount = 0;
const tile = (p) => tileHTML(p, tileCount++ < EAGER);

export function tileHTML(p, eager = false) {
  return `<a class="tile" href="#/photo/${p.id}" data-id="${p.id}" data-th="${p.th || ''}" data-m="${p.month}" data-d="${p.day}">`
    + `<img src="${p.thumb}" alt="${esc(p.name)}" decoding="async" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'}>`
    + (p.liveSrc ? `<span class="t-live" title="Live Photo">${LIVE}</span>` : '')
    + '</a>';
}

function card(cover, href, title, sub, n) {
  return `<a class="card" href="${href}" data-th="${cover.th || ''}">`
    + `<img src="${cover.thumb}" alt="" loading="lazy" decoding="async">`
    + `<span class="card-text"><strong>${esc(title)}</strong>${sub ? `<span>${esc(sub)}</span>` : ''}</span>`
    + `<span class="card-count">${n.toLocaleString('en-US')}</span></a>`;
}

const label = {
  day: (d) => (d === 'unknown' ? 'Unknown date' : dayLabel(d)),
  month: (m) => (m === 'unknown' ? 'Unknown date' : monthLabel(m)),
  year: (y) => (y === 'unknown' ? 'Unknown' : y),
};

const RENDER = {
  all(photos) {
    return `<div class="grid grid-all">${photos.map(tile).join('')}</div>`;
  },
  days(photos) {
    return groupBy(photos, 'day').map((g) => {
      const where = places(g.photos, 3);
      return `<section class="sec" data-key="${g.key}"><header class="sec-h"><h2>${esc(label.day(g.key))}</h2>${where ? `<p>${esc(where)}</p>` : ''}</header>`
        + `<div class="grid grid-days">${g.photos.map(tile).join('')}</div></section>`;
    }).join('');
  },
  months(photos) {
    return groupBy(photos, 'year').map((y) => `<section class="sec" data-key="${y.key}"><header class="sec-h sec-year"><h2>${esc(label.year(y.key))}</h2></header><div class="cards">`
      + groupBy(y.photos, 'month').map((m) => card(m.photos[0], `#/days/${m.key}`, m.key === 'unknown' ? 'Unknown date' : monthName(m.key), places(m.photos), m.photos.length)).join('')
      + '</div></section>').join('');
  },
  years(photos) {
    return `<div class="cards cards-years">${groupBy(photos, 'year').map((y) => card(y.photos[0], `#/months/${y.key}`, label.year(y.key), places(y.photos, 3), y.photos.length)).join('')}</div>`;
  },
};

export class Library {
  constructor({ root, title, subtitle, dock, zoom, photos }) {
    Object.assign(this, { root, title, subtitle, dock, zoom, photos, view: null });
    try { this.density = Number(localStorage.getItem(DENSITY_KEY)) || 0; } catch { this.density = 0; }
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        this.io.unobserve(el);
        if (el.dataset.th && !el.querySelector('img')?.complete) {
          try { el.style.backgroundImage = `url(${thumbHashToDataURL(fromB64(el.dataset.th))})`; } catch {}
        }
      }
    }, { rootMargin: '1200px 0px' });
    this.root.addEventListener('load', (e) => e.target.tagName === 'IMG' && e.target.classList.add('loaded'), true);
    this.zoom.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-step]');
      if (b) this.setDensity(this.density + Number(b.dataset.step));
    });
    let raf = 0;
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.updateTitle(); }); };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', () => { this.applyDensity(); onScroll(); });
  }

  show(view, anchor) {
    document.documentElement.dataset.view = view;
    if (view !== this.view) {
      this.view = view;
      tileCount = 0;
      this.root.innerHTML = this.photos.length ? RENDER[view](this.photos) : '<p class="empty">No photos yet.<br><span>Share photos from your iPhone with the “Upload to GitHub” shortcut.</span></p>';
      this.root.querySelectorAll('[data-th]').forEach((el) => this.io.observe(el));
      this.root.querySelectorAll('img').forEach((img) => img.complete && img.naturalWidth && img.classList.add('loaded'));
      this.applyDensity();
      scrollTo(0, 0);
    }
    this.zoom.hidden = view !== 'all';
    if (anchor) this.scrollToKey(anchor);
    this.updateTitle();
  }

  // The thumbnail <img> for a photo, if it's in the current view (for the zoom animation).
  thumbFor(id) {
    return this.root.querySelector(`.tile[data-id="${id}"] img`);
  }

  scrollToKey(key) {
    const target = [...this.root.querySelectorAll('[data-key], .tile[data-d]')]
      .find((el) => (el.dataset.key || el.dataset.d).startsWith(key));
    if (!target) return;
    const top = target.getBoundingClientRect().top + scrollY - this.headerHeight() - 8;
    scrollTo(0, Math.max(0, top));
  }

  headerHeight() {
    return this.title.closest('header').getBoundingClientRect().bottom;
  }

  // Large title follows the scroll position, like Photos ("October 2026").
  updateTitle() {
    if (this.root.hidden) return; // the map is showing
    const y = this.headerHeight() + 12;
    const x = Math.min(innerWidth / 2, 40);
    const el = document.elementFromPoint(x, y);
    let title = TITLES[this.view];
    let sub = '';
    if (!this.photos.length) {
      sub = '';
    } else if (this.view === 'all') {
      const t = el?.closest('.tile') || this.root.querySelector('.tile');
      title = label.month(t.dataset.m);
      sub = count(this.photos.length, 'Photo');
    } else if (this.view === 'days') {
      const sec = el?.closest('.sec') || this.root.querySelector('.sec');
      title = label.day(sec.dataset.key);
      sub = sec.querySelector('.sec-h p')?.textContent || '';
    } else if (this.view === 'months') {
      const sec = el?.closest('.sec') || this.root.querySelector('.sec');
      title = label.year(sec.dataset.key);
      sub = count(this.photos.filter((p) => p.year === sec.dataset.key).length, 'Photo');
    } else {
      sub = rangeLabel(this.photos[0].taken, this.photos[this.photos.length - 1].taken);
    }
    if (this.title.textContent !== title) this.title.textContent = title;
    if (this.subtitle.textContent !== sub) this.subtitle.textContent = sub;
  }

  setDensity(level) {
    this.density = Math.max(0, Math.min(2, level));
    try { localStorage.setItem(DENSITY_KEY, String(this.density)); } catch {}
    // Keep the photo at the top of the screen in place while the grid changes.
    const anchor = document.elementFromPoint(innerWidth / 2, this.headerHeight() + 20)?.closest('.tile');
    this.applyDensity();
    if (anchor) scrollTo(0, anchor.getBoundingClientRect().top + scrollY - this.headerHeight() - 20);
  }

  applyDensity() {
    const w = this.root.clientWidth || innerWidth;
    const phone = w < 600;
    const cols = phone ? [3, 5, 7][this.density] : Math.max(4, Math.round(w / [240, 170, 115][this.density]));
    const dayCols = phone ? 2 : Math.max(3, Math.round(w / 230));
    this.root.style.setProperty('--cols', cols);
    this.root.style.setProperty('--day-cols', dayCols);
    for (const b of this.zoom.querySelectorAll('button')) {
      b.disabled = (b.dataset.step === '1' && this.density === 2) || (b.dataset.step === '-1' && this.density === 0);
    }
  }
}

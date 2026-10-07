// Display formatting. Capture times are shown in the photo's own local time (from EXIF),
// never converted to the viewer's time zone, so every date here is formatted in UTC from
// its literal components.

const parts = (taken) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?([+-]\d{2}:\d{2})?/.exec(taken || '');
  if (!m) return null;
  return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))), hasTime: !!m[4], offset: m[7] || null };
};

const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts });
const dayFmt = fmt({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const dayShortFmt = fmt({ month: 'short', day: 'numeric' });
const monthFmt = fmt({ month: 'long', year: 'numeric' });
const monthNameFmt = fmt({ month: 'long' });
const longDateFmt = fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const timeFmt = fmt({ hour: 'numeric', minute: '2-digit' });

export const dayLabel = (day) => dayFmt.format(parts(day).date);
export const monthLabel = (month) => monthFmt.format(parts(`${month}-01`).date);
export const monthName = (month) => monthNameFmt.format(parts(`${month}-01`).date);

export function rangeLabel(newest, oldest) {
  if (!newest || !oldest) return '';
  const a = parts(oldest).date, b = parts(newest).date;
  if (oldest.slice(0, 10) === newest.slice(0, 10)) return dayFmt.format(b);
  if (oldest.slice(0, 4) === newest.slice(0, 4)) return `${dayShortFmt.format(a)} – ${dayShortFmt.format(b)}, ${newest.slice(0, 4)}`;
  return `${dayFmt.format(a)} – ${dayFmt.format(b)}`;
}

export function takenLabel(taken) {
  const p = parts(taken);
  if (!p) return { date: 'Unknown date', time: '' };
  let time = p.hasTime ? timeFmt.format(p.date) : '';
  if (time && p.offset) {
    const [h, m] = p.offset.slice(1).split(':').map(Number);
    time += ` (UTC${p.offset[0] === '-' ? '−' : '+'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''})`;
  }
  return { date: longDateFmt.format(p.date), time };
}

export const placeLabel = (place) => (place ? [place.city, place.country].filter(Boolean).join(', ') : '');

export function fileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}

export const megapixels = (w, h) => `${Math.round((w * h) / 1e6)} MP`;
export const count = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** "1,234 Photos, 56 Videos" (a part that would be 0 is left out). */
export function itemCount(items) {
  const videos = items.filter((p) => p.video).length;
  const photos = items.length - videos;
  return [(photos || !videos) && count(photos, 'Photo'), videos && count(videos, 'Video')].filter(Boolean).join(', ');
}

/** Like Photos: "2 Photos", "1 Video", or "3 Items" for a mix. */
export function itemsLabel(items) {
  const videos = items.filter((p) => p.video).length;
  if (!videos) return count(items.length, 'Photo');
  return count(items.length, videos === items.length ? 'Video' : 'Item');
}

/** Video length: "0:07", "12:45", "1:02:03". */
export function duration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const hms = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  return hms[0] ? `${hms[0]}:${String(hms[1]).padStart(2, '0')}:${String(hms[2]).padStart(2, '0')}` : `${hms[1]}:${String(hms[2]).padStart(2, '0')}`;
}

/** "4K", "1080p", "720p" by the shorter side; otherwise the size. */
export function resolution(w, h) {
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  if (long >= 3800 && short >= 2100) return '4K';
  for (const p of [1080, 720, 480]) if (Math.abs(short - p) <= 8 && long >= p * 1.7) return `${p}p`;
  return `${w} × ${h}`;
}

export function exposure(sec) {
  if (!sec) return '';
  if (sec >= 1) return `${+sec.toFixed(1)} s`;
  return `1/${Math.round(1 / sec)} s`;
}

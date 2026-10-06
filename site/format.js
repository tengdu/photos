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

export function exposure(sec) {
  if (!sec) return '';
  if (sec >= 1) return `${+sec.toFixed(1)} s`;
  return `1/${Math.round(1 / sec)} s`;
}

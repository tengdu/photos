// Changing capture times (select.js writes them into the files). Times are the photo's own local
// time, "2026-10-04T14:23:24-05:00", handled as wall-clock values in UTC (as in format.js). Until the
// site has been rebuilt, this device remembers the new times so they show at once.
const EDITS_KEY = 'photos.dateEdits';
const KEEP_MS = 30 * 60 * 1000;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Photos whose files lib/exif-date.js can write the date into. */
export const canSetDate = (p) => !p.video && ['jpg', 'jpeg', 'heic', 'heif'].includes(p.fmt);

/** { wall: ms (the local time as if it were UTC), offset: "-05:00" | null }, or null. */
export function parseTaken(taken) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?([+-]\d{2}:\d{2})?$/.exec(taken || '');
  if (!m) return null;
  return { wall: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)), offset: m[7] || null };
}

const iso = (wall) => new Date(wall).toISOString().slice(0, 19); // "2026-10-04T14:23:24"
export const inputValue = iso; // for <input type="datetime-local" step="1">
export const takenString = (wall, offset) => `${iso(wall)}${offset || ''}`;
export const exifString = (wall) => iso(wall).replace(/-/g, ':').replace('T', ' '); // "2026:10:04 14:23:24"

const instant = (taken) => {
  const t = parseTaken(taken);
  if (!t) return -Infinity;
  const [h, m] = (t.offset || '+00:00').slice(1).split(':').map(Number);
  return t.wall - (t.offset?.[0] === '-' ? -1 : 1) * (h * 60 + m) * 60000;
};

/** Library order (newest first), as the build sorts. */
export const newestFirst = (a, b) => instant(b.taken) - instant(a.taken) || (a.path < b.path ? 1 : -1);

/** This device's time zone at a wall time, e.g. "+02:00". */
export function deviceOffset(wall) {
  const d = new Date(wall);
  const minutes = -new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()).getTimezoneOffset();
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

// The UTC offsets in use somewhere.
export const OFFSETS = [
  '-12:00', '-11:00', '-10:00', '-09:30', '-09:00', '-08:00', '-07:00', '-06:00', '-05:00', '-04:00', '-03:30',
  '-03:00', '-02:00', '-01:00', '+00:00', '+01:00', '+02:00', '+03:00', '+03:30', '+04:00', '+04:30', '+05:00',
  '+05:30', '+05:45', '+06:00', '+06:30', '+07:00', '+08:00', '+08:45', '+09:00', '+09:30', '+10:00', '+10:30',
  '+11:00', '+12:00', '+12:45', '+13:00', '+14:00',
];
export const offsetLabel = (o) => `UTC${o[0] === '-' ? '−' : '+'}${o.slice(1)}`;

/** "2 days 3 h later", "3 years 121 days earlier", or "" for no change. */
export function shiftLabel(ms) {
  let s = Math.round(Math.abs(ms) / 1000);
  if (!s) return '';
  const parts = [[365 * 86400, 'year'], [86400, 'day'], [3600, 'h'], [60, 'min'], [1, 's']].map(([n, unit]) => {
    const v = Math.floor(s / n);
    s %= n;
    return v ? `${v} ${unit}${v !== 1 && (unit === 'year' || unit === 'day') ? 's' : ''}` : '';
  }).filter(Boolean);
  return `${parts.slice(0, 2).join(' ')} ${ms > 0 ? 'later' : 'earlier'}`;
}

function recentEdits() {
  let map = {};
  try { map = JSON.parse(localStorage.getItem(EDITS_KEY) || '{}') || {}; } catch {}
  const now = Date.now();
  for (const [path, e] of Object.entries(map)) if (!(now - e.t < KEEP_MS)) delete map[path];
  return map;
}

export function rememberDateEdits(changes) {
  const map = recentEdits();
  for (const { path, taken } of changes) map[path] = { taken, t: Date.now() };
  try { localStorage.setItem(EDITS_KEY, JSON.stringify(map)); } catch {}
}

/** photos.json items with this device's recent changes applied, in library order. */
export function withRecentDates(items) {
  const edits = recentEdits();
  if (!Object.keys(edits).length) return items;
  return items
    .map((it) => (edits[it.path] ? { ...it, taken: edits[it.path].taken, undated: undefined } : it))
    .sort(newestFirst);
}

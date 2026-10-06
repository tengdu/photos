// Offline place names from GeoNames "cities15000" (CC BY 4.0, https://www.geonames.org/),
// without neighbourhood entries (feature code PPLX) and historical places.
// A photo is labelled with the city it is "most inside": distance divided by the city's rough
// radius (∝ √population). So the Space Needle is "Seattle", while downtown Bellevue is "Bellevue".
import { readFileSync } from 'node:fs';

const MAX_KM = 80;
const COUNTRY_ONLY_KM = 400;
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

let cities;
function load() {
  if (cities) return cities;
  const tsv = readFileSync(new URL('./geo/cities15000.tsv', import.meta.url), 'utf8');
  cities = tsv.split('\n').filter(Boolean).map((line) => {
    const [name, cc, lat, lon, pop] = line.split('\t');
    return { name, cc, lat: +lat, lon: +lon, pop: +pop };
  });
  return cities;
}

function km(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

const country = (cc) => {
  try { return regionNames.of(cc) || cc; } catch { return cc; }
};

/** { city, country, cc } for a coordinate, or null when nowhere near a city. */
export function placeFor(lat, lon) {
  let best = null, bestScore = Infinity, nearest = null, nearestKm = Infinity;
  for (const c of load()) {
    if (Math.abs(c.lat - lat) > 4) continue; // cheap pre-filter (~440 km)
    const d = km(lat, lon, c.lat, c.lon);
    if (d < nearestKm) { nearestKm = d; nearest = c; }
    if (d > MAX_KM) continue;
    const radius = Math.max(1, 0.009 * Math.sqrt(c.pop)); // ≈ 8 km for Seattle, 3.5 km for Bellevue
    const score = d / radius;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  if (best) return { city: best.name, country: country(best.cc), cc: best.cc };
  if (nearest && nearestKm <= COUNTRY_ONLY_KM) return { city: null, country: country(nearest.cc), cc: nearest.cc };
  return null;
}

// Loads MapLibre GL on demand from the copy shipped in assets/ (its worker and shared module
// sit next to it, so the map's ~300 KB of compressed code is only fetched when a map is shown).
/* global __MAPLIBRE__ */

let lib;
export function loadMaplibre() {
  lib ??= (async () => {
    const base = new URL(__MAPLIBRE__, document.baseURI).href;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${base}maplibre-gl.css`;
    document.head.append(css);
    return import(/* @vite-ignore */ `${base}maplibre-gl.mjs`);
  })();
  lib.catch(() => (lib = null));
  return lib;
}

const dark = matchMedia('(prefers-color-scheme: dark)');
export const mapStyle = () => `https://tiles.openfreemap.org/styles/${dark.matches ? 'dark' : 'positron'}`;
export const onSchemeChange = (fn) => dark.addEventListener('change', fn);

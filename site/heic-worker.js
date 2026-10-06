// Decodes an original HEIC file for browsers without native HEIC support (e.g. Chrome).
// 1. WebCodecs: the browser's hardware HEVC decoder (~0.1–0.5 s for 12–24 MP).
// 2. Fallback: libheif compiled to WASM (several seconds), loaded only when needed.
// Either way the result is upright (the file's rotation/mirroring is applied).

/* global __LIBHEIF_WASM__ */
import libheif from 'libheif-js/libheif-wasm/libheif.js';
import { parseHeif, primaryColorSpace } from './lib/heif.js';
import { decodeWithWebCodecs } from './lib/heic-webcodecs.js';

let lib;
const getLib = () => (lib ??= Promise.resolve(libheif({ locateFile: () => new URL(__LIBHEIF_WASM__, self.location.href).href })));
let webCodecsUsable = typeof VideoDecoder !== 'undefined';

self.onmessage = async ({ data: { id, buffer } }) => {
  const started = performance.now();
  try {
    const bytes = new Uint8Array(buffer);
    const heif = parseHeif(bytes);
    const colorSpace = primaryColorSpace(heif);
    let result = null;
    let fallbackReason = null;
    if (webCodecsUsable) {
      try {
        const { canvas, width, height } = await decodeWithWebCodecs(heif, { colorSpace });
        result = { bitmap: canvas.transferToImageBitmap(), width, height, method: 'webcodecs' };
      } catch (e) {
        fallbackReason = String(e?.message || e);
        if (/not available|not supported/.test(fallbackReason)) webCodecsUsable = false;
      }
    }
    result ??= { ...(await decodeWithLibheif(bytes, colorSpace)), method: 'libheif' };
    const ms = Math.round(performance.now() - started);
    self.postMessage({ id, ...result, colorSpace, timing: { method: result.method, ms, fallbackReason } }, [result.bitmap]);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};

async function decodeWithLibheif(bytes, colorSpace) {
  const L = await getLib();
  const decoder = new L.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(bytes);
    const image = images.find((i) => i.is_primary()) || images[0];
    if (!image) throw new Error('No image found in the HEIC file');
    const width = image.get_width();
    const height = image.get_height();
    const pixels = new ImageData(width, height, { colorSpace });
    await new Promise((resolve, reject) => image.display(pixels, (d) => (d ? resolve() : reject(new Error('HEIC decoding failed')))));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d', { colorSpace }).putImageData(pixels, 0, 0);
    return { bitmap: canvas.transferToImageBitmap(), width, height };
  } finally {
    // Free the WASM-side memory right away; a 24 MP photo holds ~100 MB.
    images.forEach((i) => i.free());
    if (decoder.decoder) {
      L.heif_context_free(decoder.decoder);
      decoder.decoder = null;
    }
  }
}

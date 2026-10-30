/**
 * Pure image metrics on the final tone-mapped sRGB output (a captured PNG,
 * never a linear render-target readback): RL1 spike checks and, from M3.4,
 * the still-render noise gate. No three.js, no DOM.
 */

/** Noise ceiling for a "Render still" at 32 spp (M3.4; RL1b measured 1.94 at 64 spp, 0.20 denoised). */
export const STILL_NOISE_MAX = 4;

/** An RGBA8 raster, row-major, top-left origin (same shape as `app/e2e/bar/png.ts` `Image`). */
export interface Raster {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** Pixel rectangle `[x0, y0, x1, y1)`, clamped to the raster. */
export type Rect = readonly [number, number, number, number];

export type PixelTest = (r: number, g: number, b: number) => boolean;

function clampRect(img: Raster, rect?: Rect): [number, number, number, number] {
  const [x0, y0, x1, y1] = rect ?? [0, 0, img.width, img.height];
  const c = (v: number, hi: number) => Math.max(0, Math.min(hi, Math.round(v)));
  return [c(x0, img.width), c(y0, img.height), c(x1, img.width), c(y1, img.height)];
}

/** HSV of an sRGB8 colour: hue in degrees [0, 360), saturation and value in [0, 1]. */
export function hsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

/** Parachute nylon orange as rendered (lit or shadowed, seen bare or through clear polycarbonate). */
export const isOrange: PixelTest = (r, g, b) => {
  const c = hsv(r, g, b);
  return c.h >= 8 && c.h <= 42 && c.s >= 0.45 && c.v >= 0.25;
};

/** The selection outline teal (`#61b5ad`, boosted by the additive composite). */
export const isTeal: PixelTest = (r, g, b) => {
  const c = hsv(r, g, b);
  return c.h >= 160 && c.h <= 190 && c.s >= 0.3 && c.v >= 0.45;
};

/** Pixels inside `rect` that pass `test`. */
export function countPixels(img: Raster, test: PixelTest, rect?: Rect): number {
  const [x0, y0, x1, y1] = clampRect(img, rect);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      if (test(img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0)) n++;
    }
  }
  return n;
}

/**
 * Stroke width of the pixels passing `test`: for each such pixel, the shorter
 * of its horizontal and vertical runs; the median over all pixels. For a line
 * at angle θ that is w / max(|sin θ|, |cos θ|), so it lies in [w, w·√2].
 * Null when no pixel passes.
 */
export function strokeWidth(img: Raster, test: PixelTest, rect?: Rect): number | null {
  const [x0, y0, x1, y1] = clampRect(img, rect);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y + y0) * img.width + (x + x0)) * 4;
      mask[y * w + x] = test(img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0) ? 1 : 0;
    }
  }
  const hRun = new Uint16Array(w * h);
  const vRun = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!mask[y * w + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < w && mask[y * w + e]) e++;
      for (let k = x; k < e; k++) hRun[y * w + k] = e - x;
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!mask[y * w + x]) {
        y++;
        continue;
      }
      let e = y;
      while (e < h && mask[e * w + x]) e++;
      for (let k = y; k < e; k++) vRun[k * w + x] = e - y;
      y = e;
    }
  }
  const runs: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) runs.push(Math.min(hRun[i] ?? 0, vRun[i] ?? 0));
  if (runs.length === 0) return null;
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)] ?? null;
}

const luma = (img: Raster, i: number) => 0.2126 * (img.data[i] ?? 0) + 0.7152 * (img.data[i + 1] ?? 0) + 0.0722 * (img.data[i + 2] ?? 0);

/**
 * High-frequency noise: the mean absolute difference between each pixel's
 * luma and the mean of its four neighbours, in 8-bit luma units, over pixels
 * whose neighbourhood is smooth enough not to be an edge (`edge` = the
 * largest neighbour-to-neighbour luma spread still counted). Lower is
 * smoother; a converged or denoised still scores near 0, path-tracing grain
 * a few units.
 */
export function noiseMetric(img: Raster, rect?: Rect, edge = 24): { noise: number; pixels: number } {
  const [x0, y0, x1, y1] = clampRect(img, rect);
  let sum = 0;
  let n = 0;
  for (let y = Math.max(1, y0); y < Math.min(img.height - 1, y1); y++) {
    for (let x = Math.max(1, x0); x < Math.min(img.width - 1, x1); x++) {
      const i = (y * img.width + x) * 4;
      const nb = [luma(img, i - 4), luma(img, i + 4), luma(img, i - img.width * 4), luma(img, i + img.width * 4)];
      if (Math.max(...nb) - Math.min(...nb) > edge) continue;
      sum += Math.abs(luma(img, i) - (nb[0]! + nb[1]! + nb[2]! + nb[3]!) / 4);
      n++;
    }
  }
  return { noise: n === 0 ? 0 : sum / n, pixels: n };
}

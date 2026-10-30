/**
 * Side-by-side composition for the RL5 spike captures (pure; RGBA images
 * from `app/e2e/bar/png.ts`). Crops, bilinear resizes, letterboxes, and
 * lays tiles out in a grid with a gutter.
 */
import type { Image } from "../../../../e2e/bar/png.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BG: readonly [number, number, number] = [14, 16, 18];

export function blank(width: number, height: number, rgb: readonly [number, number, number] = BG): Image {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return { width, height, data };
}

/** Crops `r` (clamped to the image; integer pixels). */
export function crop(img: Image, r: Rect): Image {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(img.width, Math.ceil(r.x + r.w));
  const y1 = Math.min(img.height, Math.ceil(r.y + r.h));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = blank(w, h);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.data.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return out;
}

/** Bilinear resize to `width` x `height`. */
export function resize(img: Image, width: number, height: number): Image {
  const out = blank(width, height);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c]!;
        const b = img.data[(y0 * img.width + x1) * 4 + c]!;
        const d = img.data[(y1 * img.width + x0) * 4 + c]!;
        const e = img.data[(y1 * img.width + x1) * 4 + c]!;
        out.data[(y * width + x) * 4 + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
      }
    }
  }
  return out;
}

/** Scales `img` to fit inside `width` x `height` (aspect kept), centred on the background. */
export function fit(img: Image, width: number, height: number): Image {
  const k = Math.min(width / img.width, height / img.height);
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const out = blank(width, height);
  paste(out, resize(img, w, h), Math.floor((width - w) / 2), Math.floor((height - h) / 2));
  return out;
}

export function paste(dst: Image, src: Image, x: number, y: number): void {
  for (let row = 0; row < src.height; row++) {
    const ty = y + row;
    if (ty < 0 || ty >= dst.height) continue;
    for (let col = 0; col < src.width; col++) {
      const tx = x + col;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (row * src.width + col) * 4;
      dst.data.set(src.data.subarray(s, s + 4), (ty * dst.width + tx) * 4);
    }
  }
}

/** Rows of equally sized tiles, `gutter` px apart. */
export function grid(rows: readonly (readonly Image[])[], gutter = 16): Image {
  const tw = Math.max(...rows.flat().map((t) => t.width));
  const th = Math.max(...rows.flat().map((t) => t.height));
  const cols = Math.max(...rows.map((r) => r.length));
  const out = blank(cols * tw + (cols + 1) * gutter, rows.length * th + (rows.length + 1) * gutter);
  rows.forEach((r, i) => r.forEach((t, j) => paste(out, t, gutter + j * (tw + gutter), gutter + i * (th + gutter))));
  return out;
}

/** Grows `r` by `margin` (fraction) and to the aspect `w/h`, about its centre. */
export function frameRect(r: Rect, aspect: number, margin = 0.25): Rect {
  let w = r.w * (1 + 2 * margin);
  let h = r.h * (1 + 2 * margin);
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
}

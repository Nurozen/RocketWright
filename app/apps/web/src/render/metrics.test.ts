import { describe, expect, it } from "vitest";
import { countPixels, hsv, isOrange, isTeal, noiseMetric, strokeWidth, type Raster } from "./metrics.ts";

function raster(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** Deterministic pseudo-random grain in [-a, a]. */
const grain = (x: number, y: number, a: number) => ((((x * 73856093) ^ (y * 19349663)) >>> 0) % (2 * a + 1)) - a;

describe("image metrics", () => {
  it("hsv and the colour classes", () => {
    expect(hsv(255, 0, 0)).toEqual({ h: 0, s: 1, v: 1 });
    expect(hsv(0, 255, 255).h).toBe(180);
    expect(isOrange(0xe8, 0x73, 0x2a)).toBe(true);
    expect(isOrange(0x8a, 0x48, 0x22)).toBe(true); // shadowed nylon
    expect(isOrange(0xe8, 0xe8, 0xe4)).toBe(false); // white composite
    expect(isTeal(0x61, 0xb5, 0xad)).toBe(true);
    expect(isTeal(0x9e, 0xff, 0xf6)).toBe(true); // additive outline over a bright part
    expect(isTeal(0x1b, 0x1e, 0x20)).toBe(false); // viewport background
    expect(isTeal(0xd9, 0xee, 0xf0)).toBe(false); // clear polycarbonate tint
  });

  it("counts pixels in a rect", () => {
    const img = raster(10, 10, (x) => (x < 4 ? [0xe8, 0x73, 0x2a] : [20, 20, 20]));
    expect(countPixels(img, isOrange)).toBe(40);
    expect(countPixels(img, isOrange, [2, 0, 10, 5])).toBe(10);
  });

  it("strokeWidth reads the width of axis-aligned and diagonal strokes", () => {
    const vertical = raster(40, 40, (x) => (x >= 10 && x < 12 ? [0x61, 0xb5, 0xad] : [0, 0, 0]));
    expect(strokeWidth(vertical, isTeal)).toBe(2);
    const ring = raster(60, 60, (x, y) => {
      const d = Math.hypot(x - 30, y - 30);
      return d >= 20 && d < 23 ? [0x61, 0xb5, 0xad] : [0, 0, 0];
    });
    const w = strokeWidth(ring, isTeal)!;
    expect(w).toBeGreaterThanOrEqual(3);
    expect(w).toBeLessThanOrEqual(Math.ceil(3 * Math.SQRT2));
    expect(strokeWidth(raster(5, 5, () => [0, 0, 0]), isTeal)).toBeNull();
  });

  it("noiseMetric: flat and smooth gradients score ~0, grain scores higher, edges are skipped", () => {
    expect(noiseMetric(raster(32, 32, () => [128, 128, 128])).noise).toBe(0);
    expect(noiseMetric(raster(32, 32, (x) => [x * 4, x * 4, x * 4])).noise).toBeCloseTo(0, 6);
    const grainy = noiseMetric(raster(32, 32, (x, y) => Array(3).fill(128 + grain(x, y, 8)) as [number, number, number]));
    expect(grainy.noise).toBeGreaterThan(2);
    const edge = noiseMetric(raster(32, 32, (x) => (x < 16 ? [0, 0, 0] : [255, 255, 255])));
    expect(edge.noise).toBe(0);
    expect(edge.pixels).toBeLessThan(30 * 30);
  });
});

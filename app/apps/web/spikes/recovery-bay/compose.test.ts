/** RL5 spike composition helpers (pure image ops for the side-by-side captures). */
import { describe, expect, it } from "vitest";
import { blank, crop, fit, frameRect, grid, resize } from "./compose.ts";

const px = (img: { width: number; data: Uint8Array }, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

describe("spike composition", () => {
  it("crops (clamped), resizes, and letterboxes", () => {
    const img = blank(10, 10, [200, 0, 0]);
    img.data.set([0, 200, 0, 255], (2 * 10 + 3) * 4);
    const c = crop(img, { x: 3, y: 2, w: 4, h: 30 });
    expect([c.width, c.height]).toEqual([4, 8]);
    expect(px(c, 0, 0)).toEqual([0, 200, 0, 255]);
    const r = resize(blank(4, 4, [10, 20, 30]), 9, 5);
    expect([r.width, r.height]).toEqual([9, 5]);
    expect(px(r, 4, 2)).toEqual([10, 20, 30, 255]);
    const f = fit(blank(20, 10, [255, 255, 255]), 40, 40);
    expect(px(f, 20, 2)).toEqual([14, 16, 18, 255]);
    expect(px(f, 20, 20)).toEqual([255, 255, 255, 255]);
  });

  it("frames a rect to an aspect with margin and lays out a grid", () => {
    const r = frameRect({ x: 100, y: 100, w: 40, h: 20 }, 4 / 3, 0.25);
    expect(r.w / r.h).toBeCloseTo(4 / 3, 9);
    expect(r.x + r.w / 2).toBeCloseTo(120, 9);
    expect(r.w).toBeGreaterThanOrEqual(60);
    const g = grid([[blank(10, 8), blank(10, 8)], [blank(10, 8)]], 2);
    expect([g.width, g.height]).toEqual([2 * 10 + 3 * 2, 2 * 8 + 3 * 2]);
  });
});

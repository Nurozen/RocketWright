/** Camera auto-fit placement (fit.ts): largest clear scale and alignment. */
import { describe, expect, it } from "vitest";
import { alignOffset, fitPlacement, footprintClear, unionRect, type FitRect } from "./fit.ts";

// A diagonal "rocket" footprint from (0, 0) to (100, 100), slices of 10 px.
const diag: FitRect[] = Array.from({ length: 10 }, (_, i) => ({ x: i * 10, y: i * 10, w: 12, h: 12 }));

describe("fit placement", () => {
  it("uses the full rect when nothing is in the way", () => {
    const p = fitPlacement(diag, { x: 0, y: 0, w: 220, h: 330 }, [], 0);
    expect(p.clear).toBe(true);
    expect(p.scale).toBeCloseTo(220 / 102, 9);
    expect(p.ax).toBe(0.5);
  });

  it("keeps clear of an inspector at the top right and lets the aft end pass under it", () => {
    const rect = { x: 0, y: 0, w: 400, h: 400 };
    const inspector = { x: 300, y: 0, w: 100, h: 200 };
    const p = fitPlacement(diag, rect, [inspector], 4);
    expect(p.clear).toBe(true);
    // The diagonal misses the inspector corner even at full size: the slices cross x = 300 below y = 200.
    expect(p.scale).toBeGreaterThan(3);
    const b = unionRect(diag)!;
    const s = p.scale;
    const scaled = diag.map((r) => ({ x: (r.x - b.x) * s, y: (r.y - b.y) * s, w: r.w * s, h: r.h * s }));
    const [tx, ty] = alignOffset({ x: 0, y: 0, w: b.w * s, h: b.h * s }, rect, p.ax, p.ay);
    expect(footprintClear(scaled, tx, ty, [inspector], 4)).toBe(true);
  });

  it("shrinks only as far as needed when the occluder blocks the full size", () => {
    const rect = { x: 0, y: 0, w: 400, h: 400 };
    // An anti-diagonal footprint runs into a top-right occluder at full size.
    const anti: FitRect[] = Array.from({ length: 10 }, (_, i) => ({ x: i * 10, y: 90 - i * 10, w: 12, h: 12 }));
    const p = fitPlacement(anti, rect, [{ x: 300, y: 0, w: 100, h: 100 }], 0);
    expect(p.clear).toBe(true);
    expect(p.scale).toBeLessThan(4);
    expect(p.scale).toBeGreaterThan(2.5);
  });

  it("reports no clear placement when the occluder covers the rect", () => {
    const p = fitPlacement(diag, { x: 0, y: 0, w: 100, h: 100 }, [{ x: -10, y: -10, w: 200, h: 200 }], 0);
    expect(p.clear).toBe(false);
    expect(fitPlacement([], { x: 0, y: 0, w: 1, h: 1 }, [], 0).clear).toBe(true);
  });
});

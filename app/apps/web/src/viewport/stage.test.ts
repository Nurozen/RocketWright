import { describe, expect, it } from "vitest";
import { bakeStage, blur, gaussianKernel, poolCss, POOL_GRADIENT, projectToFloor, rasterCoverage, STAGE_LOOK, stageGrid, stageRGBA } from "./stage.ts";

/** Triangles of an axis-aligned box (world), 12 per box. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[] {
  const p = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const f = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1],
    [3, 2, 6], [3, 6, 7], [1, 5, 6], [1, 6, 2], [0, 3, 7], [0, 7, 4],
  ];
  return f.flatMap((t) => t.flatMap((i) => p[i]!));
}

/** An exploded stack of tubes along +x (radius 0.027 m, 0.03 m gaps), like page 01's. */
function stack(): Float32Array {
  const r = 0.027;
  const out: number[] = [];
  let x = 0;
  for (const len of [0.15, 0.11, 0.3, 0.1, 0.2, 0.11]) {
    out.push(...box(x, x + len, -r, r, -r, r));
    x += len + 0.03;
  }
  return Float32Array.from(out);
}

/** Largest step between neighbouring cells, and the shadow's half-width past the body edge at the stack's middle. */
function measure(shadow: Float32Array, nx: number, nz: number): { maxStep: number; peak: number } {
  let maxStep = 0;
  let peak = 0;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const v = shadow[j * nx + i]!;
      peak = Math.max(peak, v);
      if (i + 1 < nx) maxStep = Math.max(maxStep, Math.abs(v - shadow[j * nx + i + 1]!));
      if (j + 1 < nz) maxStep = Math.max(maxStep, Math.abs(v - shadow[(j + 1) * nx + i]!));
    }
  return { maxStep, peak };
}

describe("studio floor bake (BC5 contact shadow)", () => {
  it("projects along the light onto the floor", () => {
    expect(projectToFloor(1, 0, 2, -1, [0, -1, 0])).toEqual([1, 2]);
    const [x, z] = projectToFloor(0, 0, 0, -1, [0.5, -1, 0.25]);
    expect(x).toBeCloseTo(0.5, 12);
    expect(z).toBeCloseTo(0.25, 12);
  });

  it("uses a fixed square grid around the footprint", () => {
    const g = stageGrid(0, 1, -0.1, 0.1, 0.2, 128);
    expect(g.nx).toBe(128);
    expect(g.nz).toBe(128);
    expect(g.cell).toBeCloseTo(1.4 / 128, 12);
    expect(g.x0 + (g.nx * g.cell) / 2).toBeCloseTo(0.5, 12);
    expect(g.z0 + (g.nz * g.cell) / 2).toBeCloseTo(0, 12);
  });

  it("rasterises projected triangles into coverage", () => {
    const g = stageGrid(0, 1, 0, 1, 0, 10);
    const tri = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const c = rasterCoverage(tri, -1, [0, -1, 0], g);
    // Lower-left triangle: cell (0, 0) covered, (9, 9) not.
    expect(c[0]).toBe(1);
    expect(c[99]).toBe(0);
    const covered = c.reduce((a, b) => a + b, 0);
    expect(covered).toBeGreaterThan(40);
    expect(covered).toBeLessThan(65);
  });

  it("blurs with a normalised kernel", () => {
    const k = gaussianKernel(2);
    expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const a = new Float32Array(21 * 21);
    a[10 * 21 + 10] = 1;
    const b = blur(a, 21, 21, 2);
    expect(b.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 4);
    expect(b[10 * 21 + 10]).toBeLessThan(0.05);
  });

  it("bakes one broad, soft shadow under the stack: no hard per-part fringe", () => {
    const r = 0.027;
    const bake = bakeStage(stack(), -2.5 * r, r)!;
    expect(bake).not.toBeNull();
    const { grid, shadow } = bake;
    const m = measure(shadow, grid.nx, grid.nz);
    // Soft: a few hundredths between neighbouring cells (about 5 mm; a screen pixel sees less), though the parts have hard edges.
    expect(m.maxStep).toBeLessThan(0.08);
    expect(m.peak).toBeGreaterThan(0.35);
    expect(m.peak).toBeLessThan(0.9);
    // Spread: across the stack's middle, the shadow reaches well past the body (two body radii and more).
    const midX = Math.floor((0.5 - grid.x0) / grid.cell);
    const [, zc] = projectToFloor(0.5, 0, 0, -2.5 * r, STAGE_LOOK.light);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < grid.nz; j++) {
      if (shadow[j * grid.nx + midX]! > 0.05) {
        const z = grid.z0 + (j + 0.5) * grid.cell;
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
    }
    expect(hi - zc).toBeGreaterThan(2 * r);
    expect(zc - lo).toBeGreaterThan(2 * r);
    // The gaps between parts do not punch holes into the pool of shade.
    const row = Math.floor((zc - grid.z0) / grid.cell);
    const gapX = Math.floor((0.165 - grid.x0) / grid.cell);
    expect(shadow[row * grid.nx + gapX]!).toBeGreaterThan(0.6 * shadow[row * grid.nx + midX]!);
  });

  it("fades to nothing at the floor's edge (no quad border)", () => {
    const r = 0.027;
    const bake = bakeStage(stack(), -2.5 * r, r)!;
    const { grid, rgba } = bake;
    for (let i = 0; i < grid.nx; i++) {
      expect(rgba[i * 4 + 3]).toBe(0);
      expect(rgba[((grid.nz - 1) * grid.nx + i) * 4 + 3]).toBe(0);
      expect(rgba[(i * grid.nx) * 4 + 3]).toBe(0);
    }
    // Black: only alpha carries the shadow.
    for (let i = 0; i < rgba.length; i += 4) expect(rgba[i]! + rgba[i + 1]! + rgba[i + 2]!).toBe(0);
    expect(stageRGBA(new Float32Array(4).fill(1), { x0: 0, z0: 0, cell: 1, nx: 2, nz: 2 })[3]).toBeGreaterThan(0);
  });

  it("centres the light pool on the model and keeps it subtle", () => {
    const r = 0.027;
    const bake = bakeStage(stack(), -2.5 * r, r)!;
    expect(bake.pool.cx).toBeGreaterThan(0.4);
    expect(bake.pool.cx).toBeLessThan(0.75);
    expect(bake.pool.rx).toBeGreaterThan(bake.pool.rz);
    expect(Math.max(...POOL_GRADIENT.map(([, a]) => a))).toBeLessThan(0.12);
    expect(POOL_GRADIENT.at(-1)![1]).toBe(0);
    expect(poolCss()).toMatch(/^radial-gradient\(closest-side, rgba\(255, 255, 255, 0\.1\) 0%/);
  });

  it("returns null without geometry", () => {
    expect(bakeStage(new Float32Array(0), 0, 0.027)).toBeNull();
  });
});

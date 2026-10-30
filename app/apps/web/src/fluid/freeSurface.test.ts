/**
 * FID2-06: the page 06 liquid's free surface, pure: the volume-true plane
 * offset for a fill fraction, and the plane fitted over a particle top layer
 * (level when settled, tilted when the particles slosh, clamped). R20-06:
 * the drawn surface is that plane plus a gentle, capped, smooth ripple, and
 * the drawn liquid keeps the fill fraction within 5%.
 */
import { describe, expect, it } from "vitest";
import {
  angleBetween,
  belowPlane,
  drawnFill,
  easeNormal,
  fitSurface,
  fitSurfaceNormal,
  lateralBasis,
  MAX_TILT,
  planeOffsetForFill,
  RIPPLE_CAP,
  RIPPLE_MIN_WAVELENGTH,
  rippleMaxSlope,
  tankLattice,
  upOf,
  waveAmplitude,
  waveHeight,
  waveTrains,
} from "./freeSurface.ts";
import { fluidGrid, seedSettled, tankShape, type Vec3 } from "./tankSdf.ts";

const TANK = { length: 0.4112, od: 0.1524, wall: 0.003, end_cap: "hemispherical" as const };
const angle = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))));
const deg = (r: number) => (r * 180) / Math.PI;
/** Unit vector tilted from `u` by `rad` toward `toward` (orthogonalized). */
function tilt(u: Vec3, toward: Vec3, rad: number): Vec3 {
  const d = u[0] * toward[0] + u[1] * toward[1] + u[2] * toward[2];
  const t: Vec3 = [toward[0] - d * u[0], toward[1] - d * u[1], toward[2] - d * u[2]];
  const l = Math.hypot(...t);
  return [u[0] * Math.cos(rad) + (t[0] / l) * Math.sin(rad), u[1] * Math.cos(rad) + (t[1] / l) * Math.sin(rad), u[2] * Math.cos(rad) + (t[2] / l) * Math.sin(rad)];
}

describe("free surface plane", () => {
  const s = tankShape(TANK);
  const g = fluidGrid(s, 0.6);
  const lattice = tankLattice(s);

  it("lattice fills the tank evenly; the plane offset holds the fill fraction", () => {
    expect(lattice.length / 3).toBeGreaterThan(9000);
    const up = upOf([-6.30359, 0, 7.51233]);
    for (const fill of [0.6, 0.3, 0.05]) {
      const d = planeOffsetForFill(lattice, up, fill);
      // Check against an independent (finer, shifted) lattice.
      const check = tankLattice(s, 30000);
      let below = 0;
      for (let i = 0; i < check.length / 3; i++) if (belowPlane({ normal: up, offset: d }, [check[i * 3]!, check[i * 3 + 1]!, check[i * 3 + 2]!])) below++;
      expect(Math.abs(below / (check.length / 3) - fill)).toBeLessThan(0.015);
    }
    expect(planeOffsetForFill(lattice, [0, 0, 1], 0.5)).toBeCloseTo(0, 2);
    expect(planeOffsetForFill(lattice, [0, 0, 1], 0)).toBeLessThan(-s.radius);
    expect(planeOffsetForFill(lattice, [0, 0, 1], 1)).toBeGreaterThan(s.radius);
  });

  it("is level over a settled liquid", () => {
    const up = upOf([-6.30359, 0, 7.51233]);
    const { positions } = seedSettled(g, s, 0.6, [-up[0], -up[1], -up[2]], 3);
    const n = fitSurfaceNormal(g, s, positions, g.maxParticles, 3, up);
    expect(deg(angle(n, up))).toBeLessThan(3);
  });

  it("follows a sloshed top layer, clamped to MAX_TILT", () => {
    const up = upOf([-6.30359, 0, 7.51233]);
    const [e1] = lateralBasis(up);
    // The particles lie as if settled under an apparent up 12 degrees off the one the fit is told.
    const real = tilt(up, e1, (12 * Math.PI) / 180);
    const { positions } = seedSettled(g, s, 0.6, [-real[0], -real[1], -real[2]], 5);
    const n = fitSurfaceNormal(g, s, positions, g.maxParticles, 3, up);
    expect(deg(angle(n, real))).toBeLessThan(3);
    const far = tilt(up, e1, (45 * Math.PI) / 180);
    const p2 = seedSettled(g, s, 0.6, [-far[0], -far[1], -far[2]], 5).positions;
    const n2 = fitSurfaceNormal(g, s, p2, g.maxParticles, 3, up);
    expect(angle(n2, up)).toBeLessThanOrEqual(MAX_TILT + 1e-6);
    expect(deg(angle(n2, up))).toBeGreaterThan(15);
  });

  it("falls back to level with too few particles, and eases between normals", () => {
    expect(fitSurfaceNormal(g, s, new Float32Array(30), 10, 3, [0, 0, 1])).toEqual([0, 0, 1]);
    const m = easeNormal([0, 0, 1], [1, 0, 0], 0.5);
    expect(Math.hypot(...m)).toBeCloseTo(1, 9);
    expect(m[0]).toBeCloseTo(m[2], 9);
    expect(angleBetween([0, 0, 1], [1, 0, 0])).toBeCloseTo(Math.PI / 2, 9);
  });

  it("measures the particles' surface relief: small when settled, larger over a wavy top layer", () => {
    const up = upOf([-6.30359, 0, 7.51233]);
    const [e1] = lateralBasis(up);
    const { positions } = seedSettled(g, s, 0.6, [-up[0], -up[1], -up[2]], 3);
    const calm = fitSurface(g, s, positions, g.maxParticles, 3, up);
    expect(deg(angle(calm.normal, up))).toBeLessThan(3);
    // Raise every particle by a wave across the surface (amplitude 6 mm, wavelength 6 cm).
    const A = 0.006;
    const wavy = new Float32Array(positions);
    for (let i = 0; i < g.maxParticles; i++) {
      const p: Vec3 = [positions[i * 3]! * g.h + g.origin[0], positions[i * 3 + 1]! * g.h + g.origin[1], positions[i * 3 + 2]! * g.h + g.origin[2]];
      const dz = A * Math.sin(((2 * Math.PI) / 0.06) * (p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2]));
      for (let k = 0; k < 3; k++) wavy[i * 3 + k] = positions[i * 3 + k]! + (dz * up[k]!) / g.h;
    }
    const rough = fitSurface(g, s, wavy, g.maxParticles, 3, up);
    expect(rough.roughness).toBeGreaterThan(calm.roughness + 0.25 * A);
    expect(fitSurface(g, s, new Float32Array(30), 10, 3, [0, 0, 1]).roughness).toBe(0);
  });

  it("draws one smooth surface: a gentle ripple, rising with the slosh, capped, never the particles' relief", () => {
    const D = TANK.od;
    const calm = waveAmplitude(D, 0);
    expect(calm).toBeGreaterThan(0);
    expect(waveAmplitude(D, 0.15)).toBeGreaterThan(calm);
    expect(waveAmplitude(D, 3)).toBeCloseTo(RIPPLE_CAP * D, 12);
    for (const sl of [0, 0.05, 0.1, 0.2, 0.25, 1, 10]) expect(waveAmplitude(D, sl)).toBeLessThanOrEqual(RIPPLE_CAP * D + 1e-15);
    // Gentle: about 2 mm at most on a 15 cm tank, slopes under 5 degrees, wavelengths of most of a diameter.
    expect(RIPPLE_CAP * D).toBeLessThan(0.002);
    const A = RIPPLE_CAP * D;
    expect(rippleMaxSlope(D, A)).toBeLessThan(Math.tan((5 * Math.PI) / 180));
    for (const w of waveTrains(D)) expect((2 * Math.PI) / w.k).toBeGreaterThanOrEqual(RIPPLE_MIN_WAVELENGTH * D - 1e-12);
    expect(waveTrains(D).reduce((acc, w) => acc + w.w, 0)).toBeCloseTo(1, 12);
    // Planar plus a smooth ripple: within the cap everywhere, and no lumps (neighbouring samples 5 mm apart
    // differ by no more than the slope bound allows, and the curvature stays under 5 /m: no bend tighter than 20 cm).
    const step = 0.005;
    let peak = 0;
    for (let t = 0; t < 3; t += 0.37)
      for (let a = -0.2; a <= 0.2; a += step)
        for (let b = -0.08; b <= 0.08; b += 0.02) {
          const h0 = waveHeight(D, A, a - step, b, t);
          const h1 = waveHeight(D, A, a, b, t);
          const h2 = waveHeight(D, A, a + step, b, t);
          peak = Math.max(peak, Math.abs(h1));
          expect(Math.abs(h1)).toBeLessThanOrEqual(A + 1e-12);
          expect(Math.abs(h2 - h1)).toBeLessThanOrEqual(rippleMaxSlope(D, A) * step + 1e-12);
          expect(Math.abs(h2 - 2 * h1 + h0) / step ** 2).toBeLessThan(5);
        }
    expect(peak).toBeGreaterThan(0.5 * A);
  });

  it("holds the fill fraction with the ripple on: the drawn liquid volume is the study's within 5%", () => {
    const D = 2 * s.radius;
    const A = RIPPLE_CAP * TANK.od;
    const up = upOf([-6.30359, 0, 7.51233]);
    const [e1] = lateralBasis(up);
    const check = tankLattice(s, 30000);
    for (const n of [up, tilt(up, e1, (20 * Math.PI) / 180), [0, 0, 1] as Vec3])
      for (const fill of [0.6, 0.39, 0.2])
        for (const t of [0, 1.3, 2.7]) {
          const plane = { normal: n, offset: planeOffsetForFill(lattice, n, fill) };
          const drawn = drawnFill(check, plane, D, A, t);
          expect(Math.abs(drawn - fill) / fill).toBeLessThan(0.05);
        }
    // Empty and full stay empty and full.
    expect(drawnFill(check, { normal: up, offset: planeOffsetForFill(lattice, up, 0) }, D, A, 0)).toBe(0);
    expect(drawnFill(check, { normal: up, offset: planeOffsetForFill(lattice, up, 1) }, D, A, 0)).toBe(1);
  });
});

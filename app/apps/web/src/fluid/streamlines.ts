/**
 * Illustrative streamlines for the page 06 cutaway (M5.3), pure: white
 * lines from the liquid in the tank, converging on the outlet, through the
 * feed line, the valve, and the engine inlet, then spreading through the
 * chamber, necking at the throat, and opening through the nozzle, ending
 * on the nozzle exit plane (R20-06: no stubs past the exit). They are
 * drawn, not computed (the study's assumptions say so): continuity of the
 * path is what they show. Body frame, metres.
 */
import { nozzleRadiusAt, type CutawayLayout } from "./layout.ts";
import { axialHalf, tankSdf, type TankShape, type Vec3 } from "./tankSdf.ts";

export interface Streamline {
  points: Vec3[];
  /** Index of the last point inside the tank. */
  tankEnd: number;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const lerp3 = (a: Vec3, b: Vec3, f: number): Vec3 => [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];

function bezier(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const a = lerp3(p0, p1, t);
  const b = lerp3(p1, p2, t);
  const c = lerp3(p2, p3, t);
  return lerp3(lerp3(a, b, t), lerp3(b, c, t), t);
}

/** Centripetal-free uniform Catmull-Rom through `pts` (ends duplicated), `n` points per segment. */
export function catmullRom(pts: readonly Vec3[], n: number): Vec3[] {
  const out: Vec3[] = [];
  const P = (i: number) => pts[Math.min(pts.length - 1, Math.max(0, i))]!;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    for (let s = 0; s < n; s++) {
      const t = s / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (k: 0 | 1 | 2) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      out.push([f(0), f(1), f(2)]);
    }
  }
  out.push(P(pts.length - 1));
  return out;
}

/**
 * `count` streamlines through the cutaway. In the tank they form a fan in
 * the section plane's view (body x-z, a little toward the camera's -Y side):
 * each starts in the liquid's aft half, runs along the tank, and converges
 * on the outlet, so they read as flow toward the outlet, not as ribs round
 * the liquid. Then a bundle through the feed line and valve, spreading
 * from the injector through the chamber, necking at the throat, and opening
 * through the bell, ending on its exit plane.
 */
export function streamlines(l: CutawayLayout, shape: TankShape, count = 10): Streamline[] {
  const R = shape.radius;
  const L = axialHalf(shape) * 2;
  const xo = l.outletX;
  const D = l.tankOd;
  const centre = catmullRom(l.feed, 8);
  const lines: Streamline[] = [];
  const rc = l.nozzle[0]!.r;
  const x0 = l.nozzle[0]!.x;
  const exit = l.exit;
  for (let j = 0; j < count; j++) {
    const f = count > 1 ? j / (count - 1) : 0.5;
    const u = (j * 0.618034 + 0.13) % 1;
    // Fan across the tank (body z, low side first), a little toward the viewer (-Y).
    const z0 = lerp(-0.8, 0.5, f) * R;
    const y0 = -lerp(0.15, 0.55, u) * R;
    // Lines on the high side start further aft, so they begin inside the liquid rather than at its surface.
    const start: Vec3 = [lerp(-0.14, 0.2, f) * L + 0.08 * L * u, y0, z0];
    // Bundle position inside the feed line (a ring at half the bore) and in the engine.
    const a = 2 * Math.PI * f + 0.4;
    const off = 0.5 * l.feedRadius;
    const o: [number, number] = [off * Math.cos(a), off * Math.sin(a)];
    const p3: Vec3 = [xo - 0.02 * D, o[0], o[1]];
    const c1: Vec3 = [lerp(start[0], xo, 0.55), y0 * 0.85, z0 * 0.92];
    const c2: Vec3 = [xo - 0.24 * D, y0 * 0.25, z0 * 0.22];
    const pts: Vec3[] = [];
    for (let i = 0; i <= 40; i++) {
      const p = bezier(start, c1, c2, p3, i / 40);
      // Stay inside the wall.
      if (tankSdf(shape, p) > -0.04 * R) {
        const rr = Math.hypot(p[1], p[2]) || 1;
        const k = Math.max(0, (rr - 0.06 * R) / rr);
        pts.push([p[0], p[1] * k, p[2] * k]);
      } else pts.push(p);
    }
    const tankEnd = pts.length - 1;
    // Feed line: along the centreline with a fixed offset.
    for (const c of centre) if (c[0] > p3[0]) pts.push([c[0], c[1] + o[0], c[2] + o[1]]);
    // Injector: spread to the chamber.
    const q = 0.22 + 0.6 * ((j * 0.381966 + 0.1) % 1);
    const injEnd = l.injector.x + l.injector.length;
    for (let i = 1; i <= 6; i++) {
      const g = i / 6;
      const r = lerp(off, q * rc, g * g);
      pts.push([lerp(l.injector.x, injEnd + 0.02 * D, g), r * Math.cos(a), r * Math.sin(a)]);
    }
    // Chamber, throat, nozzle: a fixed fraction of the local radius.
    for (let i = 1; i <= 48; i++) {
      const x = lerp(Math.max(x0, injEnd + 0.02 * D), exit.x, i / 48);
      const r = q * nozzleRadiusAt(l, x);
      pts.push([x, r * Math.cos(a), r * Math.sin(a)]);
    }
    lines.push({ points: pts, tankEnd });
  }
  return lines;
}

/** Cumulative arc length along a polyline. */
export function arcLengths(points: readonly Vec3[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    out.push(out[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return out;
}

/** Point and unit tangent at arc-length fraction `f` (0..1). */
export function pointAt(points: readonly Vec3[], lengths: readonly number[], f: number): { p: Vec3; t: Vec3 } {
  const total = lengths[lengths.length - 1] ?? 0;
  const s = Math.min(1, Math.max(0, f)) * total;
  let i = 1;
  while (i < lengths.length - 1 && lengths[i]! < s) i++;
  const a = points[i - 1]!;
  const b = points[i]!;
  const seg = lengths[i]! - lengths[i - 1]!;
  const k = seg > 0 ? (s - lengths[i - 1]!) / seg : 0;
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const n = Math.hypot(d[0], d[1], d[2]) || 1;
  return { p: lerp3(a, b, k), t: [d[0] / n, d[1] / n, d[2] / n] };
}

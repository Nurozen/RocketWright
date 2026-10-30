/**
 * The page 06 liquid's free surface (FID2-06), pure: a plane fitted over
 * the MLS-MPM particles' top layer, so the drawn liquid is the tank's
 * inside below one clean, tilted plane instead of a lumpy isosurface of
 * the particle density, while it still sloshes as the particles do.
 *
 * The drawn surface is that plane plus a gentle, smooth, capped ripple
 * (`waveAmplitude`, `waveTrains`), never the particles' relief.
 *
 * Fit: the particles (grid units, `stride` floats each) are projected on
 * the apparent "up" (the specific force direction); a heightfield takes the
 * highest particle per lateral bin, bins where the liquid touches the tank's
 * ceiling (the wall pins it there) are dropped, and a least-squares plane
 * through the rest gives the surface tilt (clamped to `MAX_TILT` off level).
 * The plane's offset is then set from the volume, so the liquid below it
 * is exactly the study's fill fraction of the tank (`planeOffsetForFill`,
 * from a fixed lattice of points inside the tank).
 *
 * Frames: tank frame = body frame (+X aft, +Z up, metres, origin at the
 * tank centre). Visual tier only (I13): an illustration of the particle
 * fluid, not a measured surface.
 */
import { axialHalf, tankSdf, tankVolume, type FluidGrid, type TankShape, type Vec3 } from "./tankSdf.ts";

/** The surface plane: liquid where `dot(normal, p) < offset` (tank frame, metres). */
export interface SurfacePlane {
  /** Unit normal, pointing out of the liquid (apparent up, tilted by the slosh). */
  normal: Vec3;
  offset: number;
}

/** The largest tilt of the fitted surface off level (rad). */
export const MAX_TILT = (25 * Math.PI) / 180;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Two unit vectors spanning the plane normal to `up` (deterministic). */
export function lateralBasis(up: Vec3): [Vec3, Vec3] {
  const u = norm(up);
  const ref: Vec3 = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = norm(cross(ref, u));
  const e2 = cross(u, e1);
  return [e1, e2];
}

/** Apparent up from the body-frame specific force (level when it vanishes). */
export const upOf = (specificForce: readonly number[]): Vec3 => {
  const f: Vec3 = [specificForce[0] ?? 0, specificForce[1] ?? 0, specificForce[2] ?? 0];
  return Math.hypot(...f) > 1e-9 ? norm(f) : [0, 0, 1];
};

/**
 * Points of a fixed lattice inside the tank (tank frame), `n` of them about;
 * each stands for an equal volume. Deterministic.
 */
export function tankLattice(shape: TankShape, n = 12000): Float32Array {
  const ax = axialHalf(shape);
  const R = shape.radius;
  const sp = Math.cbrt(tankVolume(shape) / n);
  const out: number[] = [];
  const nx = Math.ceil(ax / sp);
  const nr = Math.ceil(R / sp);
  for (let i = -nx; i <= nx; i++)
    for (let j = -nr; j <= nr; j++)
      for (let k = -nr; k <= nr; k++) {
        const p: Vec3 = [(i + 0.5) * sp, (j + 0.5) * sp, (k + 0.5) * sp];
        if (tankSdf(shape, p) < 0) out.push(p[0], p[1], p[2]);
      }
  return new Float32Array(out);
}

/** k-th smallest of `a` (0-based; reorders `a`). */
function select(a: Float64Array, k: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i]! < pivot) i++;
      while (a[j]! > pivot) j--;
      if (i <= j) {
        const t = a[i]!;
        a[i] = a[j]!;
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k]!;
  }
  return a[k]!;
}

/** The offset `d` with `fill` of the tank's volume where `dot(normal, p) < d` (lattice quantile). */
export function planeOffsetForFill(lattice: Float32Array, normal: Vec3, fill: number): number {
  const n = lattice.length / 3;
  const proj = new Float64Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = lattice[i * 3]! * normal[0] + lattice[i * 3 + 1]! * normal[1] + lattice[i * 3 + 2]! * normal[2];
    proj[i] = v;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (n === 0) return 0;
  const f = Math.min(1, Math.max(0, fill));
  if (f <= 0) return lo - 0.1 * (hi - lo);
  if (f >= 1) return hi + 0.1 * (hi - lo);
  return select(proj, Math.min(n - 1, Math.max(0, Math.round(f * n) - 1)));
}

/** Highest `s` along `up` from lateral point `q` that is still inside the tank (the ceiling), or null. */
function ceilingAt(shape: TankShape, q: Vec3, up: Vec3, reach: number): number | null {
  const at = (s: number): Vec3 => [q[0] + up[0] * s, q[1] + up[1] * s, q[2] + up[2] * s];
  const N = 48;
  let last: number | null = null;
  for (let i = N; i >= 0; i--) {
    const s = -reach + (2 * reach * i) / N;
    if (tankSdf(shape, at(s)) < 0) {
      last = s;
      break;
    }
  }
  if (last === null) return null;
  // Refine between the inside sample and the one above it.
  let lo = last;
  let hi = Math.min(reach, last + (2 * reach) / N);
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (tankSdf(shape, at(mid)) < 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** A fit over the particles' top layer: the surface normal and how far the top departs from that plane. */
export interface SurfaceFit {
  normal: Vec3;
  /** RMS of the free bins' top heights about the fitted plane (m): the particles' surface relief (waves, slosh). */
  roughness: number;
}

/**
 * The surface normal fitted over the particles' top layer (see the module
 * doc); `up` when too few unpinned bins remain. `positions` holds grid-unit
 * xyz at `i * stride` for the first `n` particles.
 */
export function fitSurfaceNormal(grid: FluidGrid, shape: TankShape, positions: ArrayLike<number>, n: number, stride: number, up: Vec3, bins = 14): Vec3 {
  return fitSurface(grid, shape, positions, n, stride, up, bins).normal;
}

/** `fitSurfaceNormal` plus the top layer's relief about the fitted plane (0 when no fit). */
export function fitSurface(grid: FluidGrid, shape: TankShape, positions: ArrayLike<number>, n: number, stride: number, up: Vec3, bins = 14): SurfaceFit {
  const u = norm(up);
  const none: SurfaceFit = { normal: u, roughness: 0 };
  if (n < 16) return none;
  const [e1, e2] = lateralBasis(u);
  const reach = axialHalf(shape) + shape.radius;
  const cell = (2 * reach) / bins;
  const top = new Float64Array(bins * bins).fill(-Infinity);
  const count = new Uint32Array(bins * bins);
  const h = grid.h;
  const o = grid.origin;
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [positions[i * stride]! * h + o[0], positions[i * stride + 1]! * h + o[1], positions[i * stride + 2]! * h + o[2]];
    const a = dot(p, e1);
    const b = dot(p, e2);
    const bi = Math.floor((a + reach) / cell);
    const bj = Math.floor((b + reach) / cell);
    if (bi < 0 || bj < 0 || bi >= bins || bj >= bins) continue;
    const k = bi * bins + bj;
    count[k]!++;
    top[k] = Math.max(top[k]!, dot(p, u));
  }
  // Least squares s = c0 + c1 a + c2 b over the free (unpinned) bins.
  let S = 0;
  let Sa = 0;
  let Sb = 0;
  let Saa = 0;
  let Sab = 0;
  let Sbb = 0;
  let Ss = 0;
  let Sas = 0;
  let Sbs = 0;
  let used = 0;
  const free: number[] = [];
  for (let bi = 0; bi < bins; bi++)
    for (let bj = 0; bj < bins; bj++) {
      const k = bi * bins + bj;
      if (count[k]! < 3) continue;
      const a = -reach + (bi + 0.5) * cell;
      const b = -reach + (bj + 0.5) * cell;
      const q: Vec3 = [e1[0] * a + e2[0] * b, e1[1] * a + e2[1] * b, e1[2] * a + e2[2] * b];
      const ceil = ceilingAt(shape, q, u, reach);
      if (ceil === null || top[k]! > ceil - 2 * h) continue;
      const s = top[k]!;
      S += 1;
      Sa += a;
      Sb += b;
      Saa += a * a;
      Sab += a * b;
      Sbb += b * b;
      Ss += s;
      Sas += a * s;
      Sbs += b * s;
      free.push(a, b, s);
      used++;
    }
  if (used < 6) return none;
  // Normal equations, centred: [Saa' Sab'; Sab' Sbb'] [c1 c2] = [Sas' Sbs'].
  const ma = Sa / S;
  const mb = Sb / S;
  const ms = Ss / S;
  const A = Saa - S * ma * ma;
  const B = Sab - S * ma * mb;
  const C = Sbb - S * mb * mb;
  const P = Sas - S * ma * ms;
  const Q = Sbs - S * mb * ms;
  const det = A * C - B * B;
  if (!(Math.abs(det) > 1e-18)) return none;
  let c1 = (P * C - Q * B) / det;
  let c2 = (A * Q - B * P) / det;
  // Relief: the top heights about the (unclamped) least-squares plane.
  let ss = 0;
  for (let i = 0; i < free.length; i += 3) ss += (free[i + 2]! - (ms + c1 * (free[i]! - ma) + c2 * (free[i + 1]! - mb))) ** 2;
  const roughness = Math.sqrt(ss / used);
  // Clamp the slope to MAX_TILT.
  const slope = Math.hypot(c1, c2);
  const maxSlope = Math.tan(MAX_TILT);
  if (slope > maxSlope) {
    c1 *= maxSlope / slope;
    c2 *= maxSlope / slope;
  }
  return { normal: norm([u[0] - c1 * e1[0] - c2 * e2[0], u[1] - c1 * e1[1] - c2 * e2[1], u[2] - c1 * e1[2] - c2 * e2[2]]), roughness };
}

/** The angle between two unit vectors (rad). */
export const angleBetween = (a: Vec3, b: Vec3): number => Math.acos(Math.min(1, Math.max(-1, dot(a, b))));

/**
 * The drawn free surface (R20-06): ONE plane (the volume-true, fitted plane
 * above) plus at most a gentle, smooth, long-wavelength ripple. Never the
 * particles' top-layer relief (that drew the liquid as a lumpy sheet): the
 * ripple's amplitude depends only on the slosh (the fitted surface's tilt off
 * the apparent gravity) and is capped at `RIPPLE_CAP` tank diameters, and
 * its wavelengths are at least `RIPPLE_MIN_WAVELENGTH` tank diameters, so
 * its slope stays small (`rippleMaxSlope`).
 */
export const RIPPLE_CAP = 0.012;
/** Ripple amplitude at rest, tank diameters (a faint swell so the surface reads as liquid). */
export const RIPPLE_REST = 0.004;
/** Shortest ripple wavelength, tank diameters. */
export const RIPPLE_MIN_WAVELENGTH = 0.7;

/** Ripple amplitude (m) for the slosh angle (rad): rest swell, rising to the cap at 0.25 rad. */
export function waveAmplitude(tankOd: number, slosh: number): number {
  const s = Math.min(1, Math.max(0, slosh / 0.25));
  return tankOd * Math.min(RIPPLE_CAP, RIPPLE_REST + (RIPPLE_CAP - RIPPLE_REST) * s);
}

/** A ripple wave train: weight (weights sum to 1), wavenumber (rad/m), unit direction in the surface's (e1, e2), angular speed (rad/s). */
export interface WaveTrain {
  w: number;
  k: number;
  d: [number, number];
  omega: number;
}

/** The ripple's two long, slow wave trains (the shader's displacement uses the same). */
export function waveTrains(tankOd: number): WaveTrain[] {
  const dir = (x: number, y: number): [number, number] => {
    const l = Math.hypot(x, y);
    return [x / l, y / l];
  };
  return [
    { w: 0.65, k: (2 * Math.PI) / (1.15 * tankOd), d: dir(1, 0.3), omega: 1.4 },
    { w: 0.35, k: (2 * Math.PI) / (RIPPLE_MIN_WAVELENGTH * tankOd), d: dir(-0.45, 1), omega: -1.1 },
  ];
}

/** Ripple height (m) over the plane at lateral (a, b), time t, amplitude A: the CPU twin of the shader's displacement. */
export function waveHeight(tankOd: number, A: number, a: number, b: number, t: number): number {
  let h = 0;
  for (const w of waveTrains(tankOd)) h += w.w * Math.sin(w.k * (w.d[0] * a + w.d[1] * b) - w.omega * t);
  return A * h;
}

/** Upper bound of the ripple's slope (rise over run) at amplitude A. */
export function rippleMaxSlope(tankOd: number, A: number): number {
  return A * waveTrains(tankOd).reduce((acc, w) => acc + w.w * w.k, 0);
}

/**
 * The drawn liquid as a fraction of the tank's volume: lattice points inside
 * the tank and below the rippled plane (`dot(n, p) < offset + ripple`).
 */
export function drawnFill(lattice: Float32Array, plane: SurfacePlane, tankOd: number, A: number, t: number): number {
  const n = lattice.length / 3;
  if (n === 0) return 0;
  const [e1, e2] = lateralBasis(plane.normal);
  let below = 0;
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [lattice[i * 3]!, lattice[i * 3 + 1]!, lattice[i * 3 + 2]!];
    if (dot(plane.normal, p) < plane.offset + waveHeight(tankOd, A, dot(p, e1), dot(p, e2), t)) below++;
  }
  return below / n;
}

/** Rotates unit `a` toward unit `b` by the fraction `f` of the angle between them (normalized lerp, fine for small steps). */
export function easeNormal(a: Vec3, b: Vec3, f: number): Vec3 {
  const k = Math.min(1, Math.max(0, f));
  return norm([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
}

/** Liquid test against a plane (tank frame). */
export const belowPlane = (plane: SurfacePlane, p: Vec3): boolean => dot(plane.normal, p) < plane.offset;

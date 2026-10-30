/**
 * The tank the page 06 visual fluid lives in (M5.2): its inner shape as a
 * signed distance field, the MLS-MPM grid laid over it, and the settled
 * particle seeding for a fill fraction and an apparent-gravity direction.
 *
 * Frames: the tank frame is the body frame (+X aft, +Y, +Z up, metres) with
 * its origin at the tank centre. The grid frame is in cell units with its
 * origin at the grid's min corner: `grid = (tank - origin) / h`.
 *
 * Pure (no GPU); `mpm.ts` mirrors `tankSdf` in TSL. Visual tier only (I13).
 */

export type Vec3 = [number, number, number];

/** The inner shape: a capsule (hemispherical or ellipsoidal ends, drawn as hemispheres) or a capped cylinder (flat ends). */
export interface TankShape {
  /** Inner radius, m. */
  radius: number;
  /** Half the cylindrical part's length, m (the caps add `radius` beyond it on a capsule). */
  halfLength: number;
  capsule: boolean;
}

export interface TankGeometry {
  length: number;
  od: number;
  wall: number;
  end_cap: "flat" | "hemispherical" | "ellipsoidal";
}

export function tankShape(t: TankGeometry): TankShape {
  const radius = Math.max(1e-4, t.od / 2 - t.wall);
  const inner = Math.max(2e-4, t.length - 2 * t.wall);
  const capsule = t.end_cap !== "flat";
  return { radius, halfLength: capsule ? Math.max(0, inner / 2 - radius) : inner / 2, capsule };
}

/** Inner volume, m³. */
export function tankVolume(s: TankShape): number {
  const cyl = Math.PI * s.radius ** 2 * 2 * s.halfLength;
  return s.capsule ? cyl + (4 / 3) * Math.PI * s.radius ** 3 : cyl;
}

/** Half extent along the axis, m. */
export const axialHalf = (s: TankShape): number => s.halfLength + (s.capsule ? s.radius : 0);

/** Signed distance to the inner wall (negative inside), tank frame, m. */
export function tankSdf(s: TankShape, p: Vec3): number {
  const [x, y, z] = p;
  const rr = Math.hypot(y, z);
  if (s.capsule) {
    const ax = Math.max(Math.abs(x) - s.halfLength, 0);
    return Math.hypot(ax, rr) - s.radius;
  }
  const dx = Math.abs(x) - s.halfLength;
  const dr = rr - s.radius;
  return Math.min(Math.max(dx, dr), 0) + Math.hypot(Math.max(dx, 0), Math.max(dr, 0));
}

/** The MLS-MPM grid over the tank. */
export interface FluidGrid {
  /** Cell size, m. */
  h: number;
  /** Cells per axis. */
  dims: Vec3;
  /** Tank-frame position of the grid's min corner, m. */
  origin: Vec3;
  /** Particles at the initial fill (the buffer size). */
  maxParticles: number;
  /** Particles per cell at rest (the particle mass is 1). */
  restDensity: number;
  /** Liquid volume one particle stands for, m³. */
  particleVolume: number;
  /** Inner tank volume, m³. */
  tankVolume: number;
}

/** Empty cells around the tank (the B-spline stencil reaches one cell beyond a particle's cell). */
export const GRID_MARGIN = 3;
export const REST_DENSITY = 1.5;

/**
 * Lays the grid over the tank so the initial fill holds about `target`
 * particles at rest density (cell size from the liquid volume), capped at
 * `maxCells` cells along the axis.
 */
export function fluidGrid(s: TankShape, fill0: number, target = 32768, maxCells = 160): FluidGrid {
  const vol = tankVolume(s);
  const liquid = Math.max(1e-9, Math.min(1, Math.max(0, fill0)) * vol);
  let h = Math.cbrt((REST_DENSITY * liquid) / target);
  const ax = axialHalf(s);
  h = Math.max(h, (2 * ax) / (maxCells - 2 * GRID_MARGIN), (2 * s.radius) / (maxCells - 2 * GRID_MARGIN));
  const cells = (half: number) => Math.ceil((2 * half) / h) + 2 * GRID_MARGIN;
  const dims: Vec3 = [cells(ax), cells(s.radius), cells(s.radius)];
  const origin: Vec3 = [-(dims[0] * h) / 2, -(dims[1] * h) / 2, -(dims[2] * h) / 2];
  const maxParticles = Math.max(1, Math.round((REST_DENSITY * liquid) / h ** 3));
  return { h, dims, origin, maxParticles, restDensity: REST_DENSITY, particleVolume: liquid / maxParticles, tankVolume: vol };
}

export const toGrid = (g: FluidGrid, p: Vec3): Vec3 => [(p[0] - g.origin[0]) / g.h, (p[1] - g.origin[1]) / g.h, (p[2] - g.origin[2]) / g.h];
export const fromGrid = (g: FluidGrid, q: Vec3): Vec3 => [q[0] * g.h + g.origin[0], q[1] * g.h + g.origin[1], q[2] * g.h + g.origin[2]];

/** Active particles for a fill fraction (liquid volume over tank volume). */
export function activeCount(g: FluidGrid, fill: number): number {
  const n = Math.round((Math.max(0, fill) * g.tankVolume) / g.particleVolume);
  return Math.min(g.maxParticles, Math.max(0, n));
}

/** Fill fraction `n` particles stand for. */
export const fillOf = (g: FluidGrid, n: number): number => (n * g.particleVolume) / g.tankVolume;

/** Deterministic PRNG (mulberry32), so seeding repeats. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Keeps seeded particles this far inside the wall, in cells. */
export const WALL_SKIN = 0.5;

/**
 * Seeds `g.maxParticles` particles (grid units, xyz per particle) as the
 * liquid settles under apparent gravity `down` (tank frame, any length):
 * uniform points inside the tank, the `n` lowest along `down` kept, ordered
 * so the highest come last. Draining deactivates from the end, so the
 * level falls from the top. Returns the positions and how many are below
 * the surface for fill `fill` (the rest sit at the surface, inactive).
 */
export function seedSettled(g: FluidGrid, s: TankShape, fill: number, down: Vec3, seed = 1): { positions: Float32Array; active: number } {
  const len = Math.hypot(down[0], down[1], down[2]) || 1;
  const d: Vec3 = [down[0] / len, down[1] / len, down[2] / len];
  const n = g.maxParticles;
  const ax = axialHalf(s);
  const rand = rng(seed);
  const skin = WALL_SKIN * g.h;
  // Candidates on a jittered lattice filling the whole tank at rest density (a lattice, not
  // uniform random points: random sampling's density noise makes the stiff equation of
  // state boil for the first second). The n lowest then fill exactly the liquid volume.
  let sp = Math.cbrt(g.particleVolume);
  let pts: { p: Vec3; k: number }[] = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    pts = [];
    const nx = Math.ceil(ax / sp);
    const nr = Math.ceil(s.radius / sp);
    for (let i = -nx; i <= nx; i++)
      for (let j = -nr; j <= nr; j++)
        for (let k = -nr; k <= nr; k++) {
          const p: Vec3 = [(i + (rand() - 0.5) * 0.3) * sp, (j + (rand() - 0.5) * 0.3) * sp, (k + (rand() - 0.5) * 0.3) * sp];
          if (tankSdf(s, p) > -skin) continue;
          pts.push({ p, k: p[0] * d[0] + p[1] * d[1] + p[2] * d[2] });
        }
    if (pts.length >= n) break;
    sp *= 0.98;
  }
  // Lowest first (largest projection on `down`); keep the n lowest, highest last.
  pts.sort((a, b) => b.k - a.k);
  const kept = pts.slice(0, n);
  const positions = new Float32Array(n * 3);
  kept.forEach(({ p }, i) => {
    const q = toGrid(g, p);
    positions[i * 3] = q[0];
    positions[i * 3 + 1] = q[1];
    positions[i * 3 + 2] = q[2];
  });
  return { positions, active: activeCount(g, fill) };
}

/** Centre of mass (tank frame, m) of the first `n` particles of a grid-unit xyz (or xyzw-strided) array. */
export function centreOfMass(g: FluidGrid, pos: ArrayLike<number>, n: number, stride = 3): Vec3 {
  if (n <= 0) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < n; i++) {
    x += pos[i * stride]!;
    y += pos[i * stride + 1]!;
    z += pos[i * stride + 2]!;
  }
  return fromGrid(g, [x / n, y / n, z / n]);
}

/** Apparent gravity on the liquid from the body-frame specific force: its opposite. */
export const downOf = (specificForce: readonly number[]): Vec3 => [-(specificForce[0] ?? 0), -(specificForce[1] ?? 0), -(specificForce[2] ?? 0)];

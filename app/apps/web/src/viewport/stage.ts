/**
 * The studio floor under the page 01 model (BC5 fidelity): one soft, broad
 * contact shadow beneath the exploded stack plus a subtle light pool on the
 * backdrop, baked into one RGBA texture on a floor quad (`engine.ts`).
 *
 * A shadow map draws a hard copy of every part (a per-part fringe at any
 * blur that keeps the map cheap). Here the visible triangles are projected
 * along the key light onto the floor plane, rasterised into a coarse
 * coverage grid, and blurred with two Gaussians: a medium one (the contact
 * darkness under the parts) and a broad one (the penumbra spreading past the
 * silhouette). The light pool is an ellipse on the floor centred on the model.
 *
 * The pool itself is drawn as a backdrop layer under the transparent canvas
 * (`AssemblyViewport`), from the floor ellipse this bake returns.
 *
 * Pure (typed arrays in, typed arrays out; no three, no DOM), so the shadow
 * spread and softness are unit-tested. World is three.js Y-up; the floor is
 * the plane y = `floorY`. Visual tier only (I13).
 */

export interface StageGrid {
  /** World x and z of the grid's min corner (cell (0, 0)). */
  x0: number;
  z0: number;
  /** Cell edge (m). */
  cell: number;
  /** Cells along x and z. */
  nx: number;
  nz: number;
}

export interface StageLook {
  /** Direction the key light travels (world, need not be unit; y < 0). */
  light: readonly [number, number, number];
  /** Medium (contact) blur sigma and broad (penumbra) blur sigma, in body radii. */
  contactSigma: number;
  broadSigma: number;
  /** Peak alpha of each term. */
  contactOpacity: number;
  broadOpacity: number;
  /** Light pool radius as a fraction of the model's floor extent (the backdrop layer's ellipse). */
  poolRadius: number;
  /** Floor margin around the model's projected footprint, in body radii (room for the blur and the pool). */
  margin: number;
  /** Grid cells along the longer floor side. */
  resolution: number;
}

/** Tuned against image 01 (live captures): a broad soft pool of shade, no hard per-part edge, no bloom. */
export const STAGE_LOOK: StageLook = {
  light: [0.1, -1, 0.32],
  contactSigma: 0.7,
  broadSigma: 1.7,
  contactOpacity: 0.58,
  broadOpacity: 0.48,
  poolRadius: 0.62,
  margin: 7,
  resolution: 256,
};

/** Projects world point (x, y, z) along `light` onto the floor y = floorY; returns [x, z]. */
export function projectToFloor(x: number, y: number, z: number, floorY: number, light: readonly [number, number, number]): [number, number] {
  const ly = light[1] < -1e-6 ? light[1] : -1e-6;
  const t = (floorY - y) / ly;
  return [x + light[0] * t, z + light[2] * t];
}

/**
 * A square `resolution` x `resolution` grid centred on the floor footprint
 * `[minX, maxX] x [minZ, maxZ]` plus `margin` (m) on every side (fixed size,
 * so the floor texture never reallocates).
 */
export function stageGrid(minX: number, maxX: number, minZ: number, maxZ: number, margin: number, resolution: number): StageGrid {
  const w = Math.max(1e-6, maxX - minX + 2 * margin);
  const d = Math.max(1e-6, maxZ - minZ + 2 * margin);
  const n = Math.max(8, Math.round(resolution));
  const cell = Math.max(w, d) / n;
  return { x0: (minX + maxX) / 2 - (n * cell) / 2, z0: (minZ + maxZ) / 2 - (n * cell) / 2, cell, nx: n, nz: n };
}

/**
 * Coverage (0/1 per cell, row-major z then x) of triangles projected onto the
 * floor. `tris` holds world positions, 9 floats per triangle. A cell is
 * covered when its centre lies inside a projected triangle or a vertex falls
 * in it (so sliver triangles still mark their cells).
 */
export function rasterCoverage(tris: Float32Array, floorY: number, light: readonly [number, number, number], g: StageGrid): Float32Array {
  const out = new Float32Array(g.nx * g.nz);
  const inv = 1 / g.cell;
  const u = [0, 0, 0];
  const v = [0, 0, 0];
  const mark = (cu: number, cv: number) => {
    const i = Math.floor(cu);
    const j = Math.floor(cv);
    if (i >= 0 && j >= 0 && i < g.nx && j < g.nz) out[j * g.nx + i] = 1;
  };
  for (let t = 0; t + 8 < tris.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      const [px, pz] = projectToFloor(tris[t + 3 * k]!, tris[t + 3 * k + 1]!, tris[t + 3 * k + 2]!, floorY, light);
      u[k] = (px - g.x0) * inv;
      v[k] = (pz - g.z0) * inv;
      mark(u[k]!, v[k]!);
    }
    const area = (u[1]! - u[0]!) * (v[2]! - v[0]!) - (u[2]! - u[0]!) * (v[1]! - v[0]!);
    if (Math.abs(area) < 1e-9) continue;
    const i0 = Math.max(0, Math.floor(Math.min(u[0]!, u[1]!, u[2]!)));
    const i1 = Math.min(g.nx - 1, Math.ceil(Math.max(u[0]!, u[1]!, u[2]!)));
    const j0 = Math.max(0, Math.floor(Math.min(v[0]!, v[1]!, v[2]!)));
    const j1 = Math.min(g.nz - 1, Math.ceil(Math.max(v[0]!, v[1]!, v[2]!)));
    const s = area > 0 ? 1 : -1;
    for (let j = j0; j <= j1; j++) {
      const cy = j + 0.5;
      for (let i = i0; i <= i1; i++) {
        const cx = i + 0.5;
        const e0 = s * ((u[1]! - u[0]!) * (cy - v[0]!) - (v[1]! - v[0]!) * (cx - u[0]!));
        const e1 = s * ((u[2]! - u[1]!) * (cy - v[1]!) - (v[2]! - v[1]!) * (cx - u[1]!));
        const e2 = s * ((u[0]! - u[2]!) * (cy - v[2]!) - (v[0]! - v[2]!) * (cx - u[2]!));
        if (e0 >= 0 && e1 >= 0 && e2 >= 0) out[j * g.nx + i] = 1;
      }
    }
  }
  return out;
}

/** Normalised 1-D Gaussian kernel (radius 3 sigma). */
export function gaussianKernel(sigma: number): Float32Array {
  const s = Math.max(1e-3, sigma);
  const r = Math.max(1, Math.ceil(3 * s));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const w = Math.exp(-(i * i) / (2 * s * s));
    k[i + r] = w;
    sum += w;
  }
  for (let i = 0; i < k.length; i++) k[i] = k[i]! / sum;
  return k;
}

/** Separable Gaussian blur (sigma in cells), zero outside the grid. */
export function blur(a: Float32Array, nx: number, nz: number, sigma: number): Float32Array {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let d = -r; d <= r; d++) {
        const ii = i + d;
        if (ii >= 0 && ii < nx) s += a[j * nx + ii]! * k[d + r]!;
      }
      tmp[j * nx + i] = s;
    }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let d = -r; d <= r; d++) {
        const jj = j + d;
        if (jj >= 0 && jj < nz) s += tmp[jj * nx + i]! * k[d + r]!;
      }
      out[j * nx + i] = s;
    }
  return out;
}

/** Soft saturation: thin parts (a blurred line peaks well below 1) still read, wide ones do not clip hard. */
const soft = (x: number) => 1 - Math.exp(-2.4 * Math.max(0, x));
const SOFT_MAX = soft(1);

/**
 * Shadow alpha per cell (0..1): contact and broad terms combined as two
 * stacked layers. `radius` is the body radius (m) the sigmas scale with.
 */
export function shadowAlpha(coverage: Float32Array, g: StageGrid, radius: number, look: StageLook = STAGE_LOOK): Float32Array {
  const near = blur(coverage, g.nx, g.nz, (look.contactSigma * radius) / g.cell);
  const broad = blur(coverage, g.nx, g.nz, (look.broadSigma * radius) / g.cell);
  const out = new Float32Array(coverage.length);
  for (let i = 0; i < out.length; i++) {
    const a = (look.contactOpacity * soft(near[i]!)) / SOFT_MAX;
    const b = (look.broadOpacity * soft(broad[i]!)) / SOFT_MAX;
    out[i] = 1 - (1 - a) * (1 - b);
  }
  return out;
}

/**
 * The pool's radial falloff (offset 0 centre .. 1 rim, white alpha): a
 * subtle lift of the backdrop, never a glow. `AssemblyViewport` and the PNG
 * capture draw it.
 */
export const POOL_GRADIENT: readonly (readonly [number, number])[] = [
  [0, 0.1],
  [0.35, 0.07],
  [0.7, 0.022],
  [1, 0],
];

/** CSS `radial-gradient` for `POOL_GRADIENT` (closest-side ellipse of the element). */
export function poolCss(): string {
  return `radial-gradient(closest-side, ${POOL_GRADIENT.map(([at, a]) => `rgba(255, 255, 255, ${a}) ${Math.round(at * 100)}%`).join(", ")})`;
}

/** The light pool's centre and radii on the floor (world x/z, m). */
export interface Pool {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
}

/**
 * RGBA8 floor texture, rows from z0 upward (the engine maps row j to
 * z0 + (j + 0.5) cell): black with the shadow alpha, faded out toward the
 * grid edge so the quad never shows a border. Black only: the canvas is
 * premultiplied and sRGB-encoded after the blend, so a translucent light
 * colour would come out several times too bright; the light pool is a
 * backdrop layer under the canvas instead (`poolEllipse`).
 */
export function stageRGBA(shadow: Float32Array, g: StageGrid): Uint8Array {
  const out = new Uint8Array(g.nx * g.nz * 4);
  const ramp = Math.max(1, 0.08 * Math.max(g.nx, g.nz));
  for (let j = 0; j < g.nz; j++)
    for (let i = 0; i < g.nx; i++) {
      const fade = Math.min(1, Math.min(i + 0.5, g.nx - i - 0.5, j + 0.5, g.nz - j - 0.5) / ramp);
      out[(j * g.nx + i) * 4 + 3] = Math.round(255 * Math.min(1, shadow[j * g.nx + i]! * fade));
    }
  return out;
}

export interface StageBake {
  grid: StageGrid;
  rgba: Uint8Array;
  /** Shadow alpha per cell (for tests and the probe). */
  shadow: Float32Array;
  pool: Pool;
}

/**
 * Bakes the floor for triangles `tris` (world, 9 floats each) over the floor
 * plane `floorY`, scaled to the body radius `radius` (m).
 */
export function bakeStage(tris: Float32Array, floorY: number, radius: number, look: StageLook = STAGE_LOOK): StageBake | null {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const [x, z] = projectToFloor(tris[t]!, tris[t + 1]!, tris[t + 2]!, floorY, look.light);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX) || !(radius > 0)) return null;
  const extent = Math.max(maxX - minX, maxZ - minZ);
  const pool: Pool = {
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2 - 0.12 * extent,
    rx: look.poolRadius * extent + 4 * radius,
    rz: 0.75 * look.poolRadius * extent + 4 * radius,
  };
  const margin = look.margin * radius;
  const grid = stageGrid(minX, maxX, minZ, maxZ, margin, look.resolution);
  const shadow = shadowAlpha(rasterCoverage(tris, floorY, look.light, grid), grid, radius, look);
  return { grid, rgba: stageRGBA(shadow, grid), shadow, pool };
}

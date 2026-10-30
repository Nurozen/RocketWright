/**
 * The page 06 studio floor (FID-06): the page 01 soft contact shadow
 * (`viewport/stage.ts`: projected coverage, two Gaussians, black with alpha)
 * under the tilted vehicle, plus the light pool's floor ellipse.
 *
 * The vehicle stands diagonally with its nose far above the floor, so a
 * plain projection would lay one even band under its whole length. Contact
 * shadows darken where a part is near the floor: triangles are weighted by
 * their height above it (full near the floor, `farWeight` high up) before
 * the page 01 blur and saturation. Pure (typed arrays in, typed arrays out).
 * World is three.js Y-up; the floor is the plane y = `floorY`. Visual tier
 * only (I13).
 */
import { projectToFloor, rasterCoverage, shadowAlpha, stageGrid, stageRGBA, STAGE_LOOK, type Pool, type StageGrid, type StageLook } from "../viewport/stage.ts";

export interface ContactLook {
  /** Height (in body radii) over which a part's shadow fades from contact to `farWeight`. */
  fade: number;
  /** Weight of parts far above the floor (0..1). */
  farWeight: number;
  /** Grid cells along the longer side. */
  resolution: number;
  /** Pool radius as a multiple of the body radius, and its centre (world x, z). */
  poolRadius: number;
}

export const CONTACT_LOOK: ContactLook = { fade: 4, farWeight: 0.06, resolution: 160, poolRadius: 4 };

/**
 * The page 01 shadow look with the key behind the vehicle's floor line: the
 * camera looks along -z from low down, so a shadow thrown back (-z) rises
 * on screen behind the parts instead of falling off the bottom edge.
 */
export const FLOOR_LOOK: StageLook = { ...STAGE_LOOK, light: [0.12, -1, -0.62] };

export interface FloorBake {
  grid: StageGrid;
  rgba: Uint8Array;
  shadow: Float32Array;
  pool: Pool;
}

/** Height bands (in body radii above the floor) and their weights. */
export function bandWeights(look: ContactLook = CONTACT_LOOK): { maxHeight: number; weight: number }[] {
  const out: { maxHeight: number; weight: number }[] = [];
  const n = 4;
  for (let i = 1; i <= n; i++) {
    const h = (look.fade * i) / n;
    const w = 1 - (1 - look.farWeight) * ((i - 1) / n);
    out.push({ maxHeight: h, weight: w });
  }
  out.push({ maxHeight: Infinity, weight: look.farWeight });
  return out;
}

/**
 * Bakes the contact shadow of `tris` (world, 9 floats per triangle) on the
 * floor y = `floorY`. `radius` is the body radius the blurs scale with;
 * `focus` (world x, z) centres the light pool (the part of the vehicle in
 * view). Null when there is nothing to bake.
 */
export function bakeContactFloor(tris: Float32Array, floorY: number, radius: number, focus: readonly [number, number], look: ContactLook = CONTACT_LOOK, stage: StageLook = FLOOR_LOOK): FloorBake | null {
  if (!(radius > 0) || tris.length < 9) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const [x, z] = projectToFloor(tris[t]!, tris[t + 1]!, tris[t + 2]!, floorY, stage.light);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX)) return null;
  const grid = stageGrid(minX, maxX, minZ, maxZ, stage.margin * radius, look.resolution);
  // Split the triangles by the height of their lowest vertex; each band covers with its weight.
  const bands = bandWeights(look);
  const sets: number[][] = bands.map(() => []);
  for (let t = 0; t + 8 < tris.length; t += 9) {
    const h = (Math.min(tris[t + 1]!, tris[t + 4]!, tris[t + 7]!) - floorY) / radius;
    const b = bands.findIndex((x) => h <= x.maxHeight);
    for (let k = 0; k < 9; k++) sets[b < 0 ? bands.length - 1 : b]!.push(tris[t + k]!);
  }
  const coverage = new Float32Array(grid.nx * grid.nz);
  bands.forEach((band, i) => {
    if (sets[i]!.length === 0) return;
    const c = rasterCoverage(new Float32Array(sets[i]!), floorY, stage.light, grid);
    for (let j = 0; j < c.length; j++) if (c[j]! > 0) coverage[j] = Math.max(coverage[j]!, band.weight);
  });
  const shadow = shadowAlpha(coverage, grid, radius, stage);
  const r = look.poolRadius * radius;
  return { grid, rgba: stageRGBA(shadow, grid), shadow, pool: { cx: focus[0], cz: focus[1], rx: r, rz: 0.75 * r } };
}

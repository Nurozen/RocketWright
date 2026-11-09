/**
 * B3 surfaces (`tests/bar/surfaces.json`): what each `s-*` capture reaches and
 * how the capture knows it got there. A surface has no token or region table
 * (those are per page); readiness and the overlay's presence stand in for
 * them, and critics compare the capture with its mockup and nearest page.
 */
import { measureSelectorRects, type PageLike } from "../regions.ts";
import { isSurfaceId, readJson, SURFACES, SURFACES_PATH, type SurfaceId } from "./paths.ts";

/**
 * How the window starts. `zero-project`: no project open, a seeded profile
 * supplying Recents. `project`: the sample rocket open at boot, Recents still
 * seeded (they cover other projects, since Recent omits the ones open here).
 */
export type SurfaceBoot = "zero-project" | "project";

/** Where the agent pane is at capture time (`apps/desktop/src/surfacePane.ts`). Null: not decided until the surface is built. */
export type SurfacePane = "absent" | "visible" | "overlay";

export interface SurfaceSpec {
  title: string;
  boot: SurfaceBoot;
  /** Files in the usability bar's `mockups/` and `existing/` (one mockup may serve two surfaces). */
  mockup: string;
  existing: string;
  /** What must be in the page, and the overlay's element when the surface has one. Null until the surface is built. */
  ready: string | null;
  overlay: string | null;
  pane: SurfacePane | null;
  checks: string[];
}

export type SurfacesSpec = Record<SurfaceId, SurfaceSpec>;

export function loadSurfaces(path = SURFACES_PATH): SurfacesSpec {
  const spec = readJson<SurfacesSpec>(path);
  for (const id of SURFACES) if (spec[id] === undefined) throw new Error(`surfaces.json: missing ${id}`);
  for (const id of Object.keys(spec)) if (!isSurfaceId(id)) throw new Error(`surfaces.json: unknown surface ${id}`);
  return spec;
}

export function surfaceSpec(id: SurfaceId, spec: SurfacesSpec = loadSurfaces()): SurfaceSpec {
  return spec[id];
}

export interface SurfaceMeasure {
  surface: SurfaceId;
  ready: boolean;
  overlay: { selector: string; present: boolean; rect: [number, number, number, number] | null } | null;
}

/** Readiness plus overlay presence: the surface counterpart of a page's token report. */
export async function measureSurface(page: PageLike, id: SurfaceId): Promise<SurfaceMeasure> {
  const spec = surfaceSpec(id);
  if (spec.ready === null) throw new Error(`surface ${id}: no ready selector in tests/bar/surfaces.json`);
  const rects = await measureSelectorRects(page, { ready: spec.ready, ...(spec.overlay === null ? {} : { overlay: spec.overlay }) });
  return {
    surface: id,
    ready: rects["ready"] !== null,
    overlay: spec.overlay === null ? null : { selector: spec.overlay, present: rects["overlay"] !== null, rect: rects["overlay"] ?? null },
  };
}

/** One line of the capture's report per failure; empty when the capture reached its surface. */
export function surfaceFailures(id: SurfaceId, spec: SurfaceSpec, seen: { measure?: SurfaceMeasure | undefined; pane?: SurfacePane | undefined }): string[] {
  const failures: string[] = [];
  const { measure, pane } = seen;
  if (measure === undefined) failures.push(`surface ${id}: no measurements`);
  else if (measure.surface !== id) failures.push(`surface ${id}: the window reports ${String(measure.surface)}`);
  else {
    if (!measure.ready) failures.push(`surface ${id}: not ready (${String(spec.ready)} not in the page)`);
    if (measure.overlay !== null && !measure.overlay.present) failures.push(`surface ${id}: overlay not shown (${measure.overlay.selector})`);
  }
  if (spec.pane !== null && pane !== spec.pane) failures.push(`surface ${id}: agent pane is ${String(pane)}, expected ${spec.pane}`);
  return failures;
}

/**
 * Headless render recipes (RL3, M2.8): pure helpers shared by the
 * `rocketwright-render` job (`job.ts`) and, later, the in-app
 * `viewport_render`. No renderer here, so it tests without a GPU.
 *
 * - Flat check materials (`scheme: "check"`): one matte colour per part,
 *   tinted by the worst check diagnostic on that component.
 * - Framing: the viewport presets (`views.ts`) with an orthographic camera
 *   for `check` (silhouettes compare against the Rust 2D views) and the
 *   viewport's perspective for `pbr`.
 * - The reported camera is in the body frame (+X aft, +Z up).
 */
import type { CheckReport, schema } from "@rw/contracts";
import { cameraBasis, fitDistance, viewPose, type Vec3 } from "../viewport/views.ts";
import type { ViewId } from "@rw/contracts";

type Severity = schema.Severity;

/** Flat check palette (sRGB hex). */
export const CHECK_COLORS = {
  /** Clean parts. */
  ok: "#b9c0c7",
  warning: "#e0a030",
  error: "#d9453a",
  /** Canvas clear colour. */
  background: "#ffffff",
} as const;

/** Perspective field of view of the `pbr` scheme (the viewport's). */
export const PBR_FOV_DEG = 28;
/** Frame slack around the model. */
export const FRAME_MARGIN = 1.08;

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

/** Component id of a diagnostic path (`/c/<id>/...`), or null. */
export function componentOfPath(path: string | null | undefined): string | null {
  const m = /^\/c\/([^/]+)/.exec(path ?? "");
  return m?.[1] ?? null;
}

/** Worst severity per component id (warnings and errors only). */
export function worstSeverity(report: Pick<CheckReport, "diagnostics"> | null | undefined): Map<string, Severity> {
  const out = new Map<string, Severity>();
  for (const d of report?.diagnostics ?? []) {
    const id = componentOfPath(d.path);
    if (id === null || d.severity === "info") continue;
    const prev = out.get(id);
    if (prev === undefined || (SEVERITY_RANK[d.severity] ?? 0) > (SEVERITY_RANK[prev] ?? 0)) out.set(id, d.severity);
  }
  return out;
}

/** The flat check colour of a part. */
export function checkColor(id: string, worst: ReadonlyMap<string, Severity>): string {
  const s = worst.get(id);
  return s === "error" ? CHECK_COLORS.error : s === "warning" ? CHECK_COLORS.warning : CHECK_COLORS.ok;
}

/** Body frame (+X aft, +Z up) <-> three.js world (Y up): body (x, y, z) = world (x, -z, y). */
export function worldToBody(v: Vec3): [number, number, number] {
  // `0 - z`, not `-z`: no -0 in the reported camera.
  return [v[0], 0 - v[2], v[1]];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const along = (c: Vec3, d: Vec3, s: number): Vec3 => [c[0] + d[0] * s, c[1] + d[1] * s, c[2] + d[2] * s];

/** A world-space axis-aligned box. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

/** A framed camera in world space (three.js Y up). */
export interface Framing {
  orthographic: boolean;
  position: Vec3;
  target: Vec3;
  up: Vec3;
  near: number;
  far: number;
  /** Perspective only. */
  fovDeg?: number;
  /** Orthographic only: full view height (world units = metres). */
  orthoHeight?: number;
}

function corners(b: Box): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

/**
 * Frames `box` from the `view` preset at `aspect` (w/h). Orthographic: the
 * box's projection fits with `margin`; perspective: its bounding sphere does.
 */
export function frameBox(view: ViewId, box: Box, aspect: number, orthographic: boolean, margin = FRAME_MARGIN): Framing {
  const pose = viewPose(view);
  const basis = cameraBasis(pose);
  const centre: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const radius = Math.max(1e-4, Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2);
  if (orthographic) {
    let hw = 0;
    let hh = 0;
    for (const c of corners(box)) {
      const d = sub(c, centre);
      hw = Math.max(hw, Math.abs(dot(d, basis.right)));
      hh = Math.max(hh, Math.abs(dot(d, basis.up)));
    }
    const half = Math.max(hh, hw / Math.max(aspect, 1e-3), 1e-4) * margin;
    const dist = radius * 4;
    return { orthographic: true, position: along(centre, basis.back, dist), target: centre, up: basis.up, near: dist - 2 * radius, far: dist + 2 * radius, orthoHeight: 2 * half };
  }
  const dist = fitDistance(radius, PBR_FOV_DEG, aspect, margin);
  return { orthographic: false, position: along(centre, basis.back, dist), target: centre, up: basis.up, near: dist / 100, far: dist * 10, fovDeg: PBR_FOV_DEG };
}

/** The contract `Camera` (body frame) of a framing. */
export function bodyCamera(f: Framing): {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  orthographic: boolean;
  fov_deg?: number;
  ortho_height?: number;
} {
  return {
    position: worldToBody(f.position),
    target: worldToBody(f.target),
    up: worldToBody(f.up),
    orthographic: f.orthographic,
    ...(f.fovDeg !== undefined ? { fov_deg: f.fovDeg } : {}),
    ...(f.orthoHeight !== undefined ? { ortho_height: f.orthoHeight } : {}),
  };
}

/** The camera presets `rocketwright-render` frames. */
export function isRenderView(v: string): v is ViewId {
  return v === "iso" || v === "top" || v === "side" || v === "front" || v === "rear";
}

/** Every view `rocketwright-render` draws: the presets plus `exploded` and `section` (M3.5). */
export type JobView = ViewId | "exploded" | "section";

export function isJobView(v: string): v is JobView {
  return isRenderView(v) || v === "exploded" || v === "section";
}

/** The camera preset of a job view: exploded and section use the Iso three-quarter view (the cut faces it). */
export function presetFor(v: JobView): ViewId {
  return v === "exploded" || v === "section" ? "iso" : v;
}

/** Headless cut-face mask (M3.5): the check scheme's blue-violet hatch, robust to tone mapping. */
export function isCapPixel(r: number, g: number, b: number): boolean {
  return b - r > 40 && b - g > 30;
}

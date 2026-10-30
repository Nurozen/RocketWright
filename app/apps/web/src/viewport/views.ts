/**
 * Fixed camera presets (concepts.md §5.6: the agent render presets) and
 * framing. Pure math on plain vectors so it tests without a GPU.
 *
 * World is three.js Y-up after the GLB loader's one body rotation
 * (plan Conventions): body (x, y, z) -> world (x, z, -y). Body +X runs aft
 * from the nose, so on screen the nose is left (or upper left in Iso).
 */
import type { ViewId } from "@rw/contracts";

export type Vec3 = readonly [number, number, number];

export const VIEW_IDS: readonly ViewId[] = ["iso", "top", "side", "front", "rear"];

/** Toolbar chip label <-> view id. */
export const VIEW_LABELS: Record<ViewId, string> = { iso: "Iso", top: "Top", side: "Side", front: "Front", rear: "Rear" };

export interface ViewPose {
  /** Unit vector from the target toward the camera (world). */
  dir: Vec3;
  /** Camera up (world, unit, perpendicular to `dir`). */
  up: Vec3;
  /** Vertical field of view (deg); absent: the engine default. */
  fovDeg?: number;
}

/** Iso view direction (world, target -> camera): aft, above, and to the side of the stack (concept 01). */
export const ISO_DIR: Vec3 = [0.58, 0.5, 0.64];

/** Iso lens (vertical FOV, deg): long enough that the far end of the stack still reads. */
export const ISO_FOV_DEG = 18;

/** Screen tilt of the body axis in Iso: nose upper left, aft lower right (concept 01). */
export const ISO_AXIS_TILT_DEG = 32;

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** Camera basis (right, up, back=dir) for a pose, as three.js `lookAt` builds it. */
export function cameraBasis(pose: ViewPose): { right: Vec3; up: Vec3; back: Vec3 } {
  const back = norm(pose.dir);
  const right = norm(cross(pose.up, back));
  const up = cross(back, right);
  return { right, up, back };
}

/** Screen-space (x right, y up) direction of a world vector seen from `pose`, unnormalised. */
export function screenDir(pose: ViewPose, v: Vec3): [number, number] {
  const b = cameraBasis(pose);
  return [dot(v, b.right), dot(v, b.up)];
}

/** Iso tilt that lays the assembly along the viewport diagonal (upper left to lower right), clamped. */
export function isoTiltFor(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return ISO_AXIS_TILT_DEG;
  const deg = (Math.atan2(height, width) * 180) / Math.PI;
  return Math.min(46, Math.max(26, deg));
}

export function viewPose(view: ViewId, isoTiltDeg: number = ISO_AXIS_TILT_DEG): ViewPose {
  switch (view) {
    case "top": // looking down body -Z; body +Y (world -Z) is screen up
      return { dir: [0, 1, 0], up: [0, 0, -1] };
    case "side": // looking along body +Y (from world +Z); body +Z up
      return { dir: [0, 0, 1], up: [0, 1, 0] };
    case "front": // from ahead of the nose, looking aft
      return { dir: [-1, 0, 0], up: [0, 1, 0] };
    case "rear": // from behind the motor, looking fore
      return { dir: [1, 0, 0], up: [0, 1, 0] };
    case "iso":
    default: {
      // Three-quarter view from aft-above-side (concept 01: the stack recedes
      // toward the nose, near parts read large, and the aft ends' openings
      // face the viewer), then rolled so the axis runs down to the right at
      // ISO_AXIS_TILT_DEG.
      const dir = norm(ISO_DIR);
      const base = cameraBasis({ dir, up: [0, 1, 0] });
      const ax = screenDir({ dir, up: [0, 1, 0] }, [1, 0, 0]);
      const current = Math.atan2(ax[1], ax[0]);
      const target = -(isoTiltDeg * Math.PI) / 180;
      // Rolling the camera by +a turns the image by -a.
      const roll = current - target;
      const up = norm(add(scale(base.up, Math.cos(roll)), base.right, -Math.sin(roll)));
      return { dir, up, fovDeg: ISO_FOV_DEG };
    }
  }
}

/**
 * Distance at which a sphere of `radius` fits a perspective frustum with
 * vertical field of view `fovDeg` and `aspect` (w/h), with `margin` (> 1) slack.
 */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.12): number {
  const vHalf = (fovDeg * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(aspect, 1e-3));
  const half = Math.min(vHalf, hHalf);
  return (Math.max(radius, 1e-4) * margin) / Math.sin(half);
}

/** Camera position for `pose` framing a sphere (`centre`, `radius`). */
export function framePosition(pose: ViewPose, centre: Vec3, radius: number, fovDeg: number, aspect: number): Vec3 {
  return add(centre, norm(pose.dir), fitDistance(radius, fovDeg, aspect));
}

/** Body frame (+X aft, +Z up) to world Y-up: (x, y, z) -> (x, z, -y). */
export function bodyToWorld(v: Vec3): Vec3 {
  return [v[0], v[2], -v[1]];
}

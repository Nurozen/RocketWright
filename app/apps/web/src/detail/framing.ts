/**
 * Camera framing presets per bar page (RL5; `viewport/framing.ts` in M3.0).
 * Pure math on plain vectors (world = three.js Y-up after the loader's body
 * rotation): a preset gives the view direction, the on-screen tilt of the
 * body axis, the explode factor, and the screen rectangle the subject must
 * fill; `fitCamera` solves the camera position for the actual geometry.
 */
import type { Vec3 } from "./types.ts";

export type FramingId = "01" | "01-focus" | "02" | "03" | "04" | "05" | "06" | "thumb" | "card";

export interface FitRect {
  /** Fractions of the viewport (0..1), y down. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FramingPreset {
  id: FramingId;
  label: string;
  /** World direction from the subject toward the camera (normalised on use). */
  dir: Vec3;
  /** Screen angle of body +X (deg, y up): negative runs down to the right. */
  axisTiltDeg: number;
  /** Vertical field of view (deg). */
  fovDeg: number;
  explode: number;
  /** The subject (projected) fills this rectangle. */
  fit: FitRect;
  /** `all`: the whole assembly; `selection`: the selected part plus its riders, everything else hidden. */
  subject: "all" | "selection";
  /** Which parts get leader labels. */
  labels: "items" | "none";
  /** Selected part for captures, when the page has one. */
  select: string | null;
  /** Ground shadows (the toolbar default for the page). */
  shadows: boolean;
  /** Section cut on (page 06's cutaway); default off. */
  section?: boolean;
}

/**
 * Page 01 (concept 01): the exploded rocket on the viewport diagonal, nose
 * upper left, motor lower right, seen from fore-above; the recovery bay
 * selected. The fit rectangle leaves the right quarter to the inspector
 * card. `01-focus` is the inspector close-up: the selected part alone in
 * three-quarter view.
 *
 * Pages 02-06 are read off their exemplars (`bar/visual/0N-*.png`, M3.1):
 * - 02 Component design: the side view (X-Z) of the assembled rocket, axis
 *   level, nose left, filling the upper band (dimensions run below it).
 * - 03 Flight configurations: the motor casing hero render, a three-quarter
 *   view falling about 28° to the right.
 * - 04 Flight results: the run snapshot cards, the assembled rocket on a
 *   shallow diagonal.
 * - 05 Liquid propulsion design: the engine module from front-above, thrust
 *   axis vertical (nozzle down), slightly exploded, items labelled.
 * - 06 Liquid simulator: the tank-and-engine cutaway (section on), close,
 *   falling about 42° to the right.
 *
 * `thumb` and `card` frame the part thumbnails (M3.6): tree rows and chips
 * (square, axis near vertical with the nose up, as concept 01's icons) and
 * the inspector header card (wide, `01-focus` angle).
 */
export const FRAMING_PRESETS: Record<FramingId, FramingPreset> = {
  "01": { id: "01", label: "Assembly overview", dir: [0.58, 0.5, 0.64], axisTiltDeg: -43, fovDeg: 28, explode: 1, fit: { x0: 0.03, y0: 0.05, x1: 0.8, y1: 0.95 }, subject: "all", labels: "items", select: "recovery_bay", shadows: true },
  "01-focus": { id: "01-focus", label: "Selected part close-up", dir: [-0.3, 0.42, 1], axisTiltDeg: -14, fovDeg: 24, explode: 1, fit: { x0: 0.1, y0: 0.14, x1: 0.9, y1: 0.86 }, subject: "selection", labels: "none", select: "recovery_bay", shadows: false },
  "02": { id: "02", label: "Component design", dir: [0, 0, 1], axisTiltDeg: 0, fovDeg: 16, explode: 0, fit: { x0: 0.02, y0: 0.18, x1: 0.97, y1: 0.66 }, subject: "all", labels: "none", select: "fins", shadows: false },
  "03": { id: "03", label: "Flight configurations", dir: [-0.35, 0.5, 1], axisTiltDeg: -28, fovDeg: 22, explode: 0, fit: { x0: 0.08, y0: 0.14, x1: 0.92, y1: 0.86 }, subject: "selection", labels: "none", select: "motor_casing", shadows: true },
  "04": { id: "04", label: "Flight results", dir: [-0.42, 0.55, 1], axisTiltDeg: -28, fovDeg: 26, explode: 0, fit: { x0: 0.06, y0: 0.14, x1: 0.94, y1: 0.86 }, subject: "all", labels: "none", select: null, shadows: true },
  "05": { id: "05", label: "Liquid propulsion design", dir: [-0.15, 0.45, 1], axisTiltDeg: -90, fovDeg: 28, explode: 0.35, fit: { x0: 0.08, y0: 0.06, x1: 0.92, y1: 0.94 }, subject: "selection", labels: "items", select: null, shadows: true },
  "06": { id: "06", label: "Liquid simulator", dir: [-0.3, 0.35, 1], axisTiltDeg: -42, fovDeg: 24, explode: 0, fit: { x0: 0.04, y0: 0.02, x1: 0.96, y1: 0.98 }, subject: "selection", labels: "items", select: null, shadows: false, section: true },
  thumb: { id: "thumb", label: "Part thumbnail", dir: [-0.6, 0.55, 1], axisTiltDeg: -80, fovDeg: 22, explode: 0, fit: { x0: 0.06, y0: 0.04, x1: 0.94, y1: 0.96 }, subject: "selection", labels: "none", select: null, shadows: false },
  card: { id: "card", label: "Inspector card", dir: [-0.3, 0.42, 1], axisTiltDeg: -14, fovDeg: 22, explode: 0, fit: { x0: 0.08, y0: 0.1, x1: 0.92, y1: 0.9 }, subject: "selection", labels: "none", select: null, shadows: false },
};

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

export interface Pose {
  /** Unit, target -> camera. */
  back: Vec3;
  right: Vec3;
  up: Vec3;
}

/** Camera basis for `dir`, rolled so world +X (body +X) appears at `axisTiltDeg` on screen. */
export function presetPose(p: Pick<FramingPreset, "dir" | "axisTiltDeg">): Pose {
  const back = norm(p.dir);
  const r0 = norm(cross([0, 1, 0], back));
  const u0 = cross(back, r0);
  const cur = Math.atan2(dot([1, 0, 0], u0), dot([1, 0, 0], r0));
  const roll = cur - (p.axisTiltDeg * Math.PI) / 180;
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  // Rotating the basis by +roll about `back` turns the image by -roll.
  const right = norm(add([r0[0] * c, r0[1] * c, r0[2] * c], u0, s));
  const up = cross(back, right);
  return { back, right, up };
}

/**
 * The screen angle (deg, y up) world +X takes for a level camera looking
 * along `-dir`: as `axisTiltDeg`, `presetPose` then applies no roll.
 */
export function levelTilt(dir: Vec3): number {
  const l = Math.hypot(...dir) || 1;
  const b: Vec3 = [dir[0] / l, dir[1] / l, dir[2] / l];
  // presetPose's level basis: r0 = norm(Y x back), u0 = back x r0.
  const rl = Math.hypot(b[2], b[0]) || 1;
  const r0: Vec3 = [b[2] / rl, 0, -b[0] / rl];
  const u0: Vec3 = [b[1] * r0[2] - b[2] * r0[1], b[2] * r0[0] - b[0] * r0[2], b[0] * r0[1] - b[1] * r0[0]];
  return (Math.atan2(u0[0], r0[0]) * 180) / Math.PI;
}

export interface CameraFit {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  /** Projected subject bounds as viewport fractions (y down). */
  bounds: FitRect;
}

/** Perspective projection of `p` to viewport fractions for a camera at `eye` with `pose`. */
export function projectFraction(p: Vec3, eye: Vec3, pose: Pose, fovDeg: number, aspect: number): { x: number; y: number; depth: number } {
  const rel: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const depth = -dot(rel, pose.back);
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const nx = dot(rel, pose.right) / (depth * t * aspect);
  const ny = dot(rel, pose.up) / (depth * t);
  return { x: (nx + 1) / 2, y: (1 - ny) / 2, depth };
}

/**
 * Solves target and distance so the projected `points` fill `fit` (the
 * tighter axis touches its edges; the other is centred). A few Newton-style
 * passes of scale-then-shift converge for any convex-ish subject.
 */
export function fitCamera(points: readonly Vec3[], pose: Pose, fovDeg: number, aspect: number, fit: FitRect, passes = 12): CameraFit {
  if (points.length === 0) throw new Error("fitCamera: no points");
  const c: Vec3 = points.reduce<Vec3>((a, p) => add(a, p, 1 / points.length), [0, 0, 0]);
  let radius = 0;
  for (const p of points) radius = Math.max(radius, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  let target: Vec3 = c;
  let dist = (Math.max(radius, 1e-4) * 2.2) / Math.tan((fovDeg * Math.PI) / 360);
  const t = Math.tan((fovDeg * Math.PI) / 360);
  let b: FitRect = { x0: 0, y0: 0, x1: 1, y1: 1 };
  for (let k = 0; k < passes; k++) {
    const eye = add(target, pose.back, dist);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of points) {
      const f = projectFraction(p, eye, pose, fovDeg, aspect);
      x0 = Math.min(x0, f.x);
      y0 = Math.min(y0, f.y);
      x1 = Math.max(x1, f.x);
      y1 = Math.max(y1, f.y);
    }
    b = { x0, y0, x1, y1 };
    const s = Math.max((x1 - x0) / (fit.x1 - fit.x0), (y1 - y0) / (fit.y1 - fit.y0));
    // Shift so the subject centre lands on the rect centre (at the target depth).
    const dfx = (x0 + x1) / 2 - (fit.x0 + fit.x1) / 2;
    const dfy = (y0 + y1) / 2 - (fit.y0 + fit.y1) / 2;
    target = add(add(target, pose.right, dfx * 2 * t * aspect * dist), pose.up, -dfy * 2 * t * dist);
    dist *= s;
  }
  return { position: add(target, pose.back, dist), target, up: pose.up, bounds: b };
}

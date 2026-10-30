/**
 * Trajectory inset geometry (pure; C §4.4). Series positions are ENU
 * (x east, y north, altitude up, metres from the pad). three.js is Y-up, so
 * ENU (e, n, u) maps to (e, u, -n). The ground is a flat plane (terrain later).
 */
import { fitCamera, levelTilt, presetPose, type FitRect } from "../../detail/framing.ts";
import type { schema } from "@rw/contracts";
import { seriesColumn, type Series } from "../../plots/series.ts";
import { lookFor, PRESET_LOOKS, type PbrLook } from "../../viewport/materials.ts";

export type Vec3 = [number, number, number];

export const enuToYUp = (e: number, n: number, u: number): Vec3 => [e, u, -n];

/** Flight path in three.js coordinates, decimated to at most `maxPoints` (first and last kept). */
export function trajectoryPoints(series: Series, maxPoints = 600): Vec3[] {
  const alt = seriesColumn(series, "altitude");
  if (alt === null) return [];
  const x = seriesColumn(series, "x");
  const y = seriesColumn(series, "y");
  const pts: Vec3[] = [];
  for (let i = 0; i < alt.length; i++) {
    const p = enuToYUp(x?.[i] ?? 0, y?.[i] ?? 0, alt[i]!);
    if (p.every(Number.isFinite)) pts.push(p);
  }
  if (pts.length <= maxPoints) return pts;
  const step = (pts.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => pts[Math.round(i * step)]!);
}

/** A 1-2-5 step at or above `v`. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export interface SceneFrame {
  /** Centre of the paths' bounds (three.js coordinates). */
  center: Vec3;
  /** Bounding sphere radius of paths plus pad. */
  radius: number;
  /** Ground grid edge length (m) and cell size (m). */
  ground: number;
  cell: number;
  /** Highest point over all paths (m). */
  apex: number;
}

/** Frames the paths: bounds, a square ground grid around the pad and landing points with nice cell sizes. */
export function frameScene(paths: readonly Vec3[][]): SceneFrame {
  const all = paths.flat();
  all.push([0, 0, 0]);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of all) for (let k = 0; k < 3; k++) [min[k], max[k]] = [Math.min(min[k]!, p[k]!), Math.max(max[k]!, p[k]!)];
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  const horiz = Math.max(Math.abs(min[0]), Math.abs(max[0]), Math.abs(min[2]), Math.abs(max[2]));
  const apex = Math.max(0, max[1]);
  const ground = niceCeil(Math.max(2 * horiz * 1.4, apex * 0.9, 10));
  return { center, radius, ground, cell: niceCeil(ground / 10), apex };
}

/** Inset view direction (world, target -> camera): oblique and a little raised. */
export const INSET_DIR: Vec3 = [0.62, 0.32, 1];

/**
 * Where the flight paths sit in the inset (viewport fractions, y down): clear
 * of the axis gizmo (top right) and the legend (bottom left).
 */
export const INSET_FIT: FitRect = { x0: 0.07, y0: 0.15, x1: 0.93, y1: 0.8 };

/**
 * Camera looking at the paths from `INSET_DIR`. With `points` (the decimated
 * paths and the pad), the projected points fill `INSET_FIT` (tight, FID-03-05);
 * without, the bounding sphere fits the view (loose).
 */
export function cameraFor(frame: SceneFrame, fovDeg: number, aspect: number, points?: readonly Vec3[]): { position: Vec3; target: Vec3 } {
  if (points !== undefined && points.length > 1) {
    const pose = presetPose({ dir: INSET_DIR, axisTiltDeg: levelTilt(INSET_DIR) });
    const fit = fitCamera(points, pose, fovDeg, aspect, INSET_FIT);
    return { position: [...fit.position], target: [...fit.target] };
  }
  const dir = INSET_DIR;
  const len = Math.hypot(...dir);
  const half = (fovDeg * Math.PI) / 360;
  const fitV = frame.radius / Math.sin(half);
  const fitH = frame.radius / Math.sin(Math.atan(Math.tan(half) * aspect));
  const dist = Math.max(fitV, fitH) * 1.05;
  const t = frame.center;
  return { target: t, position: [t[0] + (dir[0] / len) * dist, t[1] + (dir[1] / len) * dist, t[2] + (dir[2] / len) * dist] };
}

/**
 * Points the tight fit frames: every `step`-th path point, each path's ends,
 * and the pad (`padBounds`; a bare height stands for a vertical glyph at the origin).
 */
export function framePoints(paths: readonly (readonly Vec3[])[], pad: number | readonly Vec3[], maxPerPath = 120): Vec3[] {
  const out: Vec3[] =
    typeof pad === "number"
      ? [
          [0, 0, 0],
          [0, pad, 0],
        ]
      : pad.map((p): Vec3 => [p[0], p[1], p[2]]);
  for (const p of paths) {
    if (p.length === 0) continue;
    const step = Math.max(1, Math.ceil(p.length / maxPerPath));
    for (let i = 0; i < p.length; i += step) out.push(p[i]!);
    out.push(p[p.length - 1]!);
  }
  return out;
}

/**
 * Axis gizmo: screen-space directions (y down) of the ENU axes for a camera
 * whose world-to-view rotation is the column-major 3x3 `r` (three.js
 * `Matrix4.elements` of `matrixWorldInverse`, upper-left block).
 */
export function gizmoAxes(viewElements: ArrayLike<number>): { axis: "X" | "Y" | "Z"; dx: number; dy: number; depth: number }[] {
  const e = viewElements;
  const rot = (v: Vec3): Vec3 => [
    e[0]! * v[0] + e[4]! * v[1] + e[8]! * v[2],
    e[1]! * v[0] + e[5]! * v[1] + e[9]! * v[2],
    e[2]! * v[0] + e[6]! * v[1] + e[10]! * v[2],
  ];
  const axes: ["X" | "Y" | "Z", Vec3][] = [
    ["X", enuToYUp(1, 0, 0)],
    ["Y", enuToYUp(0, 1, 0)],
    ["Z", enuToYUp(0, 0, 1)],
  ];
  return axes.map(([axis, v]) => {
    const [x, y, z] = rot(v);
    return { axis, dx: x, dy: -y, depth: z };
  });
}

/** The sim's launch rail: length (m), tilt from vertical (deg), and the azimuth it leans toward (deg clockwise from north). */
export interface LaunchRail {
  length: number;
  angleDeg: number;
  azimuthDeg: number;
}

/** The `Conditions` fields the pad reads. */
export interface RailConditions {
  rail_length_m: number;
  rod_angle_deg: number;
  rod_direction_deg: number;
  wind_direction_deg?: number;
  launch_into_wind?: boolean | null;
}

/** The launch rail from a sim's conditions (into the wind: the rod leans toward where the wind comes from); null without a rail. */
export function launchRailOf(c: RailConditions | null | undefined): LaunchRail | null {
  if (!c || !(c.rail_length_m > 0)) return null;
  const az = c.launch_into_wind === true && Number.isFinite(c.wind_direction_deg) ? c.wind_direction_deg! : c.rod_direction_deg;
  return { length: c.rail_length_m, angleDeg: Math.min(60, Math.max(0, Number.isFinite(c.rod_angle_deg) ? c.rod_angle_deg : 0)), azimuthDeg: Number.isFinite(az) ? az : 0 };
}

/** What the pad glyph takes from the model: overall length and body diameter (m), fin count, and the parts' looks. */
export interface PadModel {
  length: number | null;
  diameter: number | null;
  fins: number;
  body: PbrLook;
  nose: PbrLook;
  fin: PbrLook;
}

/** The evaluated model fields `padModelOf` reads. */
export interface PadModelSource {
  components: readonly {
    aero: boolean;
    x_aft: number;
    appearance?: schema.Appearance | null;
    shape: { type: string; length?: number; od?: number; count?: number };
  }[];
}

const FIN_SETS = new Set(["trapezoidal_fin_set", "elliptical_fin_set", "freeform_fin_set", "tube_fin_set"]);

/**
 * The pad glyph's model: length (aft-most station of the external chain),
 * diameter (widest nose or body tube), fin count, and looks (PBR presets):
 * the nose cone's, the longest opaque external body tube's, and the first fin
 * set's. Without a model: a white composite body with grey fins.
 */
export function padModelOf(model: PadModelSource | null | undefined): PadModel {
  const out: PadModel = { length: null, diameter: null, fins: 3, body: PRESET_LOOKS.composite_white, nose: PRESET_LOOKS.composite_white, fin: PRESET_LOOKS.composite_gray };
  if (!model) return out;
  const ext = model.components.filter((c) => c.aero);
  const aft = Math.max(0, ...ext.map((c) => (Number.isFinite(c.x_aft) ? c.x_aft : 0)));
  if (aft > 0) out.length = aft;
  const tubes = ext.filter((c) => c.shape.type === "nose_cone" || c.shape.type === "body_tube");
  const od = Math.max(0, ...tubes.map((c) => c.shape.od ?? 0));
  if (od > 0) out.diameter = od;
  const nose = ext.find((c) => c.shape.type === "nose_cone");
  const body = ext
    .filter((c) => c.shape.type === "body_tube")
    .map((c) => ({ c, look: lookFor(c.appearance ?? null, c.shape.type) }))
    .filter((b) => !b.look.clear)
    .sort((a, b) => (b.c.shape.length ?? 0) - (a.c.shape.length ?? 0))[0];
  const fins = ext.find((c) => FIN_SETS.has(c.shape.type));
  if (body) out.body = body.look;
  if (nose) {
    const look = lookFor(nose.appearance ?? null, nose.shape.type);
    out.nose = look.clear ? out.body : look;
  }
  if (fins) {
    const look = lookFor(fins.appearance ?? null, fins.shape.type);
    out.fin = look.clear ? out.fin : look;
    if (fins.shape.count !== undefined && fins.shape.count >= 2) out.fins = Math.min(8, Math.round(fins.shape.count));
  }
  return out;
}

/** The pad glyph (three.js coordinates, metres in the scene; the glyph is enlarged to read at inset scale). */
export interface PadRocket {
  /** Rocket length; body and nose lengths; body radius; fin span and root chord. */
  height: number;
  body: number;
  nose: number;
  radius: number;
  fin: number;
  finChord: number;
  fins: number;
  /** Unit rail (and rocket) axis, leaning by the rod angle toward the rod azimuth. */
  axis: Vec3;
  /** Rail length (the sim's rail at the glyph's scale), its square section, and its axis offset from the rocket's. */
  rail: number;
  railWidth: number;
  railOffset: Vec3;
  /** Base plate edge and thickness (the rocket and rail stand on its top, y = `plateThickness`). */
  plate: number;
  plateThickness: number;
  /** Where the drawn flight paths start: just above the rail top and the rocket's nose. */
  departure: Vec3;
}

export interface PadOptions {
  rail?: LaunchRail | null;
  model?: Pick<PadModel, "length" | "diameter" | "fins"> | null;
  /** Lowest apex over the drawn paths: the stand stays under `PAD_SHARE` of it, so every path keeps its climb above the pad. */
  minApex?: number | undefined;
}

/**
 * Longest rail drawn, in rocket lengths: a long rail on a short rocket (1.5 m
 * on 0.56 m) would otherwise shrink the rocket to a sliver under the departure cap.
 */
export const RAIL_MAX = 1.8;
/** Share of the lowest apex the pad stand (rail top, nose) may reach. */
export const PAD_SHARE = 0.6;

/** Horizontal direction (three.js) the rail sits beside the rocket: across the inset's view. */
const RAIL_SIDE: Vec3 = [1, 0, -INSET_DIR[0]];

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * The pad glyph: a rocket about a seventh of the apex tall (at least 5% of
 * the ground grid, so a flat, drifting flight still shows it), standing on a
 * base plate beside a launch rail. The rail has the sim's length relative to
 * the rocket (0.8 to `RAIL_MAX` rocket lengths) and leans by the rod angle toward the
 * rod azimuth; the rocket leans with it. With `minApex`, the whole stand stays
 * under `PAD_SHARE` of the lowest apex, so the paths that start at its top
 * (`startAtPad`) keep most of their climb.
 */
export function padRocket(apex: number, ground: number, opts: PadOptions = {}): PadRocket {
  const rail = opts.rail ?? null;
  const len = opts.model?.length ?? null;
  const railRatio = rail !== null && len !== null && len > 0 ? Math.min(RAIL_MAX, Math.max(0.8, rail.length / len)) : 1.25;
  const a = ((rail?.angleDeg ?? 0) * Math.PI) / 180;
  const az = ((rail?.azimuthDeg ?? 0) * Math.PI) / 180;
  const axis = enuToYUp(Math.sin(a) * Math.sin(az), Math.sin(a) * Math.cos(az), Math.cos(a));
  const stack = Math.max(1, railRatio) * Math.cos(a) + 0.08;
  let height = Math.max(apex * 0.15, ground * 0.05, 1);
  if (opts.minApex !== undefined && opts.minApex > 0) height = Math.max(0.05, Math.min(height, (PAD_SHARE * opts.minApex) / stack));
  const dia = opts.model?.diameter ?? null;
  const slender = dia !== null && len !== null && len > 0 ? dia / 2 / len : 0;
  const radius = height * Math.min(0.12, Math.max(0.09, slender));
  const railWidth = height * 0.06;
  // The rail beside the rocket, across the view and square to the rail axis.
  const side = RAIL_SIDE;
  const d = side[0] * axis[0] + side[1] * axis[1] + side[2] * axis[2];
  const across = unit([side[0] - d * axis[0], side[1] - d * axis[1], side[2] - d * axis[2]]);
  const off = radius + railWidth * 0.9;
  const plateThickness = height * 0.035;
  const top = Math.max(height, railRatio * height) + height * 0.04;
  return {
    height,
    body: height * 0.78,
    nose: height * 0.22,
    radius,
    fin: height * 0.15,
    finChord: height * 0.2,
    fins: opts.model?.fins ?? 3,
    axis,
    rail: railRatio * height,
    railWidth,
    railOffset: [across[0] * off, across[1] * off, across[2] * off],
    plate: Math.max(height * 0.42, radius * 5),
    plateThickness,
    departure: [axis[0] * top, plateThickness + axis[1] * top, axis[2] * top],
  };
}

/** Points that bound the pad (the fit frames them with the paths): plate corners, rail top, and the departure point. */
export function padBounds(pad: PadRocket): Vec3[] {
  const h = pad.plate / 2;
  const t = pad.plateThickness;
  const r = pad.railOffset;
  return [
    [-h, 0, -h],
    [h, 0, -h],
    [-h, 0, h],
    [h, 0, h],
    [r[0] + pad.axis[0] * pad.rail, t + r[1] + pad.axis[1] * pad.rail, r[2] + pad.axis[2] * pad.rail],
    pad.departure,
  ];
}

/**
 * A flight path as drawn over the pad: it starts at the pad's departure point
 * (above the rail top and the glyph's nose) and joins the flown path where it
 * first climbs past that height, so the line never runs through the enlarged
 * glyph. A path that starts above it, or never climbs past it, is unchanged.
 */
export function startAtPad(points: readonly Vec3[], departure: Vec3): Vec3[] {
  const i = points.findIndex((p) => p[1] >= departure[1]);
  if (i <= 0) return [...points];
  return [[departure[0], departure[1], departure[2]], ...points.slice(i)];
}

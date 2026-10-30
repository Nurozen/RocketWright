/**
 * Page 02 profile geometry (D11): the orthographic frame the shaded three.js
 * view and its SVG overlay share, and the overlay itself (CG/CP markers,
 * dimension lines, seams between airframe sections, fin outlines for the
 * proposal fill and the amber ghost of the previous revision). Pure: station x runs from the nose tip, positive
 * aft; the body frame is +X aft, +Z up (plan Conventions); a view picks the
 * two body axes it shows. No renderer here, so it tests without a GPU.
 */
import type { CheckReport, EvaluatedModel, schema } from "@rw/contracts";
import type { DeepReadonly } from "../../state/index.ts";
import { lookFor } from "../../viewport/materials.ts";

export type ProfileView = "side" | "top" | "front" | "rear";
export const PROFILE_VIEWS: readonly ProfileView[] = ["side", "top", "front", "rear"];
export const PROFILE_VIEW_LABEL: Record<ProfileView, string> = { side: "Side", top: "Top", front: "Front", rear: "Rear" };
/** Bottom-left caption (concept 02 `Side view (X-Z)`). */
export const PROFILE_VIEW_CAPTION: Record<ProfileView, string> = {
  side: "Side view (X-Z)",
  top: "Top view (X-Y)",
  front: "Front view (Y-Z)",
  rear: "Rear view (Y-Z)",
};

type Model = DeepReadonly<EvaluatedModel>;
type Comp = DeepReadonly<schema.EvalComponent>;
export type Vec3 = readonly [number, number, number];

/** Body point → (h, v) on screen axes (h right, v up), metres. */
export function projectBody(p: Vec3, view: ProfileView): [number, number] {
  const [x, y, z] = p;
  switch (view) {
    case "side":
      return [x, z];
    case "top":
      return [x, y];
    case "front":
      return [-y, z];
    case "rear":
      return [y, z];
  }
}

/** Visible window in (h, v) metres plus the canvas size; one scale on both axes. */
export interface Frame {
  width: number;
  height: number;
  h0: number;
  h1: number;
  v0: number;
  v1: number;
  /** Pixels per metre. */
  scale: number;
}

export function toScreen(f: Frame, h: number, v: number): [number, number] {
  return [((h - f.h0) / (f.h1 - f.h0)) * f.width, ((f.v1 - v) / (f.v1 - f.v0)) * f.height];
}

/** Margins (px) kept around the model: labels above, dimension rows below. */
export const PROFILE_MARGINS = { left: 34, right: 112, top: 78, bottom: 128 } as const;
const END_MARGINS = { left: 60, right: 60, top: 60, bottom: 60 } as const;

export interface Extents {
  /** Station range (m). */
  x0: number;
  x1: number;
  /** Largest radial reach (body, fins, lugs), m. */
  r: number;
}

const half = (d: number | null | undefined) => (typeof d === "number" && Number.isFinite(d) ? d / 2 : 0);

/** Station range and radial reach of a model (fin tips from their anchors). */
export function modelExtents(models: readonly (Model | null | undefined)[]): Extents {
  let x0 = Infinity;
  let x1 = -Infinity;
  let r = 0;
  for (const m of models) {
    for (const c of m?.components ?? []) {
      if (Number.isFinite(c.x_fore)) x0 = Math.min(x0, c.x_fore);
      if (Number.isFinite(c.x_aft)) x1 = Math.max(x1, c.x_aft);
      const shape = c.shape as { od?: number; fore_od?: number; aft_od?: number };
      r = Math.max(r, half(shape.od), half(shape.fore_od), half(shape.aft_od));
      if (c.containment === "surface") for (const a of c.anchors) r = Math.max(r, Math.abs(a.r) + Math.abs(c.radial));
      // A freeform fin's tip is not an anchor: reach the outline's highest point.
      if (c.shape.type === "freeform_fin_set") for (const [, pr] of finPlanform(c) ?? []) r = Math.max(r, Math.abs(pr));
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return { x0: 0, x1: 1, r: 0.05 };
  return { x0, x1, r: r > 0 ? r : 0.05 };
}

/** Fits the extents in a `width`×`height` canvas for `view` (equal scale, margins for the overlay). */
export function fitFrame(e: Extents, width: number, height: number, view: ProfileView): Frame {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const end = view === "front" || view === "rear";
  const m = end ? END_MARGINS : PROFILE_MARGINS;
  const spanH = end ? 2 * e.r : e.x1 - e.x0;
  const spanV = 2 * e.r;
  const scale = Math.max(1e-6, Math.min((w - m.left - m.right) / spanH, (h - m.top - m.bottom) / spanV));
  // Left-aligned in the free width (the right margin holds the fin labels), centred vertically in the free height.
  const hStart = end ? -e.r - (w - spanH * scale) / 2 / scale : e.x0 - m.left / scale - Math.max(0, (w - m.left - m.right - spanH * scale) / 2) / scale;
  // v = 0 (the axis) sits mid-way between the top and bottom margins.
  const vCentre = (m.top - m.bottom) / 2 / scale;
  const h0 = hStart;
  const h1 = h0 + w / scale;
  const v0 = vCentre - h / 2 / scale;
  const v1 = vCentre + h / 2 / scale;
  return { width: w, height: h, h0, h1, v0, v1, scale };
}

/** Engineering scale for a frame (`1:5`): metres per CSS pixel at 96 dpi, rounded to 1, 2, 2.5, 5 × 10ⁿ. */
export function scaleLabel(f: Frame): string {
  const pxPerM = f.scale;
  const mPerPx = 0.0254 / 96;
  const ratio = 1 / (pxPerM * mPerPx);
  if (!Number.isFinite(ratio) || ratio <= 0) return "Scale: —";
  if (ratio < 1) {
    const k = Math.round(1 / ratio);
    return `Scale: ${k}:1`;
  }
  const exp = Math.floor(Math.log10(ratio));
  const base = ratio / 10 ** exp;
  const nice = [1, 2, 2.5, 5, 10].reduce((a, b) => (Math.abs(b - base) < Math.abs(a - base) ? b : a));
  return `Scale: 1:${Number((nice * 10 ** exp).toPrecision(3))}`;
}

// ---- fins -----------------------------------------------------------------------

const FIN_KINDS = new Set(["trapezoidal_fin_set", "elliptical_fin_set", "freeform_fin_set"]);

export function isFinSet(c: Comp | null | undefined): boolean {
  return c != null && FIN_KINDS.has(c.shape.type);
}

/** Planform (x, r) of one fin from its anchors: root LE, tip LE, tip TE, root TE. */
export function finPlanform(c: Comp): [number, number][] | null {
  const a = (n: string) => c.anchors.find((x) => x.name === n);
  const rle = a("root_le");
  const rte = a("root_te");
  if (rle === undefined || rte === undefined) return null;
  const tle = a("tip_le");
  const tte = a("tip_te");
  if (tle !== undefined && tte !== undefined) {
    return [
      [rle.x, rle.r],
      [tle.x, tle.r],
      [tte.x, tte.r],
      [rte.x, rte.r],
    ];
  }
  // Freeform: the outline itself, from the root leading edge (x aft, y outward).
  const outline = (c.shape as { points?: readonly (readonly number[])[] }).points;
  if (c.shape.type === "freeform_fin_set" && Array.isArray(outline)) {
    return outline.map((p) => [rle.x + (p[0] ?? 0), rle.r + (p[1] ?? 0)] as [number, number]);
  }
  // Elliptical: a half-ellipse over the root chord to the span.
  const shape = c.shape as { span?: number };
  const span = typeof shape.span === "number" ? shape.span : 0;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 16; i++) {
    const t = (Math.PI * i) / 16;
    pts.push([rle.x + ((rte.x - rle.x) * (1 - Math.cos(t))) / 2, rle.r + span * Math.sin(t)]);
  }
  return pts;
}

/** Convex hull (monotone chain), counter-clockwise. */
export function hull(points: readonly [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export interface FinOutline {
  /** Instance index. */
  index: number;
  roll: number;
  /** Screen polygon (px). */
  points: [number, number][];
  /** The planform faces the view (not edge-on). */
  facing: boolean;
}

/**
 * Screen outlines of every fin of a set: each fin's planform swept through its
 * thickness, rolled to its instance angle, projected, and hulled. All fins of
 * a set share one planform, so they are drawn alike.
 */
export function finOutlines(c: Comp, f: Frame, view: ProfileView): FinOutline[] {
  const plan = finPlanform(c);
  if (plan === null) return [];
  // A concave planform (a notched freeform fin) would lose its notch in the hull: facing fins draw the planform itself.
  const concave = hull(plan).length < new Set(plan.map(([x, r]) => `${x},${r}`)).size;
  const t = (c.shape as { thickness?: number }).thickness ?? 0.003;
  const instances = c.instances.length > 0 ? c.instances : [{ index: 0, roll: 0, offset: [0, 0, 0] as const }];
  return instances.map((inst) => {
    const phi = c.roll + inst.roll;
    const d: Vec3 = [0, Math.cos(phi), Math.sin(phi)];
    const n: Vec3 = [0, -Math.sin(phi), Math.cos(phi)];
    const pts: [number, number][] = [];
    for (const [x, r] of plan) {
      for (const s of [-t / 2, t / 2]) {
        const [ox = 0, oy = 0, oz = 0] = inst.offset;
        const p: Vec3 = [x + ox, r * d[1] + s * n[1] + oy, r * d[2] + s * n[2] + oz];
        const [h, v] = projectBody(p, view);
        pts.push(toScreen(f, h, v));
      }
    }
    const [h0, v0] = projectBody([0, d[1], d[2]], view);
    const facing = view !== "front" && view !== "rear" ? Math.abs(v0) > 0.3 : Math.hypot(h0, v0) > 0.3;
    if (concave && facing && view !== "front" && view !== "rear") {
      const [ox = 0, oy = 0, oz = 0] = inst.offset;
      const mid = plan.map(([x, r]): [number, number] => {
        const [h, v] = projectBody([x + ox, r * d[1] + oy, r * d[2] + oz], view);
        return toScreen(f, h, v);
      });
      return { index: inst.index, roll: phi, points: mid, facing };
    }
    return { index: inst.index, roll: phi, points: hull(pts), facing };
  });
}

// ---- markers and dimensions --------------------------------------------------------

export interface Marker {
  kind: "cg" | "cp";
  station: number;
  x: number;
  y: number;
}

export interface Dimension {
  key: "nose-cg" | "cg-cp" | "overall";
  from: number;
  to: number;
  x1: number;
  x2: number;
  y: number;
  /** Length, m. */
  value: number;
}

/** A joint between two airframe sections (side and top views): a seam line across the body. */
export interface Joint {
  station: number;
  x: number;
  /** Top and bottom of the seam (px). */
  y0: number;
  y1: number;
}

const radiusAt = (c: Comp, end: "fore" | "aft"): number => {
  const s = c.shape as { od?: number; fore_od?: number; aft_od?: number };
  return half(end === "fore" ? (s.fore_od ?? s.od) : (s.aft_od ?? s.od));
};

/**
 * Seams between consecutive airframe sections (outer, aerodynamic parts of
 * the stack), nose to tail. A clear section draws its own rings (detail), so
 * its ends get no seam.
 */
export function airframeJoints(model: Model, frame: Frame, view: ProfileView): Joint[] {
  if (view !== "side" && view !== "top") return [];
  const stack = model.components
    .filter((c) => c.aero && c.containment !== "surface" && Number.isFinite(c.x_fore) && Number.isFinite(c.x_aft) && c.x_aft > c.x_fore)
    .sort((a, b) => a.x_fore - b.x_fore);
  const clear = (c: Comp) => lookFor(c.appearance ?? null, c.shape.type).clear;
  const [, axisY] = toScreen(frame, 0, 0);
  const out: Joint[] = [];
  for (let i = 0; i + 1 < stack.length; i++) {
    const a = stack[i]!;
    const b = stack[i + 1]!;
    if (Math.abs(b.x_fore - a.x_aft) > 1e-6 || clear(a) || clear(b)) continue;
    const r = Math.min(radiusAt(a, "aft"), radiusAt(b, "fore"));
    if (!(r > 0)) continue;
    out.push({ station: a.x_aft, x: toScreen(frame, a.x_aft, 0)[0], y0: axisY - r * frame.scale, y1: axisY + r * frame.scale });
  }
  return out;
}

export interface ProfileOverlay {
  frame: Frame;
  /** Seams between airframe sections. */
  joints: Joint[];
  axisY: number;
  /** Body top/bottom (px) at the widest station, for label leaders. */
  bodyTop: number;
  markers: Marker[];
  dims: Dimension[];
  /** Fins of the selected fin set as they are now (proposal fill). */
  fins: FinOutline[];
  /** The same fin set in the previous revision (amber ghost). */
  ghost: FinOutline[];
  /** Upper fin tip (px) of the proposal and of the ghost, for their labels. */
  finTip: [number, number] | null;
  ghostTip: [number, number] | null;
  stability: number | null;
  length: number;
}

/** Topmost (smallest y) point of the facing outlines. */
function topPoint(outlines: readonly FinOutline[]): [number, number] | null {
  let best: [number, number] | null = null;
  for (const o of outlines) {
    if (!o.facing) continue;
    for (const p of o.points) if (best === null || p[1] < best[1] || (p[1] === best[1] && p[0] > best[0])) best = p;
  }
  return best;
}

/**
 * The overlay for `model` (and its check) in `frame`: CG/CP on the axis,
 * dimension rows below the lowest geometry, and the selected fin set's
 * outlines now and in `base` (the previous revision) when it is a fin set.
 */
export function profileOverlay(
  model: Model,
  check: DeepReadonly<CheckReport> | null,
  frame: Frame,
  view: ProfileView,
  selected: string | null,
  base: Model | null,
): ProfileOverlay {
  const e = modelExtents([model]);
  const [, axisY] = toScreen(frame, 0, 0);
  const bodyR = Math.max(...model.components.filter((c) => c.containment !== "surface" && c.aero).map((c) => half((c.shape as { od?: number }).od)), 0) || e.r;
  const bodyTop = axisY - bodyR * frame.scale;
  const side = view === "side" || view === "top";
  const cg = check?.mass.cg ?? null;
  const cp = check?.aero.cp ?? null;
  const markers: Marker[] = [];
  const at = (x: number) => toScreen(frame, x, 0)[0];
  if (side && cg !== null && Number.isFinite(cg)) markers.push({ kind: "cg", station: cg, x: at(cg), y: axisY });
  if (side && cp !== null && Number.isFinite(cp)) markers.push({ kind: "cp", station: cp, x: at(cp), y: axisY });
  const length = check?.dims.length ?? e.x1 - e.x0;
  const dims: Dimension[] = [];
  if (side) {
    const low = axisY + e.r * frame.scale;
    const row1 = low + 22;
    const row2 = low + 52;
    if (cg !== null && Number.isFinite(cg)) dims.push({ key: "nose-cg", from: e.x0, to: cg, x1: at(e.x0), x2: at(cg), y: row1, value: cg - e.x0 });
    if (cg !== null && cp !== null && Number.isFinite(cg) && Number.isFinite(cp)) {
      dims.push({ key: "cg-cp", from: Math.min(cg, cp), to: Math.max(cg, cp), x1: at(Math.min(cg, cp)), x2: at(Math.max(cg, cp)), y: row1, value: Math.abs(cp - cg) });
    }
    dims.push({ key: "overall", from: e.x0, to: e.x0 + length, x1: at(e.x0), x2: at(e.x0 + length), y: row2, value: length });
  }
  const sel = selected !== null ? model.components.find((c) => c.id === selected) : undefined;
  const fins = sel !== undefined && isFinSet(sel) ? finOutlines(sel, frame, view) : [];
  const prev = sel !== undefined && base !== null ? base.components.find((c) => c.id === sel.id) : undefined;
  const ghost = prev !== undefined && isFinSet(prev) ? finOutlines(prev, frame, view) : [];
  return {
    frame,
    joints: airframeJoints(model, frame, view),
    axisY,
    bodyTop,
    markers,
    dims,
    fins,
    ghost,
    finTip: topPoint(fins),
    ghostTip: topPoint(ghost),
    stability: check?.stability.liftoff ?? null,
    length,
  };
}

/** Station in mm (`467 mm`), rounded. */
export function mmLabel(m: number): string {
  return `${Math.round(m * 1000)} mm`;
}

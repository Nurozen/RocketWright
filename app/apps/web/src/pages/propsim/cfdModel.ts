/**
 * Page 06 Imported CFD tier (M5.4, spec R6.15, Acc 9) view model. Pure: an
 * imported dataset's record (`runs/cfd.<id>/<run>/cfd.json`, written by
 * `cfd_import`: `provenance` `cfd`, the columns, and every step's values)
 * becomes points coloured by one scalar. The colour range of a step is
 * exactly the min and max of that column in that step's file (Acc 9); the
 * provenance label comes from the record (I13).
 */
import { CFD_RUN_PATH, type schema } from "@rw/contracts";

export interface CfdStep {
  file: string;
  time: number;
  points: number;
  /** Column-major, in `CfdRecord.columns` order. */
  values: number[][];
}

export interface CfdRecord {
  id: string;
  run_id: string;
  provenance: string;
  core_version?: string;
  frame: string;
  columns: string[];
  units: Record<string, string>;
  sources: { name: string; blake3: string }[];
  dataset: schema.CfdDataset;
  steps: CfdStep[];
}

const POSITION = ["x", "y", "z"] as const;
const VELOCITY = ["vx", "vy", "vz"] as const;

/** Parses `cfd.json`; throws on anything that is not a CFD run record. */
export function parseCfdRecord(text: string): CfdRecord {
  const v = JSON.parse(text) as Partial<CfdRecord>;
  if (typeof v.id !== "string" || typeof v.run_id !== "string" || typeof v.provenance !== "string" || !Array.isArray(v.columns) || !Array.isArray(v.steps) || !v.dataset) {
    throw new Error("cfd.json: not a CFD run record");
  }
  for (const p of POSITION) if (!v.columns.includes(p)) throw new Error(`cfd.json: no ${p} column`);
  for (const s of v.steps) {
    if (!Array.isArray(s.values) || s.values.length !== v.columns.length) throw new Error("cfd.json: a step's columns do not match the header");
  }
  return v as CfdRecord;
}

/** `<base>/api/projects/<p>/runs/<sim>/<runId>/cfd.json` */
export function cfdRunUrl(baseUrl: string, projectId: string, sim: string, runId: string): string {
  const path = CFD_RUN_PATH.replace(":projectId", encodeURIComponent(projectId)).replace(":sim", encodeURIComponent(sim)).replace(":runId", encodeURIComponent(runId));
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** The scalar columns a step can be coloured by (everything but positions and velocity), in file order. */
export function scalarColumns(rec: Pick<CfdRecord, "columns">): string[] {
  return rec.columns.filter((c) => !(POSITION as readonly string[]).includes(c) && !(VELOCITY as readonly string[]).includes(c));
}

export function column(rec: Pick<CfdRecord, "columns">, step: CfdStep, name: string): number[] {
  const i = rec.columns.indexOf(name);
  if (i < 0) throw new Error(`no column ${name}`);
  return step.values[i]!;
}

/** Min and max of a column over one step (its file). */
export function stepRange(rec: Pick<CfdRecord, "columns">, step: CfdStep, name: string): { min: number; max: number } {
  const v = column(rec, step, name);
  let min = Infinity;
  let max = -Infinity;
  for (const x of v) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return { min, max };
}

/**
 * Viridis (perceptually uniform; matplotlib's colormap, CC0), sampled at
 * eleven even stops and interpolated linearly.
 */
export const VIRIDIS = ["#440154", "#482475", "#414487", "#355f8d", "#2a788e", "#21918c", "#22a884", "#44bf70", "#7ad151", "#bddf26", "#fde725"] as const;

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const STOPS = VIRIDIS.map(rgb);

/** The colour at `t` in 0..1 (clamped). */
export function colormap(t: number): [number, number, number] {
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(u));
  const f = u - i;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

/** Where `v` falls in `[min, max]` (0.5 for a constant field). */
export function normalize(v: number, min: number, max: number): number {
  return max > min ? (v - min) / (max - min) : 0.5;
}

/** A CSS gradient of the colormap, low on the left. */
export function legendGradient(): string {
  return `linear-gradient(to right, ${VIRIDIS.map((c, i) => `${c} ${((i / (VIRIDIS.length - 1)) * 100).toFixed(0)}%`).join(", ")})`;
}

export type CfdView = "side" | "top" | "end";

export const CFD_VIEWS: { id: CfdView; label: string }[] = [
  { id: "side", label: "Side (X–Z)" },
  { id: "top", label: "Top (X–Y)" },
  { id: "end", label: "End (Y–Z)" },
];

/**
 * A view's axes in the body frame (+X aft from the nose tip, +Z up): the
 * screen's horizontal and vertical coordinates (vertical up) and the depth
 * (nearest drawn last).
 */
export function viewAxes(view: CfdView): { u: "x" | "y" | "z"; v: "x" | "y" | "z"; depth: "x" | "y" | "z"; uLabel: string; vLabel: string } {
  switch (view) {
    case "top":
      return { u: "x", v: "y", depth: "z", uLabel: "x (m, aft)", vLabel: "y (m)" };
    case "end":
      return { u: "y", v: "z", depth: "x", uLabel: "y (m)", vLabel: "z (m, up)" };
    default:
      return { u: "x", v: "z", depth: "y", uLabel: "x (m, aft)", vLabel: "z (m, up)" };
  }
}

export interface Projected {
  /** Canvas pixels (y down). */
  px: Float64Array;
  py: Float64Array;
  /** Draw order (far to near). */
  order: Uint32Array;
}

/**
 * Projects a step's points onto a `width` x `height` canvas with `pad`
 * pixels of margin, one uniform scale for both axes (no distortion).
 * The bounds are the dataset's over every step, so scrubbing never moves
 * the frame.
 */
export function projectStep(rec: Pick<CfdRecord, "columns" | "steps">, step: CfdStep, view: CfdView, width: number, height: number, pad: number): Projected {
  const ax = viewAxes(view);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const s of rec.steps) {
    for (const x of column(rec, s, ax.u)) {
      if (x < u0) u0 = x;
      if (x > u1) u1 = x;
    }
    for (const x of column(rec, s, ax.v)) {
      if (x < v0) v0 = x;
      if (x > v1) v1 = x;
    }
  }
  const du = Math.max(u1 - u0, 1e-9);
  const dv = Math.max(v1 - v0, 1e-9);
  const k = Math.min((width - 2 * pad) / du, (height - 2 * pad) / dv);
  const ou = (width - k * du) / 2;
  const ov = (height - k * dv) / 2;
  const us = column(rec, step, ax.u);
  const vs = column(rec, step, ax.v);
  const ds = column(rec, step, ax.depth);
  const n = us.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = ou + (us[i]! - u0) * k;
    py[i] = height - (ov + (vs[i]! - v0) * k);
  }
  // Side view looks from +Y toward -Y, so larger y is nearer: draw it last.
  // Top looks down from +Z, end looks forward from aft (+X nearer).
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => ds[a]! - ds[b]!);
  return { px, py, order };
}

/** A legend number: at most 7 significant figures, grouped; an exponent outside 1e-3..1e9. */
export function formatValue(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e9 || a < 1e-3) return v.toExponential(4).replace(/\.?0+e/, "e");
  return Number(v.toPrecision(7)).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** `p (Pa)`, `alpha` (dimensionless `1` shows no unit). */
export function scalarLabel(rec: Pick<CfdRecord, "units">, name: string): string {
  const u = rec.units[name];
  return u && u !== "1" ? `${name} (${u})` : name;
}

/** `t = 0.5 s` */
export function timeLabel(t: number): string {
  return `t = ${Number(t.toPrecision(6))} s`;
}

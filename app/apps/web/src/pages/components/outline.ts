/**
 * Freeform fin outline editing (R6.4, M2.9): the planform polygon of a
 * `freeform_fin_set` as `[x, y]` metres from the root leading edge (x aft,
 * y outward; root first and last on y = 0). Pure point operations (add,
 * move, remove), the screen frame of the outline editor, the outline as
 * source literals for `model.patch`, and a local mirror of the RW-E061
 * outline rules (fewer than 3 points, off the root, crossing itself, no
 * area) so a broken outline is never committed. The model's own RW-E061
 * diagnostics (draft preview) stay the authority the editor shows.
 */
import type { Units } from "../../state/index.ts";
import { toDisplay, toSource } from "./fields.ts";

export type Pt = readonly [number, number];

/** Points within this height of y = 0 are on the root (matches the model's tolerance). */
const ROOT_TOL = 1e-9;

/** Insert a point on edge `edge` (from point `edge` to the next), at `at` or the edge midpoint. */
export function insertPoint(points: readonly Pt[], edge: number, at?: Pt): Pt[] {
  const n = points.length;
  if (n === 0) return [];
  const a = points[((edge % n) + n) % n]!;
  const b = points[(edge + 1) % n]!;
  const p: Pt = at ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const out = [...points];
  out.splice(edge + 1, 0, p);
  return out;
}

/**
 * Move point `i` to `to`. The first and last points stay on the root (y = 0);
 * no point goes below it.
 */
export function movePoint(points: readonly Pt[], i: number, to: Pt): Pt[] {
  if (i < 0 || i >= points.length) return [...points];
  const root = i === 0 || i === points.length - 1;
  const out = [...points];
  out[i] = [to[0], root ? 0 : Math.max(0, to[1])];
  return out;
}

/** Whether point `i` can be removed: never a root end, never below 3 points. */
export function canRemove(points: readonly Pt[], i: number): boolean {
  return points.length > 3 && i > 0 && i < points.length - 1;
}

export function removePoint(points: readonly Pt[], i: number): Pt[] {
  if (!canRemove(points, i)) return [...points];
  return points.filter((_, k) => k !== i);
}

/** Points as the source writes them: `[["0 mm", "0 mm"], …]` in display units. */
export function outlineSource(points: readonly Pt[], units: Units): [string, string][] {
  return points.map(([x, y]) => [lit(x, units), lit(y, units)]);
}

function lit(si: number, units: Units): string {
  const d = Number(toDisplay(si, "length", units));
  return String(toSource(Number.isFinite(d) ? d : 0, "length", units));
}

const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= ROOT_TOL && Math.abs(a[1] - b[1]) <= ROOT_TOL;

/** Drops consecutive duplicates and a closing point equal to the first; keeps each point's index. */
function dedup(points: readonly Pt[]): { poly: Pt[]; orig: number[] } {
  const poly: Pt[] = [];
  const orig: number[] = [];
  points.forEach((p, i) => {
    if (poly.length > 0 && same(poly[poly.length - 1]!, p)) return;
    poly.push(p);
    orig.push(i);
  });
  while (poly.length > 1 && same(poly[0]!, poly[poly.length - 1]!)) {
    poly.pop();
    orig.pop();
  }
  return { poly, orig };
}

const orient = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSeg = (a: Pt, b: Pt, c: Pt) => c[0] >= Math.min(a[0], b[0]) && c[0] <= Math.max(a[0], b[0]) && c[1] >= Math.min(a[1], b[1]) && c[1] <= Math.max(a[1], b[1]);

/** Closed-segment intersection (touching and collinear overlap count). */
export function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const s = (v: number) => (Math.abs(v) <= 1e-18 ? 0 : Math.sign(v));
  const d1 = s(orient(c, d, a));
  const d2 = s(orient(c, d, b));
  const d3 = s(orient(a, b, c));
  const d4 = s(orient(a, b, d));
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (d1 === 0 && onSeg(c, d, a)) || (d2 === 0 && onSeg(c, d, b)) || (d3 === 0 && onSeg(a, b, c)) || (d4 === 0 && onSeg(a, b, d));
}

/** First pair of crossing edges (edge k runs from point k to the next), or null. */
export function firstCrossing(poly: readonly Pt[]): [number, number] | null {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Neighbouring edges share a vertex; they cross only when they fold back over each other.
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      const [a, b] = [poly[i]!, poly[(i + 1) % n]!];
      const [c, d] = [poly[j]!, poly[(j + 1) % n]!];
      if (adjacent) {
        const shared = j === i + 1 ? b : a;
        const p = j === i + 1 ? a : b;
        const q = j === i + 1 ? d : c;
        // Collinear and pointing back along the shared edge: a spike.
        if (Math.abs(orient(p, shared, q)) <= 1e-18 && (q[0] - shared[0]) * (p[0] - shared[0]) + (q[1] - shared[1]) * (p[1] - shared[1]) > 0) return [i, j];
        continue;
      }
      if (segmentsIntersect(a, b, c, d)) return [i, j];
    }
  }
  return null;
}

/** Signed shoelace area (positive counter-clockwise). */
export function polygonArea(poly: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export interface OutlineProblem {
  message: string;
  /** Points or edges to highlight (edge k runs from point k to the next). */
  points: number[];
  edges: number[];
}

/** The first RW-E061 outline rule `points` breaks (local mirror of the model check), or null. */
export function outlineProblem(points: readonly Pt[]): OutlineProblem | null {
  if (points.length < 3) return { message: "The outline needs at least 3 points.", points: [], edges: [] };
  const below = points.findIndex((p) => p[1] < -ROOT_TOL);
  if (below >= 0) return { message: `Point ${below + 1} is below the root (y < 0).`, points: [below], edges: [] };
  const { poly, orig } = dedup(points);
  if (poly.length < 3) return { message: "The outline has fewer than 3 distinct points.", points: [], edges: [] };
  const last = points.length - 1;
  if (Math.abs(points[0]![1]) > ROOT_TOL) return { message: "The outline must start on the root (y = 0).", points: [0], edges: [] };
  if (Math.abs(points[last]![1]) > ROOT_TOL) return { message: "The outline must end on the root (y = 0).", points: [last], edges: [] };
  const x = firstCrossing(poly);
  if (x !== null) {
    const [i, j] = x;
    return { message: `The outline crosses itself: edges ${orig[i]! + 1} and ${orig[j]! + 1} intersect.`, points: [], edges: [orig[i]!, orig[j]!] };
  }
  const scale = Math.max(...poly.map((p) => p[0]), ...poly.map((p) => p[1])) - Math.min(...poly.map((p) => p[0]), 0);
  if (Math.abs(polygonArea(poly)) <= 1e-12 * scale * scale) return { message: "The outline encloses no area: move a point above the root.", points: [], edges: [] };
  return null;
}

/** Screen frame of the outline editor: `y` up, the root along the bottom, one scale on both axes. */
export interface OutlineFrame {
  width: number;
  height: number;
  /** Pixels per metre. */
  k: number;
  /** Screen x of x = 0 and screen y of y = 0 (the root). */
  ox: number;
  oy: number;
}

export const OUTLINE_PAD = { left: 28, right: 28, top: 22, bottom: 30 } as const;

/** Fits the outline (plus 15 % headroom to drag into) in `width`×`height`. */
export function outlineFrame(points: readonly Pt[], width: number, height: number): OutlineFrame {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(0, ...xs);
  const x1 = Math.max(1e-3, ...xs);
  const y1 = Math.max(1e-3, ...ys);
  const spanX = (x1 - x0) * 1.15;
  const spanY = y1 * 1.25;
  const k = Math.max(1e-6, Math.min((width - OUTLINE_PAD.left - OUTLINE_PAD.right) / spanX, (height - OUTLINE_PAD.top - OUTLINE_PAD.bottom) / spanY));
  const used = (x1 - x0) * k;
  const ox = OUTLINE_PAD.left + (width - OUTLINE_PAD.left - OUTLINE_PAD.right - used) / 2 - x0 * k;
  return { width, height, k, ox, oy: height - OUTLINE_PAD.bottom };
}

export const toPx = (f: OutlineFrame, p: Pt): [number, number] => [f.ox + p[0] * f.k, f.oy - p[1] * f.k];
export const fromPx = (f: OutlineFrame, sx: number, sy: number): Pt => [(sx - f.ox) / f.k, (f.oy - sy) / f.k];

/** Rounds a dragged point to a display step (0.5 mm; 1 mm in cm; 0.05 in). */
export function snapPoint(p: Pt, units: Units): Pt {
  const step = units === "in" ? 0.05 * 0.0254 : units === "cm" ? 0.001 : 0.0005;
  const r = (v: number) => Number((Math.round(v / step) * step).toFixed(6));
  return [r(p[0]), r(p[1])];
}

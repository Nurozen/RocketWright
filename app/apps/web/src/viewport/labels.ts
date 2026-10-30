/**
 * Leader-label layout (concept 01): each part gets a 1 px leader from its
 * edge, out perpendicular to the assembly axis to an elbow, then a short
 * horizontal run to its label. Labels alternate sides along the diagonal;
 * the elbow may slide along the axis so labels of tightly packed parts (rings,
 * bulkheads) stack in a clean column instead of piling up.
 *
 * Hard rules (a candidate breaking one is used only when every candidate
 * does, and is then flagged `collided`): labels stay inside the viewport and
 * out of the keep-outs, never overlap each other, never print over a leader,
 * and leaders never cross. Soft costs: covering the model, leaders running
 * over other parts, leader length, slide, and the off side.
 *
 * Greedy in a fixed order (fore to aft along the axis, ties by id), so the
 * result is deterministic for capture. Pure; screen pixels, y down.
 */

export interface LabelAnchor {
  id: string;
  text: string;
  /** Projected part centre. */
  x: number;
  y: number;
  /** Projected radius of the part (the leader starts at its edge). */
  r: number;
  /** Order key along the assembly axis (e.g. body station); ties by id. */
  order: number;
  /** Extra width reserved at the label's far end (e.g. the `@` button). */
  accessory?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A soft obstacle: the screen footprint of a part (`id` lets its own leader start inside it). */
export interface Obstacle extends Rect {
  id?: string;
}

export interface PlacedLabel {
  id: string;
  text: string;
  /** Leader start on the part's edge. */
  start: [number, number];
  elbow: [number, number];
  /** Leader end at the label's near edge. */
  end: [number, number];
  /** The whole label box, accessory included. */
  box: Rect;
  /** Width of the reserved accessory slot at the far end of `box` (0 when none). */
  accessory: number;
  side: 1 | -1;
  /** No candidate met every hard rule; the cheapest was used. */
  collided: boolean;
}

export interface LabelLayoutOptions {
  width: number;
  height: number;
  /** Unit screen vector perpendicular to the assembly axis, toward the first label side. */
  normal?: [number, number];
  /** Text width estimate (px per char) and box metrics. */
  charWidth?: number;
  boxHeight?: number;
  padX?: number;
  /** Horizontal run from the elbow to the box. */
  run?: number;
  /** Leader lengths tried, nearest first. */
  reaches?: readonly number[];
  /** Elbow slides along the axis tried, smallest first. */
  slides?: readonly number[];
  /** Keep-out margin around boxes and the viewport edge. */
  gap?: number;
  /** Hard keep-outs (other overlays such as the axis gizmo and the inspector). */
  avoid?: readonly Rect[];
  /** Soft keep-outs: the rendered parts (labels should not cover the model). */
  obstacles?: readonly Obstacle[];
  /**
   * `alternate` (default): labels alternate sides, each near its part.
   * `even` (concept 01): labels prefer the normal's side and are spread
   * evenly along the axis (their elbows slide toward evenly spaced slots,
   * at most `maxEvenSlide` px), so packed parts do not crowd one stretch.
   */
  spread?: "alternate" | "even";
  maxEvenSlide?: number;
}

const DEFAULT_REACHES = [22, 34, 48, 64, 84, 108, 136, 170] as const;
const DEFAULT_SLIDES = [0, 18, -18, 36, -36, 56, -56, 80, -80] as const;
const HARD = 1e6;

export function labelWidth(text: string, charWidth = 6.6, padX = 6): number {
  return Math.ceil(text.length * charWidth + 2 * padX);
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

function overlapArea(a: Rect, b: Rect, gap: number): number {
  const w = Math.min(a.x + a.w + gap, b.x + b.w + gap) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h + gap, b.y + b.h + gap) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function inside(r: Rect, width: number, height: number, gap: number): boolean {
  return r.x >= gap && r.y >= gap && r.x + r.w <= width - gap && r.y + r.h <= height - gap;
}

type Pt = readonly [number, number];
type Seg = readonly [Pt, Pt];

const orient = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Proper or touching intersection of two segments. */
export function segmentsCross(p: Seg, q: Seg): boolean {
  const d1 = orient(q[0], q[1], p[0]);
  const d2 = orient(q[0], q[1], p[1]);
  const d3 = orient(p[0], p[1], q[0]);
  const d4 = orient(p[0], p[1], q[1]);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (a: Pt, b: Pt, c: Pt) => Math.min(a[0], b[0]) - 1e-9 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-9;
  return (Math.abs(d1) < 1e-9 && on(q[0], q[1], p[0])) || (Math.abs(d2) < 1e-9 && on(q[0], q[1], p[1])) || (Math.abs(d3) < 1e-9 && on(p[0], p[1], q[0])) || (Math.abs(d4) < 1e-9 && on(p[0], p[1], q[1]));
}

/** Whether a segment touches a rectangle (grown by `gap`). */
export function segmentHitsRect(s: Seg, r: Rect, gap = 0): boolean {
  const x0 = r.x - gap, y0 = r.y - gap, x1 = r.x + r.w + gap, y1 = r.y + r.h + gap;
  const inR = (p: Pt) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  if (inR(s[0]) || inR(s[1])) return true;
  const c: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let i = 0; i < 4; i++) if (segmentsCross(s, [c[i]!, c[(i + 1) % 4]!])) return true;
  return false;
}

/** Length (px) of a segment that runs inside a rectangle, sampled. */
function lengthInside(s: Seg, r: Rect): number {
  if (Math.max(s[0][0], s[1][0]) < r.x || Math.min(s[0][0], s[1][0]) > r.x + r.w) return 0;
  if (Math.max(s[0][1], s[1][1]) < r.y || Math.min(s[0][1], s[1][1]) > r.y + r.h) return 0;
  const len = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
  const n = Math.max(2, Math.ceil(len / 4));
  let hits = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = s[0][0] + (s[1][0] - s[0][0]) * t;
    const y = s[0][1] + (s[1][1] - s[0][1]) * t;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) hits++;
  }
  return (hits / (n + 1)) * len;
}

export function leaderSegments(l: Pick<PlacedLabel, "start" | "elbow" | "end">): Seg[] {
  return [
    [l.start, l.elbow],
    [l.elbow, l.end],
  ];
}

/** Lays out one label per anchor. Anchors outside the viewport are dropped. */
export function layoutLabels(anchors: readonly LabelAnchor[], opts: LabelLayoutOptions): PlacedLabel[] {
  const { width, height } = opts;
  const charWidth = opts.charWidth ?? 6.6;
  const padX = opts.padX ?? 6;
  const boxH = opts.boxHeight ?? 18;
  const run = opts.run ?? 14;
  const gap = opts.gap ?? 4;
  const reaches = opts.reaches ?? DEFAULT_REACHES;
  const slides = opts.slides ?? DEFAULT_SLIDES;
  const obstacles = opts.obstacles ?? [];
  let normal = opts.normal ?? [0.6, -0.8];
  const nl = Math.hypot(normal[0], normal[1]) || 1;
  normal = [normal[0] / nl, normal[1] / nl];
  // Along the axis (fore to aft): the normal turned a quarter clockwise on screen.
  const along: [number, number] = [-normal[1], normal[0]];

  const visible = anchors
    .filter((a) => Number.isFinite(a.x) && Number.isFinite(a.y) && a.x >= 0 && a.x <= width && a.y >= 0 && a.y <= height)
    .slice()
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Even spread: each anchor's axial slot, evenly spaced between the first and last anchors (order kept).
  const even = opts.spread === "even";
  const maxEven = opts.maxEvenSlide ?? 90;
  const axial = visible.map((a) => a.x * along[0] + a.y * along[1]);
  const lo = axial.length > 0 ? Math.min(...axial) : 0;
  const hi = axial.length > 0 ? Math.max(...axial) : 0;
  const wanted = visible.map((_, i) => {
    if (!even || visible.length < 2) return 0;
    const slot = lo + ((hi - lo) * i) / (visible.length - 1);
    return Math.max(-maxEven, Math.min(maxEven, slot - axial[i]!));
  });

  const placed: PlacedLabel[] = [];
  const avoid = opts.avoid ?? [];
  // Small keep-outs on the parts' own centres so labels never sit on a part's middle.
  const dots: Rect[] = visible.map((a) => ({ x: a.x - 6, y: a.y - 6, w: 12, h: 12 }));

  visible.forEach((a, index) => {
    const accessory = Math.max(0, a.accessory ?? 0);
    const w = labelWidth(a.text, charWidth, padX) + accessory;
    // Alternate sides along the diagonal, starting on the normal's side (even: always the normal's side).
    const preferred: 1 | -1 = even || index % 2 === 0 ? 1 : -1;
    const want = wanted[index]!;
    let best: { label: PlacedLabel; cost: number } | null = null;
    for (const side of [preferred, -preferred as 1 | -1]) {
      const n: [number, number] = [normal[0] * side, normal[1] * side];
      const dirX = n[0] > 1e-6 ? 1 : n[0] < -1e-6 ? -1 : side;
      for (const reach of reaches) {
        for (const s0 of slides) {
          const slide = s0 + want;
          const start: [number, number] = [a.x + n[0] * a.r, a.y + n[1] * a.r];
          const elbow: [number, number] = [start[0] + n[0] * reach + along[0] * slide, start[1] + n[1] * reach + along[1] * slide];
          const end: [number, number] = [elbow[0] + dirX * run, elbow[1]];
          const box: Rect = { x: dirX > 0 ? end[0] : end[0] - w, y: end[1] - boxH / 2, w, h: boxH };
          const segs = leaderSegments({ start, elbow, end });
          let hard = 0;
          if (!inside(box, width, height, gap)) hard++;
          for (const r of avoid) if (rectsOverlap(box, r, gap)) hard++;
          for (const p of placed) {
            if (rectsOverlap(box, p.box, gap)) hard++;
            const ps = leaderSegments(p);
            for (const s of ps) if (segmentHitsRect(s, box, 2)) hard++;
            for (const s of segs) {
              if (segmentHitsRect(s, p.box, 2)) hard++;
              for (const t of ps) if (segmentsCross(s, t)) hard++;
            }
          }
          let soft = 0;
          for (const o of obstacles) {
            soft += overlapArea(box, o, 2) * 3;
            if (o.id !== a.id) for (const s of segs) soft += lengthInside(s, o) * 6;
          }
          for (let i = 0; i < dots.length; i++) if (visible[i] !== a) soft += overlapArea(box, dots[i]!, 0) * 4;
          soft += reach * 0.6 + Math.abs(slide - want) * 0.9 + (side === preferred ? 0 : 40);
          const cost = hard * HARD + soft;
          if (best === null || cost < best.cost) {
            best = { label: { id: a.id, text: a.text, start, elbow, end, box, accessory, side, collided: hard > 0 }, cost };
          }
        }
      }
    }
    if (best !== null) placed.push(best.label);
  });
  return placed;
}

/** True when no two placed boxes overlap (with `gap`). */
export function labelsDisjoint(labels: readonly PlacedLabel[], gap = 0): boolean {
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) if (rectsOverlap(labels[i]!.box, labels[j]!.box, gap)) return false;
  }
  return true;
}

/** True when no leader crosses another leader or runs through another label's box. */
export function leadersClean(labels: readonly PlacedLabel[]): boolean {
  for (let i = 0; i < labels.length; i++) {
    for (let j = 0; j < labels.length; j++) {
      if (i === j) continue;
      const si = leaderSegments(labels[i]!);
      for (const s of si) {
        if (segmentHitsRect(s, labels[j]!.box)) return false;
        if (j > i) for (const t of leaderSegments(labels[j]!)) if (segmentsCross(s, t)) return false;
      }
    }
  }
  return true;
}

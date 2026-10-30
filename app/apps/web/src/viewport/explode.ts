/**
 * Exploded-view layout (concept 01): the assembly is pulled apart along the
 * body axis into one fore-to-aft sequence, recursively: each body's nested
 * parts (bulkheads, couplers, the flight computer in its bay, the motor
 * casing and its centering rings) come out of it and take their own slot,
 * fore-half parts ahead of their host and aft-half parts behind it. The gap
 * between neighbours scales with the body diameter and the neighbours'
 * lengths, so tiny rings still separate visibly and long tubes get room.
 *
 * Followers keep their host's offset: fins (a fin can reads as one part with
 * its fins) and the contents of a see-through host (the stowed parachute
 * stays visible inside the clear recovery bay). Rail fittings (launch lug,
 * rail buttons) pop out radially from the body they sit on.
 *
 * Pure (body frame, metres, +X aft). The explode factor `f` in [0, 1] maps to
 * offsets continuously: parts slide out of their hosts over the first
 * `SLIDE_END` of the slider, while the gaps keep growing linearly with `f`.
 */

export interface ExplodeItem {
  id: string;
  /** rw-geom component kind (`rw_type`). */
  kind: string;
  /** Host component (tree parent), or null for the airframe stack. */
  parent: string | null;
  /** Assembled body-frame bounds along +X. */
  lo: number;
  hi: number;
  /** Body-frame (y, z) of the part's centre (radial placement; zero on the axis). */
  centreYZ: readonly [number, number];
  /** Body diameter of the part (max of its y/z extent). */
  diameter: number;
  /** See-through look (its contents stay inside). */
  clear: boolean;
}

export type Vec3 = [number, number, number];

export interface ExplodePlan {
  /** Sequenced parts, fore to aft. */
  order: string[];
  /** Follower -> the sequenced part whose axial offset it shares. */
  follows: Map<string, string>;
  /** Rail fittings: unit radial (y, z) direction they pop out along. */
  radial: Map<string, [number, number]>;
  /** Reference body diameter (the widest stack part). */
  diameter: number;
  /** id -> item (bounds for the layout). */
  items: Map<string, ExplodeItem>;
  /** Gap rule (`fullGap`). */
  spacing: ExplodeSpacing;
  /** Assembled extent of the sequenced stack along +X (m): the screen rule's u. */
  span: readonly [number, number];
}

/** Axial airframe kinds (top-level stack). */
const STACK_KINDS = new Set(["nose_cone", "body_tube", "transition"]);
/** Surface kinds that stay on their host. */
const FIN_KINDS = new Set(["trapezoidal_fin_set", "elliptical_fin_set", "freeform_fin_set", "tube_fin_set"]);
/** Surface kinds that pop out radially. */
const RAIL_KINDS = new Set(["launch_lug", "rail_button"]);

/** Fraction of the slider over which nested parts slide out of their hosts. */
export const SLIDE_END = 0.3;
/** Gap at f = 1: GAP_DIAMETER body diameters plus GAP_LENGTH of the neighbours' mean length. */
export const GAP_DIAMETER = 1.25;
export const GAP_LENGTH = 0.18;

/** Gap rule at f = 1: `diameter` body diameters plus `length` of the neighbours' mean length. */
export interface ExplodeSpacing {
  diameter: number;
  length: number;
  /**
   * Parts nested in an inner part ride with it (the flight computer stays in
   * its electronics bay, read through the bay's open ends) instead of taking
   * their own slot.
   */
  nestedRide?: boolean;
  /** Inner kinds that stay in their host tube (a bulkhead reads at the tube's open end). */
  stayKinds?: readonly string[];
  /** Screen-clearance floor for the Iso view (`ScreenGapRule`); absent: the gap rule alone. */
  screen?: ScreenGapRule;
}

/**
 * Gap floor that keeps neighbours apart on screen in a three-quarter view at
 * explode factor `at`. Seen at angle theta off the axis, an end of radius r
 * spans r cot(theta) along the projected axis, so two facing ends need an
 * axial gap of (ra + rb) cot(theta) before any background shows between them;
 * `clear` body diameters more leave room for the dotted shared axis. The Iso
 * camera sits aft of the stack, so the fore end is seen more nearly along the
 * axis (larger cot) and needs more room than the aft end: cot and clear vary
 * linearly with the gap's assembled position u along the stack (0 nose, 1 aft).
 */
export interface ScreenGapRule {
  /** cot(theta) at mid-stack (u = 0.5). */
  cot: number;
  /** d cot / d u (negative: the fore end needs more). */
  slope: number;
  /** Clear background between the ends (body diameters) at mid-stack. */
  clear: number;
  /** d clear / d u (body diameters; negative: fore gaps are farther, so smaller on screen). */
  clearSlope: number;
  /** Explode factor the floor is designed for (the concept's 0.6). */
  at: number;
}

export const DEFAULT_SPACING: ExplodeSpacing = { diameter: GAP_DIAMETER, length: GAP_LENGTH };

/**
 * The meshed assembly's exploded view (page 01, concept 01, BC5): the stack
 * reads as chunky parts a little apart instead of a long thin line, and every
 * neighbour pair stays clear on screen in Iso at the concept's 0.6 (the
 * screen floor; the Iso view sits about 51 deg off the axis at mid-stack,
 * nearer 45 deg at the far nose end), so the dotted shared axis shows in
 * every gap. Measured on the live viewport (`app/e2e/page01.spec.ts`).
 */
export const ASSEMBLY_SPACING: ExplodeSpacing = {
  diameter: 0.6,
  length: 0,
  nestedRide: true,
  stayKinds: ["bulkhead"],
  screen: { cot: 0.8, slope: -0.62, clear: 0.2, clearSlope: -0.12, at: 0.6 },
};
/** Rail fittings stand off this many body diameters at f = 1. */
export const RAIL_STANDOFF = 1.5;

const mid = (it: ExplodeItem) => (it.lo + it.hi) / 2;
const byId = (a: ExplodeItem, b: ExplodeItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function planExplode(input: readonly ExplodeItem[], spacing: ExplodeSpacing = DEFAULT_SPACING): ExplodePlan {
  const items = new Map(input.map((it) => [it.id, it] as const));
  const hostOf = (it: ExplodeItem): string | null => {
    if (STACK_KINDS.has(it.kind)) return null;
    const p = it.parent;
    return p !== null && p !== it.id && items.has(p) ? p : null;
  };
  const kids = new Map<string | null, ExplodeItem[]>();
  for (const it of input) {
    const h = hostOf(it);
    kids.set(h, [...(kids.get(h) ?? []), it]);
  }
  const follows = new Map<string, string>();
  const radial = new Map<string, [number, number]>();
  const order: string[] = [];
  const seen = new Set<string>();

  // Followers ride on the nearest sequenced ancestor.
  const follow = (it: ExplodeItem, anchor: string) => {
    if (seen.has(it.id)) return;
    seen.add(it.id);
    follows.set(it.id, anchor);
    if (RAIL_KINDS.has(it.kind)) {
      const [y, z] = it.centreYZ;
      const l = Math.hypot(y, z);
      radial.set(it.id, l > 1e-6 ? [y / l, z / l] : [0, 1]);
    }
    for (const k of kids.get(it.id) ?? []) follow(k, anchor);
  };

  const visit = (host: ExplodeItem) => {
    if (seen.has(host.id)) return;
    seen.add(host.id);
    const fore: ExplodeItem[] = [];
    const aft: ExplodeItem[] = [];
    for (const k of kids.get(host.id) ?? []) {
      const nested = (spacing.nestedRide === true && !STACK_KINDS.has(host.kind) && !STACK_KINDS.has(k.kind)) || (spacing.stayKinds?.includes(k.kind) ?? false);
      if (FIN_KINDS.has(k.kind) || RAIL_KINDS.has(k.kind) || (host.clear && !STACK_KINDS.has(k.kind)) || nested) {
        follow(k, host.id);
        continue;
      }
      (mid(k) < mid(host) - 1e-9 ? fore : aft).push(k);
    }
    fore.sort((a, b) => a.lo - b.lo || byId(a, b));
    // Aft contents leave in the order their aft ends reach the opening.
    aft.sort((a, b) => a.hi - b.hi || a.lo - b.lo || byId(a, b));
    for (const k of fore) visit(k);
    order.push(host.id);
    for (const k of aft) visit(k);
  };

  const roots = [...(kids.get(null) ?? [])].sort((a, b) => a.lo - b.lo || byId(a, b));
  for (const r of roots) visit(r);
  // Defensive: parent cycles leave parts unvisited; sequence them at the end.
  for (const it of [...input].sort((a, b) => a.lo - b.lo || byId(a, b))) if (!seen.has(it.id)) visit(it);

  let diameter = 0;
  for (const it of input) if (STACK_KINDS.has(it.kind)) diameter = Math.max(diameter, it.diameter);
  if (diameter <= 0) diameter = Math.max(1e-3, ...input.map((it) => it.diameter));
  let lo = Infinity, hi = -Infinity;
  for (const id of order) {
    const it = items.get(id)!;
    lo = Math.min(lo, it.lo);
    hi = Math.max(hi, it.hi);
  }
  return { order, follows, radial, diameter, items, spacing, span: Number.isFinite(lo) ? [lo, hi] : [0, 0] };
}

/** Gap between two sequenced neighbours at f = 1. */
export function fullGap(plan: ExplodePlan, a: ExplodeItem, b: ExplodeItem): number {
  const meanLen = ((a.hi - a.lo) + (b.hi - b.lo)) / 2;
  const base = plan.spacing.diameter * plan.diameter + plan.spacing.length * meanLen;
  const sc = plan.spacing.screen;
  if (!sc) return base;
  const [lo, hi] = plan.span;
  const u = hi > lo ? Math.min(1, Math.max(0, ((a.hi + b.lo) / 2 - lo) / (hi - lo))) : 0.5;
  const cot = Math.max(0, sc.cot + sc.slope * (u - 0.5));
  const clear = Math.max(0, sc.clear + sc.clearSlope * (u - 0.5));
  const floor = ((a.diameter + b.diameter) / 2) * cot + clear * plan.diameter;
  return Math.max(base, floor / Math.max(1e-3, sc.at));
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Body-frame offsets of every part at explode factor `f` (0 assembled, 1 fully exploded). */
export function explodeOffsets(plan: ExplodePlan, f: number): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  const t = Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
  if (t === 0 || plan.order.length === 0) {
    for (const id of plan.items.keys()) out.set(id, [0, 0, 0]);
    return out;
  }
  const slide = smooth(t / SLIDE_END);
  // Sequence the parts end to end with gaps growing linearly in f.
  const shift = new Map<string, number>();
  let cursor: number | null = null;
  let prev: ExplodeItem | null = null;
  let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
  for (const id of plan.order) {
    const it = plan.items.get(id)!;
    const start: number = cursor === null ? it.lo : cursor + (prev ? t * fullGap(plan, prev, it) : 0);
    shift.set(id, start - it.lo);
    cursor = start + (it.hi - it.lo);
    prev = it;
    lo0 = Math.min(lo0, it.lo);
    hi0 = Math.max(hi0, it.hi);
    lo1 = Math.min(lo1, start);
    hi1 = Math.max(hi1, cursor);
  }
  // Keep the assembly's midpoint where it was.
  const centre = (lo1 + hi1) / 2 - (lo0 + hi0) / 2;
  for (const [id, s] of shift) shift.set(id, s - centre);
  for (const id of plan.items.keys()) {
    const anchor = shift.has(id) ? id : plan.follows.get(id) ?? null;
    const dx = anchor === null ? 0 : (shift.get(anchor) ?? 0) * slide;
    const r = plan.radial.get(id);
    const out3: Vec3 = r ? [dx, r[0] * RAIL_STANDOFF * plan.diameter * t * slide, r[1] * RAIL_STANDOFF * plan.diameter * t * slide] : [dx, 0, 0];
    out.set(id, out3.map((v) => (v === 0 ? 0 : v)) as Vec3);
  }
  return out;
}

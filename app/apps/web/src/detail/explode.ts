/**
 * Exploded-spacing rules (RL5; `viewport/explodeLayout.ts` in M3.0). Pure.
 *
 * - Items: axial components, plus inner components of opaque carriers (they
 *   come out of the tube to be seen).
 * - Riders move with their carrier and are not spaced: surface parts (fins,
 *   lugs), the contents of a clear carrier (glass-in-glass: the chute stays
 *   visible inside the bay), and parts nested in an inner part (the flight
 *   computer stays in its avionics bay).
 * - Order: axial items fore to aft; an inner item leaves its carrier through
 *   the nearer open end (just before or just after it), ordered by centre.
 * - Spacing: consecutive items get the same clear gap; nothing overlaps; the
 *   layout keeps the assembled centre so the explode slider grows in place.
 */
import type { EvalComponent } from "./types.ts";

export interface ExplodeInput {
  components: readonly EvalComponent[];
  /** Measured axial extent per component (body x, metres), e.g. from mesh bounds incl. detail; defaults to x_fore..x_aft. */
  extent?: (id: string) => readonly [number, number] | null;
  /** Clear (see-through) components keep their contents. */
  isClear: (id: string) => boolean;
  /** Clear gap between consecutive items (m). */
  gap: number;
}

export interface ExplodeLayout {
  /** Axial displacement per component at explode 1 (riders share their carrier's). */
  offset: Map<string, number>;
  /** Spaced items fore to aft. */
  order: string[];
  /** Rider -> the item it moves with. */
  carrier: Map<string, string>;
  /** Exploded extent of each item, riders included. */
  span: Map<string, readonly [number, number]>;
}

/** The item a component moves with: itself, or (transitively) its carrier. */
export function riderCarrier(c: EvalComponent, byId: ReadonlyMap<string, EvalComponent>, isClear: (id: string) => boolean): string | null {
  const parent = c.parent ? byId.get(c.parent) : undefined;
  if (!parent) return null;
  if (c.containment === "surface") return parent.id;
  if (c.containment === "inner" && (isClear(parent.id) || parent.containment === "inner")) return parent.id;
  return null;
}

export function explodeLayout(input: ExplodeInput): ExplodeLayout {
  const byId = new Map(input.components.map((c) => [c.id, c]));
  const ext = (c: EvalComponent): [number, number] => {
    const e = input.extent?.(c.id);
    return e ? [Math.min(e[0], e[1]), Math.max(e[0], e[1])] : [c.x_fore, c.x_aft];
  };
  const carrier = new Map<string, string>();
  const itemOf = (id: string): string => {
    let cur = id;
    for (let guard = 0; guard < 64; guard++) {
      const c = byId.get(cur);
      const up = c ? riderCarrier(c, byId, input.isClear) : null;
      if (up === null) return cur;
      cur = up;
    }
    return cur;
  };
  const items: EvalComponent[] = [];
  for (const c of input.components) {
    const it = itemOf(c.id);
    if (it === c.id) items.push(c);
    else carrier.set(c.id, it);
  }
  // Item extents include their riders.
  const span0 = new Map<string, [number, number]>();
  for (const c of items) span0.set(c.id, ext(c));
  for (const [rid, it] of carrier) {
    const r = byId.get(rid);
    const s = span0.get(it);
    if (!r || !s) continue;
    const e = ext(r);
    s[0] = Math.min(s[0], e[0]);
    s[1] = Math.max(s[1], e[1]);
  }
  const centre = (id: string) => {
    const s = span0.get(id)!;
    return (s[0] + s[1]) / 2;
  };
  const axial = items.filter((c) => c.containment === "axial" || !c.parent || !byId.has(c.parent)).sort((a, b) => a.x_fore - b.x_fore || cmp(a.id, b.id));
  const axialIds = new Set(axial.map((c) => c.id));
  // Inner items attach to their nearest axial ancestor.
  const axialOf = (c: EvalComponent): string | null => {
    let p = c.parent ? byId.get(c.parent) : undefined;
    for (let guard = 0; p && guard < 64; guard++) {
      if (axialIds.has(p.id)) return p.id;
      p = p.parent ? byId.get(p.parent) : undefined;
    }
    return null;
  };
  const before = new Map<string, EvalComponent[]>();
  const after = new Map<string, EvalComponent[]>();
  const loose: EvalComponent[] = [];
  for (const c of items) {
    if (axialIds.has(c.id)) continue;
    const a = axialOf(c);
    if (a === null) {
      loose.push(c);
      continue;
    }
    const side = centre(c.id) < centre(a) ? before : after;
    side.set(a, [...(side.get(a) ?? []), c]);
  }
  const byCentre = (a: EvalComponent, b: EvalComponent) => centre(a.id) - centre(b.id) || cmp(a.id, b.id);
  const order: string[] = [];
  for (const a of axial) {
    for (const c of (before.get(a.id) ?? []).sort(byCentre)) order.push(c.id);
    order.push(a.id);
    for (const c of (after.get(a.id) ?? []).sort(byCentre)) order.push(c.id);
  }
  for (const c of loose.sort(byCentre)) order.push(c.id);

  // Pack with equal gaps, then re-centre on the assembled centre.
  const offset = new Map<string, number>();
  let cursor = Number.NaN;
  let lo = Infinity;
  let hi = -Infinity;
  for (const id of order) {
    const s = span0.get(id)!;
    lo = Math.min(lo, s[0]);
    hi = Math.max(hi, s[1]);
    const fore = Number.isNaN(cursor) ? s[0] : cursor + input.gap;
    offset.set(id, fore - s[0]);
    cursor = fore + (s[1] - s[0]);
  }
  if (order.length > 0) {
    const first = span0.get(order[0]!)!;
    const newLo = first[0] + offset.get(order[0]!)!;
    const shift = (lo + hi) / 2 - (newLo + cursor) / 2;
    for (const id of order) offset.set(id, offset.get(id)! + shift);
  }
  for (const [rid, it] of carrier) offset.set(rid, offset.get(it) ?? 0);
  const span = new Map<string, readonly [number, number]>();
  for (const id of order) {
    const s = span0.get(id)!;
    const o = offset.get(id)!;
    span.set(id, [s[0] + o, s[1] + o]);
  }
  return { offset, order, carrier, span };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
